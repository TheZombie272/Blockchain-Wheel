# Deployment Guide

## Prerequisites

- Node.js ≥ 18
- Foundry installed
- A `.env` file at the project root:

```bash
# Required:
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0x...
ETHERSCAN_API_KEY=YOUR_KEY

# VRF (for production networks):
SEPOLIA_VRF_COORDINATOR=0x9DdfaCa8183c41ad55329Bdee9d6f4E0d1B47A3b
SEPOLIA_KEY_HASH=0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae
SEPOLIA_SUB_ID=1234

# Optional (for Gnosis Safe):
SIGNER_ADDRESS=0x...
```

## Local Development

```bash
# Start Anvil
anvil

# Deploy all contracts (Config → Treasury → MockVRF → RouletteEngine)
forge script script/RouletteEngine.s.sol:RouletteEngineScript \
    --rpc-url http://localhost:8545 \
    --broadcast \
    --slow

# Run tests (6 test files)
forge test -vvv

# Gas report
forge test --gas-report
```

## Production Deployment

### Step 1: Deploy Config
`script/DeployConfig.s.sol`

### Step 2: Deploy Treasury
`script/DeployTreasury.s.sol`

### Step 3: Deploy RandomnessProvider
`script/DeployRandomnessProvider.s.sol`
- Must fund the subscription with LINK first

### Step 4: Deploy RouletteEngine
```bash
forge script script/RouletteEngine.s.sol:RouletteEngineProdScript \
    --rpc-url $SEPOLIA_RPC_URL \
    --broadcast \
    --verify \
    --slow
```

### Constructor Arguments (RouletteEngineProd)
| Param | Source |
|-------|--------|
| `config_` | Deployed Config address |
| `treasury_` | Deployed Treasury address |
| `vrfCoordinator_` | Chainlink VRF v2.5 coordinator |
| `keyHash_` | Gas lane key hash |
| `subId_` | Subscription ID |
| `requestConfirmations_` | Usually 3 |
| `callbackGasLimit_` | 300_000 |

## Post-Deployment Setup

1. **Transfer Treasury ownership** to RouletteEngine:
   ```solidity
   treasury.transferOwnership(address(rouletteEngine));
   ```

2. **Set fee collector**:
   ```solidity
   rouletteEngine.setFeeCollector(0x...);
   ```

3. **Grant roles**:
   ```solidity
   rouletteEngine.grantRole(MANAGER_ROLE, 0x...);
   config.grantRole(MANAGER_ROLE, 0x...);
   ```

4. **Verify on Etherscan**:
   - Contracts verify automatically with `--verify` flag
   - Manual: `forge verify-contract <address> <contract-path>:<contract-name> --chain sepolia`

## Deployed Addresses

| Network | Contract | Address |
|---------|----------|---------|
| Anvil (local) | RouletteEngine | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| Anvil (local) | Config | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| Anvil (local) | Treasury | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| Anvil (local) | MockRandomnessProvider | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
