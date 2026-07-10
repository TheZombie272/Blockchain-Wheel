# Interaction Guide

Use `cast` (Foundry) to interact with deployed contracts.

## Query State

```bash
# RouletteEngine info
cast call <ENGINE> "currentId()" --rpc-url <RPC>
cast call <ENGINE> "rounds(uint256)" 1 --rpc-url <RPC>
cast call <ENGINE> "roundResults(uint256)" 1 --rpc-url <RPC>

# Config parameters
cast call <CONFIG> "minBetPerNumber()" --rpc-url <RPC>
cast call <CONFIG> "maxBetPerNumber()" --rpc-url <RPC>
cast call <CONFIG> "feePercent()" --rpc-url <RPC>
cast call <CONFIG> "roundTimeout()" --rpc-url <RPC>

# Player info
cast call <TREASURY> "balanceOf(address)" <PLAYER> --rpc-url <RPC>
cast call <ENGINE> "roundResults(uint256)" <ROUND_ID> --rpc-url <RPC>
```

## Place a Bet

```bash
cast send <ENGINE> "placeBet(uint64,uint64,uint64,bool)" \
    <NUMBER> <PAIR> <SUBMITTED_NUMBER> <SUBMITTED_PAIR> \
    --value <BET_AMOUNT> \
    --private-key <KEY> \
    --rpc-url <RPC>
```

Examples:
```bash
# Bet 0.1 ETH on number 17 (no pair)
cast send <ENGINE> "placeBet(uint64,uint64,uint64,bool)" \
    17 38 17 false \
    --value 0.1ether \
    --private-key $PK \
    --rpc-url $RPC

# Bet 0.05 ETH on pair 5 (numbers 0-5)
cast send <ENGINE> "placeBet(uint64,uint64,uint64,bool)" \
    5 5 5 true \
    --value 0.05ether \
    --private-key $PK \
    --rpc-url $RPC

# Bet 0.01 ETH on number 0
cast send <ENGINE> "placeBet(uint64,uint64,uint64,bool)" \
    0 38 0 false \
    --value 0.01ether \
    --private-key $PK \
    --rpc-url $RPC
```

## Claim Winnings

```bash
# Single claim
cast send <ENGINE> "claim(uint256)" <ROUND_ID> \
    --private-key <KEY> \
    --rpc-url <RPC>

# Batch claim
cast send <ENGINE> "claimMultiple(uint256[])" "[1,2,3]" \
    --private-key <KEY> \
    --rpc-url <RPC>
```

## Cancel Expired Round

```bash
cast send <ENGINE> "cancelRound(uint256)" <ROUND_ID> \
    --private-key <KEY> \
    --rpc-url <RPC>
```

## Manager Operations

```bash
# Pause
cast send <ENGINE> "pause()" --private-key <MANAGER_KEY> --rpc-url <RPC>

# Unpause
cast send <ENGINE> "unpause()" --private-key <MANAGER_KEY> --rpc-url <RPC>

# Update Config
cast send <CONFIG> "setMinBetPerNumber(uint256)" 0.01ether \
    --private-key <MANAGER_KEY> --rpc-url <RPC>

# Set fee collector
cast send <ENGINE> "setFeeCollector(address)" 0x... \
    --private-key <ADMIN_KEY> --rpc-url <RPC>
```

## Upkeep (Automation)

```bash
# Check if upkeep needed
cast call <ENGINE> "checkUpkeep(bytes)" 0x00 --rpc-url <RPC>

# Perform upkeep (force-cancel expired rounds)
cast send <ENGINE> "performUpkeep(bytes)" <ENCODED_DATA> \
    --private-key <KEEPER_KEY> --rpc-url <RPC>
```

## Local Dev: Fulfill Randomness (Mock)

```bash
# Advance mock VRF (process next pending request)
cast send <MOCK_VRF> "fulfillNextRequest()" \
    --private-key <KEY> --rpc-url http://localhost:8545
```
