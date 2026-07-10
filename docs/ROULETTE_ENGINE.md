# RouletteEngine

**File:** `src/RouletteEngine.sol`

Core game contract. Manages rounds, bets, VRF requests, payouts.

## Inheritance

```solidity
contract RouletteEngine is
    ERC20Permit,          // Solady ERC20 — used only for share-like accounting
    Pausable,             // OpenZeppelin — emergency stop
    ReentrancyGuard,      // OpenZeppelin — prevent reentrancy
    AccessControlDefaultAdminRules,
    VRFConsumerBaseV2Plus  // Chainlink — receive VRF callbacks
```

## State

### Constants (immutable, set at construction)
| Field | Type | Description |
|-------|------|-------------|
| `MAX_NUMBER` | `uint64` | Always `36` (0–36 inclusive, 37 pockets) |
| `PAIR_LIMIT` | `uint64` | Maximum number in a pair-based submission |
| `config` | `Config` | Config contract reference |
| `treasury` | `Treasury` | Treasury contract reference |
| `vrfCoordinator` | `address` | Chainlink VRF coordinator |
| `keyHash` | `bytes32` | VRF gas lane key hash |
| `subId` | `uint256` | VRF subscription ID |
| `requestConfirmations` | `uint16` | VRF confirmations (default 3) |
| `callbackGasLimit` | `uint32` | Gas for VRF callback |

### Storage
| Field | Type | Description |
|-------|------|-------------|
| `rounds` | `mapping(uint256 => Round)` | All rounds by ID |
| `roundResults` | `mapping(uint256 => Results)` | Payout results per round |
| `currentId` | `uint256` | Auto-incrementing round counter |
| `pendingRoundIds` | `uint256[]` | Rounds awaiting VRF fulfillment |
| `pendingIndex` | `mapping(uint256 => uint256)` | Index in pendingRoundIds (for swap-remove) |
| `feeCollector` | `address` | Receiver of platform fees |

### Round Struct
```solidity
struct Round {
    uint40  deadline;
    uint40  canceledAt;
    uint32  requestId;
    uint64  winningNumber;
    uint256 amount;
    address player;
    bytes   bets;        // ABI-encoded Bet[]
}
```

### Bet Struct
```solidity
struct Bet {
    uint64 number;           // 0–36, or 37 for pair splits
    uint64 pair;             // 38 = no pair (singleton)
    uint64 submittedNumber;  // the original number the user picked
    bool   submittedPair;    // was submitted as pair
}
```

### Results Struct
```solidity
struct Results {
    uint256 totalWager;
    uint256 totalPayout;
    uint256 totalFees;
    uint256 netPayout;  // totalPayout - totalFees (after fee deduction)
}
```

## User-Facing Functions

### `placeBet(uint64 number, uint64 pair, uint64 submittedNumber, bool submittedPair)`
- **Access:** Anyone (with sufficient balance)
- **Validation:** Uses Config to check min/max bet per number, pair limits
- **Effect:** Transfers bet amount to Treasury, creates round, triggers VRF request
- **Event:** `RoundCreated(roundId, player, amount, number, pair)`
- **Requirements:**
  - Contract not paused
  - Round not exist for same player+number+pair combination (unless timed out)
  - Bet within `Config.minBetPerNumber` and `Config.maxBetPerNumber`
  - If `submittedPair == true`, `number <= PAIR_LIMIT`
  - Player balance ≥ bet amount

### `cancelRound(uint256 roundId)`
- **Access:** Anyone
- **Effect:** Cancels a pending round. Refunds the bet amount to Treasury (player can then `claim()`)
- **Requirements:**
  - Round must be pending
  - Round must be past `deadline`
  - Round must not already be canceled

### `claim(uint256 roundId)`
- **Access:** Anyone (but only the round's player receives payout)
- **Effect:** Transfers winnings (or refund) from Treasury to player
- **Requirements:**
  - Round must be resolved (not pending, not canceled)
  - Must not have been claimed already

### `claimMultiple(uint256[] calldata roundIds)`
- Batch version of `claim()`
- Uses inner revert on failure: checks each claim succeeds, reverts otherwise

### `reclaimStuckTokens(address token, uint256 amount)`
- **Access:** `MANAGER_ROLE`
- **Effect:** Recovers tokens accidentally sent to the RouletteEngine contract
- **Requirements:**
  - Cannot be the Treasury token itself (handled separately)
  - Cannot be the feeCollector

## Manager Functions

### `setFeeCollector(address collector)`
- **Access:** `DEFAULT_ADMIN_ROLE`
- **Effect:** Updates the fee recipient address

### `pause()` / `unpause()`
- **Access:** `MANAGER_ROLE`
- **Effect:** Pauses/unpauses all betting (`placeBet` blocked while paused)

## Upkeep / Automation (Chainlink Keepers / Gelato)

### `checkUpkeep(bytes calldata)` → `(bool upkeepNeeded, bytes memory performData)`
- Checks if any pending round has passed `deadline`
- Returns encoded `roundIds` if upkeep is needed

### `performUpkeep(bytes calldata performData)`
- **Access:** `UPKEEP_ROLE` (or anyone via public)
- **Effect:** Cancels all expired rounds encoded in `performData`
- Refunds bets to Treasury, emits `RoundCanceled`

## VRF Consumer

### `rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords)`
- Called by VRF coordinator
- For each pending round with matching `requestId`:
  1. Generate winning number: `randomWord % 38` (0–37, where 37 = pair win)
  2. Determine payout via `_resolvePayout()`
  3. Deduct fees
  4. Mark round as resolved
  5. Emit `RoundResult(roundId, winningNumber, netPayout)`

## Internal Logic

### `_resolvePayout(uint64 number, uint64 pair, uint64 submittedNumber, bool submittedPair, uint64 winningNumber)`
Returns `(bool win, uint256 payout)`:
- **Number match:** `winningNumber == number` or `winningNumber == submittedNumber` → **35:1**
- **Pair match:** `winningNumber == pair` and `submittedPair == true` and `winningNumber < 37` → **17:1**
- **No match:** `win` = false, `payout` = 0

### Payout Multipliers
| Condition | Multiplier | Effective Payout |
|-----------|-----------|------------------|
| Single number match | 35× | `bet * 35` |
| Pair match | 17× | `bet * 17` |
| No match | 0× | 0 (lost) |
