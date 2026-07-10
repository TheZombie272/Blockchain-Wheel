import { ethers, upgrades } from "hardhat";

/**
 * Script de despliegue LOCAL — usa MockRandomnessProvider y un ERC20Mock
 * para no depender de Chainlink VRF ni de ningún externo.
 *
 * Ejecutar:
 *   1. npx hardhat node            (nuevo terminal)
 *   2. npx hardhat run scripts/deploy-local.ts --network localhost
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // ==================== 1. TOKEN (ERC20Mock) ====================
  console.log("--- Deploying Token (ERC20Mock) ---");
  const Token = await ethers.getContractFactory("ERC20Mock");
  const token = await Token.deploy("RouletteToken", "RLT", 18);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("Token deployed to:", tokenAddr);

  // ==================== 2. CONFIG ====================
  console.log("\n--- Deploying Config ---");
  const Config = await ethers.getContractFactory("Config");
  const config = await Config.deploy(deployer.address, tokenAddr, 500); // 5% fee
  await config.waitForDeployment();
  console.log("Config deployed to:", await config.getAddress());

  // ==================== 3. TREASURY ====================
  console.log("\n--- Deploying Treasury ---");
  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(deployer.address);
  await treasury.waitForDeployment();
  console.log("Treasury deployed to:", await treasury.getAddress());

  // ==================== 4. MOCK RANDOMNESS PROVIDER ====================
  console.log("\n--- Deploying MockRandomnessProvider ---");
  const MockVRF = await ethers.getContractFactory("MockRandomnessProvider");
  const mockVRF = await MockVRF.deploy();
  await mockVRF.waitForDeployment();
  console.log("MockRandomnessProvider deployed to:", await mockVRF.getAddress());

  // ==================== 5. ROULETTE ENGINE (UUPS PROXY) ====================
  console.log("\n--- Deploying RouletteEngine (UUPS proxy) ---");
  const RouletteEngine = await ethers.getContractFactory("RouletteEngine");
  const engine = await upgrades.deployProxy(
    RouletteEngine,
    [deployer.address, await config.getAddress(), await mockVRF.getAddress(), await treasury.getAddress()],
    { initializer: "initialize", kind: "uups" }
  );
  await engine.waitForDeployment();
  const engineAddr = await engine.getAddress();
  console.log("RouletteEngine proxy deployed to:", engineAddr);
  console.log("Implementation at:", await upgrades.erc1967.getImplementationAddress(engineAddr));

  // ==================== 6. POST-DEPLOY ====================
  console.log("\n--- Post-deploy setup ---");

  // Conectar Mock con RouletteEngine
  await mockVRF.setConsumer(engineAddr);
  console.log("MockRandomnessProvider consumer set to RouletteEngine");

  // Crear niveles de apuesta de ejemplo
  const engineContract = await ethers.getContractAt("RouletteEngine", engineAddr);
  const levels = [
    { level: 1, amount: ethers.parseUnits("1", 18), players: 3 },
    { level: 5, amount: ethers.parseUnits("5", 18), players: 3 },
  ];
  for (const l of levels) {
    const maxEntries = Math.floor(l.players / 2);
    const tx = await engineContract.createBetLevel(l.level, l.amount, l.players, maxEntries);
    await tx.wait();
    console.log(`Bet level ${l.level}: ${ethers.formatUnits(l.amount, 18)} token(s), ${l.players} max players, ${maxEntries} max entries per player`);
  }

  // Mintear tokens a cuentas de prueba para jugar
  const [, , testPlayer1, testPlayer2, testPlayer3] = await ethers.getSigners();
  const amount = ethers.parseEther("100");
  for (const p of [testPlayer1, testPlayer2, testPlayer3]) {
    await token.mint(p.address, amount);
    await token.connect(p).approve(engineAddr, amount);
    console.log(`Minted ${ethers.formatEther(amount)} RLT to ${p.address}`);
  }

  // ==================== RESUMEN ====================
  console.log("\n========================================");
  console.log("Local deployment complete!");
  console.log("Token:", tokenAddr);
  console.log("Config:", await config.getAddress());
  console.log("Treasury:", await treasury.getAddress());
  console.log("MockRandomnessProvider:", await mockVRF.getAddress());
  console.log("RouletteEngine (proxy):", engineAddr);
  console.log("========================================");
  console.log("\nCuentas de Hardhat (20 disponibles con ~10000 ETH cada una):");
  console.log("  Admin/deployer :", deployer.address);
  for (let i = 2; i <= 4; i++) {
    const signer = (await ethers.getSigners())[i];
    console.log(`  Player ${i - 1}       :`, signer.address);
  }
  console.log("\nPara simular VRF:");
  console.log(`  await (await ethers.getContractAt("MockRandomnessProvider", "${await mockVRF.getAddress()}"))`);
  console.log(`    .fulfill(gameId, randomNumber);`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
