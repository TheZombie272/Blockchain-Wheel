import { ethers, upgrades } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Script de despliegue completo para el sistema RouletteCasino.
 *
 * Orden:
 *   1. Config       — parámetros globales (token, fee)
 *   2. Treasury      — vault de comisiones
 *   3. RandomnessProvider — wrapper de Chainlink VRF
 *   4. RouletteEngine — lógica del juego (proxy UUPS)
 *   5. Post-deploy   — vincular contratos y crear niveles de apuesta
 *
 * Ejecutar:
 *   npx hardhat run scripts/deploy.ts --network <network>
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // ==================== CONFIGURACIÓN ====================
  // Estos valores deben ajustarse por red.
  const USDT_ADDRESS = process.env.USDT_ADDRESS || "0x0000000000000000000000000000000000000001";
  const FEE_PERCENTAGE = 500; // 5 % (en basis points)

  const VRF_COORDINATOR = process.env.VRF_COORDINATOR || ethers.ZeroAddress;
  const VRF_KEY_HASH = process.env.VRF_KEY_HASH || ethers.ZeroHash;
  const VRF_SUBSCRIPTION_ID = process.env.VRF_SUBSCRIPTION_ID
    ? Number(process.env.VRF_SUBSCRIPTION_ID)
    : 0;
  const VRF_CALLBACK_GAS_LIMIT = 200_000;
  const VRF_CONFIRMATIONS = 3;

  // ==================== 1. CONFIG ====================
  console.log("\n--- Deploying Config ---");
  const Config = await ethers.getContractFactory("Config");
  const config = await Config.deploy(deployer.address, USDT_ADDRESS, FEE_PERCENTAGE);
  await config.waitForDeployment();
  console.log("Config deployed to:", await config.getAddress());

  // ==================== 2. TREASURY ====================
  console.log("\n--- Deploying Treasury ---");
  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(deployer.address);
  await treasury.waitForDeployment();
  console.log("Treasury deployed to:", await treasury.getAddress());

  // ==================== 3. RANDOMNESS PROVIDER ====================
  console.log("\n--- Deploying RandomnessProvider ---");
  const RandomnessProvider = await ethers.getContractFactory("RandomnessProvider");
  const randomnessProvider = await RandomnessProvider.deploy(
    deployer.address,
    VRF_COORDINATOR,
    VRF_KEY_HASH,
    VRF_SUBSCRIPTION_ID,
    VRF_CALLBACK_GAS_LIMIT,
    VRF_CONFIRMATIONS
  );
  await randomnessProvider.waitForDeployment();
  console.log("RandomnessProvider deployed to:", await randomnessProvider.getAddress());

  // ==================== 4. ROULETTE ENGINE (UUPS PROXY) ====================
  console.log("\n--- Deploying RouletteEngine (UUPS proxy) ---");
  const RouletteEngine = await ethers.getContractFactory("RouletteEngine");
  const engine = await upgrades.deployProxy(
    RouletteEngine,
    [
      deployer.address,          // admin
      await config.getAddress(),  // config
      await randomnessProvider.getAddress(), // randomnessProvider
      await treasury.getAddress(), // treasury
    ],
    { initializer: "initialize", kind: "uups" }
  );
  await engine.waitForDeployment();
  const engineAddress = await engine.getAddress();
  console.log("RouletteEngine proxy deployed to:", engineAddress);
  console.log("RouletteEngine implementation at:", await upgrades.erc1967.getImplementationAddress(engineAddress));

  // ==================== 5. POST-DEPLOY ====================
  console.log("\n--- Post-deploy setup ---");

  // Conectar RandomnessProvider con RouletteEngine
  const setConsumerTx = await randomnessProvider.setConsumer(engineAddress);
  await setConsumerTx.wait();
  console.log("RandomnessProvider consumer set to RouletteEngine");

  // Crear niveles de apuesta de ejemplo
  const engineContract = await ethers.getContractAt("RouletteEngine", engineAddress);
  const levels = [
    { level: 1, amount: ethers.parseUnits("1", 18), players: 10 },
    { level: 5, amount: ethers.parseUnits("5", 18), players: 10 },
    { level: 10, amount: ethers.parseUnits("10", 18), players: 5 },
  ];

  for (const l of levels) {
    const tx = await engineContract.createBetLevel(l.level, l.amount, l.players);
    await tx.wait();
    console.log(`Bet level ${l.level} created: ${ethers.formatUnits(l.amount, 18)} token(s), ${l.players} max players`);
  }

  // ==================== RESUMEN ====================
  console.log("\n========================================");
  console.log("Deployment complete!");
  console.log("Config:", await config.getAddress());
  console.log("Treasury:", await treasury.getAddress());
  console.log("RandomnessProvider:", await randomnessProvider.getAddress());
  console.log("RouletteEngine (proxy):", engineAddress);
  console.log("========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
