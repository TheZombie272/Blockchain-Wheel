/**
 * # RouletteEngine — Suite de Tests
 *
 * ## Cómo ejecutar
 *
 * ```bash
 * npx hardhat test                    # Todos los tests
 * npx hardhat test --grep "Pause"     # Solo tests que contengan "Pause"
 * npx hardhat test --grep "retryRandom|refundGame"  # Múltiples patrones
 * npx hardhat test --grep "security"  # Tests de seguridad
 * npx hardhat test --grep "UUPS"      # Tests de upgradeabilidad
 * ```
 *
 * ## Estructura general
 *
 * El fixture `deployFixture` despliega:
 *   1. `ERC20Mock` — token ERC20 simple para las apuestas
 *   2. `Config` — parámetros globales (fee 5%)
 *   3. `Treasury` — vault de comisiones
 *   4. `MockRandomnessProvider` — simula Chainlink VRF (sin dependencia externa)
 *   5. `RouletteEngine` — proxy UUPS desplegado via `@openzeppelin/hardhat-upgrades`
 *
 * Luego conecta el MockRandomnessProvider con la RouletteEngine,
 * mintea 1000 tokens a 3 jugadores, y aprueba el gasto al engine.
 *
 * ## MockRandomnessProvider
 *
 * Reemplaza a `RandomnessProvider.sol` para evitar depender de Chainlink VRF en tests.
 * El método `mockVRF.fulfill(gameId, randomValue)` simula el callback de VRF,
 * llamando directamente a `RouletteEngine.fulfillRandomness`.
 *
 * ## Convenciones
 *
 * - `admin` = DEFAULT_ADMIN_ROLE + MANAGER_ROLE (configurado en initialize)
 * - `manager` = tiene MANAGER_ROLE (otorgado en tests que lo requieren)
 * - `other` = sin ningún rol
 * - `GameState`: OPEN=0, LOCKED=1, DRAWING=2, PAYOUT=3, CLOSED=4
 */
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { RouletteEngine, Config, MockRandomnessProvider } from "../typechain-types";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("RouletteEngine (UUPS proxy)", () => {
  async function deployFixture() {
    const [admin, manager, player1, player2, player3, other] = await ethers.getSigners();

    const USDT = await ethers.getContractFactory("ERC20Mock");
    const token = await USDT.deploy("MockUSDT", "USDT", 18);
    await token.waitForDeployment();

    const Config = await ethers.getContractFactory("Config");
    const config = await Config.deploy(admin.address, await token.getAddress(), 500);
    await config.waitForDeployment();

    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(admin.address);
    await treasury.waitForDeployment();

    const MockVRF = await ethers.getContractFactory("MockRandomnessProvider");
    const mockVRF = await MockVRF.deploy();
    await mockVRF.waitForDeployment();

    const RouletteEngine = await ethers.getContractFactory("RouletteEngine");
    const engine = await upgrades.deployProxy(
      RouletteEngine,
      [admin.address, await config.getAddress(), await mockVRF.getAddress(), await treasury.getAddress()],
      { initializer: "initialize", kind: "uups" }
    ) as unknown as RouletteEngine;
    await engine.waitForDeployment();

    await mockVRF.setConsumer(await engine.getAddress());

    await token.mint(player1.address, ethers.parseEther("1000"));
    await token.mint(player2.address, ethers.parseEther("1000"));
    await token.mint(player3.address, ethers.parseEther("1000"));

    await token.connect(player1).approve(await engine.getAddress(), ethers.parseEther("1000"));
    await token.connect(player2).approve(await engine.getAddress(), ethers.parseEther("1000"));
    await token.connect(player3).approve(await engine.getAddress(), ethers.parseEther("1000"));

    return { engine, config, treasury, mockVRF, token, admin, manager, player1, player2, player3, other };
  }

  /**
   * **Deployment** — Verifica que el proxy UUPS se despliegue correctamente,
   * que el storage inicial tenga valores coherentes y que el admin tenga
   * el rol DEFAULT_ADMIN_ROLE.
   */
  describe("Deployment", () => {
    it("should deploy proxy and set storage correctly", async () => {
      const { engine, admin } = await loadFixture(deployFixture);

      expect(await engine.getConfig()).to.not.equal(ethers.ZeroAddress);
      expect(await engine.getRandomnessProvider()).to.not.equal(ethers.ZeroAddress);
      expect(await engine.getTreasury()).to.not.equal(ethers.ZeroAddress);
      expect(await engine.getNextGameId()).to.equal(1);
      expect(await engine.getActiveGames()).to.equal(0);
      expect(await engine.hasRole(await engine.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
    });

    it("should have correct UUPS implementation address", async () => {
      const { engine } = await loadFixture(deployFixture);
      const impl = await upgrades.erc1967.getImplementationAddress(await engine.getAddress());
      expect(impl).to.not.equal(ethers.ZeroAddress);
      expect(impl).to.not.equal(await engine.getAddress());
    });
  });

  /**
   * **Bet Level Management** — Prueba la creación y actualización de niveles
   * de apuesta. Verifica que un manager pueda crear niveles, que se rechacen
   * duplicados/parametros inválidos/acceso no autorizado.
   *
   * **Security fix:** `updateBetLevel` ahora requiere queueLength == 0,
   * evitando desajustes de fondos cuando hay jugadores encolados.
   */
  describe("Bet Level Management", () => {
    it("should create a bet level", async () => {
      const { engine, admin } = await loadFixture(deployFixture);

      const level = 1;
      const betAmount = ethers.parseEther("10");
      const maxPlayers = 5;

      const maxEntries = Math.floor(maxPlayers / 2);
      await expect(engine.connect(admin).createBetLevel(level, betAmount, maxPlayers, maxEntries))
        .to.emit(engine, "BetLevelCreated")
        .withArgs(level, betAmount, maxPlayers, maxEntries);

      const stored = await engine.getBetLevel(level);
      expect(stored.betAmount).to.equal(betAmount);
      expect(stored.maxPlayers).to.equal(maxPlayers);
      expect(stored.queueLength).to.equal(0);
      expect(stored.maxEntriesPerPlayer).to.equal(maxEntries);
      expect(stored.exists).to.be.true;
    });

    it("should reject creating duplicate bet level", async () => {
      const { engine, admin } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 5, 2);
      await expect(engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 5, 2))
        .to.be.revertedWith("RE: level exists");
    });

    it("should reject create with invalid params", async () => {
      const { engine, admin } = await loadFixture(deployFixture);
      await expect(engine.connect(admin).createBetLevel(1, 0, 5, 2)).to.be.revertedWith("RE: invalid bet amount");
      await expect(engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 1, 1)).to.be.revertedWith("RE: min 2 players");
      await expect(engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 101, 50)).to.be.revertedWith("RE: max 100 players");
    });

    it("should reject non-manager from creating bet level", async () => {
      const { engine, other } = await loadFixture(deployFixture);
      await expect(engine.connect(other).createBetLevel(1, ethers.parseEther("10"), 5, 2))
        .to.be.revertedWith("RE: not manager");
    });

    it("should update bet level when queue is empty", async () => {
      const { engine, admin } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 5, 2);
      await expect(engine.connect(admin).updateBetLevel(1, ethers.parseEther("20"), 10, 5))
        .to.emit(engine, "BetLevelUpdated")
        .withArgs(1, ethers.parseEther("20"), 10, 5);
      const stored = await engine.getBetLevel(1);
      expect(stored.betAmount).to.equal(ethers.parseEther("20"));
      expect(stored.maxPlayers).to.equal(10);
      expect(stored.maxEntriesPerPlayer).to.equal(5);
    });

    it("should reject update when queue is not empty (security fix)", async () => {
      const { engine, admin, player1, token } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 3, 1);
      await engine.connect(player1).joinQueue(1);
      await expect(engine.connect(admin).updateBetLevel(1, ethers.parseEther("20"), 5, 2))
        .to.be.revertedWith("RE: queue not empty");
    });
  });

  /**
   * **Pause Mechanism** — Verifica que `pause()` bloquee `joinQueue` y
   * `joinGame` (whenNotPaused), pero que las funciones de emergencia como
   * `fulfillRandomness` y `refundGame` sigan operativas.
   * Solo un manager puede pausar/reanudar.
   */
  describe("Pause Mechanism", () => {
    it("should prevent join when paused", async () => {
      const { engine, admin, player1 } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 3, 1);

      await engine.connect(admin).pause();
      await expect(engine.connect(player1).joinQueue(1)).to.be.reverted;

      await engine.connect(admin).unpause();
      await expect(engine.connect(player1).joinQueue(1)).to.not.be.reverted;
    });

    it("should allow emergency functions while paused", async () => {
      const { engine, admin, player1, player2, player3, mockVRF } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);

      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      const gameId = 1;
      expect(await engine.getActiveGames()).to.equal(1);

      await engine.connect(admin).pause();

      await mockVRF.fulfill(gameId, 12345);

      const game = await engine.getGame(gameId);
      expect(game.state).to.equal(4n);
    });

    it("should only allow manager to pause", async () => {
      const { engine, other } = await loadFixture(deployFixture);
      await expect(engine.connect(other).pause()).to.be.revertedWith("RE: not manager");
    });
  });

  /**
   * **Game Lifecycle** — Prueba el flujo completo: jugadores se unen a la
   * cola, cuando se llena se crea la partida automáticamente (OPEN → LOCKED
   * → DRAWING), el callback de VRF la resuelve (PAYOUT → CLOSED), y se
   * distribuyen premio y comisión correctamente.
   * Verifica también que no se pueda resolver dos veces la misma partida.
   */
  describe("Game Lifecycle (queue → VRF → resolve)", () => {
    it("should join queue, auto-create game when full, and resolve via VRF", async () => {
      const { engine, admin, player1, player2, mockVRF, token } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);

      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      const gameId = 1;
      let game = await engine.getGame(gameId);
      expect(game.state).to.equal(2n);
      expect(game.playerCount).to.equal(2);
      expect(game.prizePool).to.equal(ethers.parseEther("20"));

      await mockVRF.fulfill(gameId, 777);

      game = await engine.getGame(gameId);
      expect(game.state).to.equal(4n);
      expect(game.winner).to.not.equal(ethers.ZeroAddress);
    });

    it("should distribute correct prize and fee", async () => {
      const { engine, admin, player1, player2, mockVRF, token, treasury } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("100"), 2, 1);

      const balBefore1 = await token.balanceOf(player1.address);
      const balBefore2 = await token.balanceOf(player2.address);

      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      const gameId = 1;
      const amt = ethers.parseEther("100");
      expect(await token.balanceOf(await engine.getAddress())).to.equal(amt * 2n);

      await mockVRF.fulfill(gameId, 42);

      const game = await engine.getGame(gameId);
      const winnerBal = await token.balanceOf(game.winner);
      const fee = (amt * 2n * 500n) / 10000n;
      const prize = amt * 2n - fee;

      if (game.winner === player1.address) {
        expect(winnerBal).to.equal(balBefore1 - amt + prize);
        expect(await token.balanceOf(player2.address)).to.equal(balBefore2 - amt);
      } else {
        expect(winnerBal).to.equal(balBefore2 - amt + prize);
        expect(await token.balanceOf(player1.address)).to.equal(balBefore1 - amt);
      }

      expect(await token.balanceOf(await treasury.getAddress())).to.equal(fee);
      expect(await engine.getActiveGames()).to.equal(0);
    });

    it("should not allow double resolution", async () => {
      const { engine, admin, player1, player2, mockVRF } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);

      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      await mockVRF.fulfill(1, 123);
      await expect(mockVRF.fulfill(1, 456)).to.be.revertedWith("RE: not drawing");
    });
  });

  /**
   * **Manual Game Creation** — El manager puede crear una partida manual
   * (sin cola) y los jugadores se unen vía `joinGame`. La partida se
   * auto-bloquea al alcanzar maxPlayers.
   */
  describe("Manual Game Creation", () => {
    it("should create game and allow players to join manually", async () => {
      const { engine, admin, player1, player2, player3 } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 5, 2);
      await engine.connect(admin).createGame(1, 3);

      const gameId = 1;
      let game = await engine.getGame(gameId);
      expect(game.state).to.equal(0n);

      await engine.connect(player1).joinGame(gameId);
      await engine.connect(player2).joinGame(gameId);

      game = await engine.getGame(gameId);
      expect(game.state).to.equal(0n);
      expect(game.playerCount).to.equal(2);

      await engine.connect(player3).joinGame(gameId);

      game = await engine.getGame(gameId);
      expect(game.state).to.equal(2n);
      expect(game.playerCount).to.equal(3);
    });
  });

  /**
   * **refundGame** — Devuelve el 100% de las apuestas a todos los jugadores
   * cuando una partida está atascada en LOCKED o DRAWING (VRF nunca respondió).
   * Verifica que no se pueda llamar sobre partidas ya resueltas o inexistentes.
   */
  describe("Emergency: refundGame", () => {
    it("should refund all players when game is stuck in DRAWING", async () => {
      const { engine, admin, player1, player2, token } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);

      const balBefore1 = await token.balanceOf(player1.address);
      const balBefore2 = await token.balanceOf(player2.address);

      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      await engine.connect(admin).refundGame(1);

      expect(await token.balanceOf(player1.address)).to.equal(balBefore1);
      expect(await token.balanceOf(player2.address)).to.equal(balBefore2);
      expect(await engine.getActiveGames()).to.equal(0);

      const game = await engine.getGame(1);
      expect(game.state).to.equal(4n);
    });

    it("should reject refund when game is already resolved", async () => {
      const { engine, admin, player1, player2, mockVRF } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);
      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);
      await mockVRF.fulfill(1, 123);

      await expect(engine.connect(admin).refundGame(1)).to.be.revertedWith("RE: invalid state for refund");
    });

    it("should reject refund when game does not exist", async () => {
      const { engine, admin } = await loadFixture(deployFixture);
      await expect(engine.connect(admin).refundGame(999)).to.be.revertedWith("RE: not found");
    });
  });

  /**
   * **retryRandom** — Reemplaza a `forceDraw`. En lugar de usar randomness
   * débil on-chain, reintenta la solicitud VRF (hasta MAX_RETRIES=3) con un
   * cooldown de RETRY_COOLDOWN=30s entre cada intento.
   *
   * Los tests usan `evm_increaseTime(31)` para saltar el cooldown.
   * Si se agotan los reintentos, solo queda `refundGame`.
   */
  describe("Emergency: retryRandom", () => {
    it("should retry VRF request when game is stuck in DRAWING", async () => {
      const { engine, admin, player1, player2, mockVRF } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);

      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      const gameId = 1;

      await ethers.provider.send("evm_increaseTime", [31]);
      await ethers.provider.send("evm_mine", []);
      await engine.connect(admin).retryRandom(gameId);
      const game = await engine.getGame(gameId);
      expect(game.retryCount).to.equal(1);
    });

    it("should reject retry beyond MAX_RETRIES", async () => {
      const { engine, admin, player1, player2 } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);

      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      const gameId = 1;

      for (let i = 0; i < 3; i++) {
        await ethers.provider.send("evm_increaseTime", [31]);
        await ethers.provider.send("evm_mine", []);
        await engine.connect(admin).retryRandom(gameId);
      }

      await ethers.provider.send("evm_increaseTime", [31]);
      await ethers.provider.send("evm_mine", []);
      await expect(engine.connect(admin).retryRandom(gameId)).to.be.revertedWith("RE: max retries reached");
    });

    it("should reject retry when cooldown not met", async () => {
      const { engine, admin, player1, player2 } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);

      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      await expect(engine.connect(admin).retryRandom(1)).to.be.revertedWith("RE: cooldown not met");
    });

    it("should resolve game after retry via VRF", async () => {
      const { engine, admin, player1, player2, mockVRF } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);
      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      const gameId = 1;

      await ethers.provider.send("evm_increaseTime", [31]);
      await ethers.provider.send("evm_mine", []);
      await engine.connect(admin).retryRandom(gameId);
      await mockVRF.fulfill(gameId, 999);

      const game = await engine.getGame(gameId);
      expect(game.state).to.equal(4n);
    });
  });

  /**
   * **UUPS Upgrade** — Verifica que se pueda actualizar la implementación
   * cuando no hay partidas activas (_activeGames == 0), y que se rechace
   * el upgrade si hay partidas en curso (protección en _authorizeUpgrade).
   */
  describe("UUPS Upgrade", () => {
    it("should upgrade implementation when no active games", async () => {
      const { engine, admin } = await loadFixture(deployFixture);
      const RouletteEngineV2 = await ethers.getContractFactory("RouletteEngine");
      const newImpl = await upgrades.upgradeProxy(await engine.getAddress(), RouletteEngineV2);
      await newImpl.waitForDeployment();

      expect(await upgrades.erc1967.getImplementationAddress(await engine.getAddress()))
        .to.not.equal(ethers.ZeroAddress);
    });

    it("should reject upgrade when active games exist", async () => {
      const { engine, admin, player1, player2 } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);
      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);

      const RouletteEngineV2 = await ethers.getContractFactory("RouletteEngine");
      await expect(
        upgrades.upgradeProxy(await engine.getAddress(), RouletteEngineV2)
      ).to.be.reverted;
    });
  });

  /**
   * **Access Control** — Verifica que las funciones administrativas
   * (setConfig, setRandomnessProvider, setTreasury) solo puedan ser
   * ejecutadas por MANAGER_ROLE.
   */
  describe("Access Control", () => {
    it("should reject non-manager from setConfig", async () => {
      const { engine, other } = await loadFixture(deployFixture);
      await expect(engine.connect(other).setConfig(other.address)).to.be.revertedWith("RE: not manager");
    });

    it("should reject non-manager from setRandomnessProvider", async () => {
      const { engine, other } = await loadFixture(deployFixture);
      await expect(engine.connect(other).setRandomnessProvider(other.address)).to.be.revertedWith("RE: not manager");
    });

    it("should reject non-manager from setTreasury", async () => {
      const { engine, other } = await loadFixture(deployFixture);
      await expect(engine.connect(other).setTreasury(other.address)).to.be.revertedWith("RE: not manager");
    });
  });

  /**
   * **cleanGame** — Limpia los datos de jugadores de una partida finalizada
   * para recuperar gas. Solo puede llamarse cuando la partida está CLOSED.
   * La limpieza se hace automáticamente al resolver, pero también puede
   * invocarse externamente como respaldo.
   */
  describe("cleanGame", () => {
    it("should clean player data after game is closed", async () => {
      const { engine, admin, player1, player2, mockVRF } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 2, 1);
      await engine.connect(player1).joinQueue(1);
      await engine.connect(player2).joinQueue(1);
      await mockVRF.fulfill(1, 123);

      expect((await engine.getGamePlayers(1)).length).to.equal(0);
    });

    it("should reject cleaning non-closed game", async () => {
      const { engine, admin } = await loadFixture(deployFixture);
      await engine.connect(admin).createBetLevel(1, ethers.parseEther("10"), 5, 2);
      await engine.connect(admin).createGame(1, 3);

      await expect(engine.cleanGame(1)).to.be.revertedWith("RE: not closed");
    });
  });
});
