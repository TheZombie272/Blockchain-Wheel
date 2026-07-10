# Supporting Contracts

## Config (`src/Config.sol`)

Central parameter store for the game. Uses OpenZeppelin's `AccessControlDefaultAdminRules`.

### Parameters

| Getter | Type | Description |
|--------|------|-------------|
| `minBetPerNumber()` | `uint256` | Minimum bet per number |
| `maxBetPerNumber()` | `uint256` | Maximum bet per number |
| `maxPair()` | `uint64` | Maximum pair value (alias for `PAIR_LIMIT` in engine) |
| `roundTimeout()` | `uint40` | Seconds before a pending round can be canceled |
| `feePercent()` | `uint256` | Platform fee in basis points (1/100 of a percent) |
| `maxFeePercent()` | `uint256` | Cap on fee (privacy-respecting constant) |

### Setters (require `MANAGER_ROLE`)

| Function | Effect |
|----------|--------|
| `setMinBetPerNumber(uint256)` | Updates minimum bet |
| `setMaxBetPerNumber(uint256)` | Updates maximum bet |
| `setMaxPair(uint64)` | Updates pair limit |
| `setRoundTimeout(uint40)` | Updates round timeout duration |
| `setFeePercent(uint256)` | Updates fee percentage |

---

## Treasury (`src/Treasury.sol`)

Holds all protocol funds. Built as an [ERC4626](https://eips.ethereum.org/EIPS/eip-4626)-like vault on top of Solady's `ERC20`.

### Key Functions
| Function | Access | Effect |
|----------|--------|--------|
| `deposit()` | Anyone | Accepts ETH, mints shares |
| `transferOut(address to, uint256 amount)` | **Only RouletteEngine** | Sends ETH from treasury |
| `withdrawStuckToken(address token, address to, uint256 amount)` | `MANAGER_ROLE` | Recovers non-ETH tokens |

### Properties
- Uses **native ETH** only (no ERC20 deposits)
- The "share" mechanism tracks proportional ownership of the vault
- Only `RouletteEngine` can send funds out (payouts, refunds)

---

## RandomnessProvider (`src/RandomnessProvider.sol`)

Chainlink VRF v2.5 wrapper. Generates verifiable on-chain randomness.

### Key Functions
| Function | Access | Effect |
|----------|--------|--------|
| `requestRandomWords(uint256 roundId)` | Only RouletteEngine | Requests VRF, maps `requestId → roundId` |
| `fulfillRandomWords(uint256 requestId, uint256[] memory randomWords)` | Only VRF coordinator | Callback: writes randomness, forwards to RouletteEngine |
| `getRequestStatus(uint256 requestId)` | Anyone | Returns `(fulfilled, randomness[])` |

### Configuration
- `vrfCoordinator`: Chainlink VRF coordinator address
- `keyHash`: Gas lane key hash
- `subId`: Billing subscription ID
- `requestConfirmations`: Block confirmations (default 3)
- `callbackGasLimit`: Gas allocated for fulfillment (default 300k)

---

## MockRandomnessProvider (`src/MockRandomnessProvider.sol`)

Deterministic randomness for local development.

### Differences from RandomnessProvider
- No VRF subscription or LINK required
- `fulfillRandomWords()` must be called manually (or by `requestRandomWords()` after a delay)
- Returns `1` as the random word always (deterministic for testing)
- Has a public `fulfillNextRequest()` to advance one pending request

---

## ERC20Mock (`src/ERC20Mock.sol`)

Simple ERC20 token for integration testing (e.g., testing `reclaimStuckTokens`).
- 18 decimals
- Owner receives `1_000_000_000` tokens on construction
- Public `mint` for test flexibility
