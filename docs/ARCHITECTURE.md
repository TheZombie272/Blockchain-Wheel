# Architecture Overview

```
         ┌──────────────────────────┐
         │       RouletteEngine      │  ← Core game logic
         │   (ERC20Permit, Pausable)  │
         └────┬──────┬───────┬───────┘
              │      │       │
         owns │      │       │ reads
              ▼      │       ▼
    ┌────────────┐   │  ┌──────────────┐
    │  Treasury  │   │  │    Config    │
    │(ERC20 Vault)│  │  │(AccessControl)│
    └────────────┘   │  └──────────────┘
                     │         ▲
                     │         │
                     │  ┌──────────────┐
                     └──│RandomnessProv│
                        │   (VRF)     │
                        └──────────────┘
```

## Contract Relationships

### RouletteEngine
- **Owns** the `Treasury` — only the engine can call Treasury's `transferOut`
- **Reads** from `Config` — checks operational limits (min/max bet, pair limits, etc.)
- **Calls** `RandomnessProvider.requestRandomWords()` — async VRF-based randomness

### Treasury
- Holds all deposited funds (ETH)
- Exposes `deposit()` (anyone can send ETH) and `transferOut()` (only RouletteEngine)
- Built on [Solady's `ERC20`](https://github.com/Vectorized/solady) (used as a vault; the "shares" model)

### Config
- Stores all tunable parameters: bet limits, fee rates, pair limits, round timeouts
- Access-controlled (`MANAGER_ROLE`) for updates
- Read by RouletteEngine on every user-facing action

### RandomnessProvider
- Wrapper around [Chainlink VRF v2.5](https://docs.chain.link/vrf/v2-5)
- `requestRandomWords(uint256 roundId)` — only callable by RouletteEngine
- `fulfillRandomWords()` — Chainlink callback that writes randomness + forwards to RouletteEngine
- RouletteEngine must implement `rawFulfillRandomWords()` (the VRF consumer callback)

### MockRandomnessProvider
- Deterministic randomness for local/test networks (no subscription, no LINK)
- Returns `1` as the random word on every fulfillment for reproducibility

---

## Game Flow

```
       ┌─────────┐       ┌──────────────┐       ┌──────┐
       │  User   │       │ RouletteEngine│       │ VRF │
       └────┬────┘       └──────┬───────┘       └──┬───┘
            │ placeBet()        │                  │
            │ ─────────────────►│                  │
            │                   │ validate limits  │
            │                   │ check Config     │
            │                   │ deduct bet       │
            │                   │ ─────► Treasury  │
            │                   │ requestRandom()  │
            │                   │ ────────────────►│
            │                   │                  │
            │     (wait for VRF callback)          │
            │                   │                  │
            │                   │◄── fulfillRandom─│
            │                   │ resolveRound()   │
            │                   │ emit RoundResult │
            │                   │ payout winners   │
            │                   │ ─────► Treasury  │
            │  claim(uint256)   │                  │
            │ ◄─────────────────│                  │
            │     (or auto)     │                  │
```

## Role-Based Access Control

| Role | Contracts | Can |
|------|-----------|-----|
| `DEFAULT_ADMIN_ROLE` | Config, RouletteEngine | Grant/revoke roles, set fee collector |
| `MANAGER_ROLE` | Config, RouletteEngine | Update config params, pause/unpause, withdraw stuck funds |
| `UPKEEP_ROLE` | RouletteEngine | Execute `performUpkeep` for timeout resolution |

## Key Design Decisions

1. **Pausable** — RouletteEngine can be paused by managers; no new bets while paused
2. **Round-based async** — Bets placed → request VRF → wait → callback resolves all results
3. **Timeout & cancellation** — If VRF never fulfills, `performUpkeep` force-cancels a round after `roundTimeout` seconds
4. **No safeERC20** — Only native ETH is used; no IERC20 token support needed
5. **Solady over OpenZeppelin** — Gas-optimized implementations of ERC20, ECDSA, etc.
