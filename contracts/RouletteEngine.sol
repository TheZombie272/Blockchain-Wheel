// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IConfig.sol";
import "./interfaces/IRandomnessProvider.sol";
import "./interfaces/ITreasury.sol";

/**
 * @title RouletteEngine
 * @notice Cerebro del sistema: gestiona partidas, colas por nivel de apuesta,
 *         aleatoriedad y distribución de premios.
 *
 *         Patrón UUPS — la lógica de actualización reside aquí.
 *         No se puede actualizar el contrato mientras haya partidas activas.
 *
 *         Máquina de estados por partida:
 *         OPEN → LOCKED → DRAWING → PAYOUT → CLOSED
 *
 *         Sistema de colas: los jugadores se encolan por nivel de apuesta.
 *         Cuando la cola se llena, el contrato crea y resuelve la partida
 *         automáticamente.
 */
contract RouletteEngine is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ==================== TIPOS ====================

    enum GameState { OPEN, LOCKED, DRAWING, PAYOUT, CLOSED }

    struct Game {
        uint256 id;
        uint256 betLevel;
        GameState state;
        uint256 betAmount;
        uint256 prizePool;
        uint256 playerCount;
        uint256 maxPlayers;
        uint256 requestId;
        address winner;
        address token;
        uint256 feePercentage;
        address randomnessProvider;
        bool exists;
    }

    struct PlayerEntry {
        address player;
        uint256 betAmount;
    }

    struct BetLevel {
        uint256 betAmount;
        uint256 maxPlayers;
        uint256 queueLength;
        bool exists;
    }

    // ==================== ROLES ====================

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    // ==================== STORAGE ====================

    uint256 private _nextGameId;
    uint256 private _activeGames;

    mapping(uint256 => BetLevel) private _betLevels;
    mapping(uint256 => address[]) private _queues;
    mapping(uint256 => Game) private _games;
    mapping(uint256 => PlayerEntry[]) private _gamePlayers;
    mapping(uint256 => mapping(address => uint256)) private _playerIndex;

    IConfig private _config;
    IRandomnessProvider private _randomnessProvider;
    ITreasury private _treasury;

    // ==================== EVENTOS ====================

    event BetLevelCreated(
        uint256 indexed betLevel,
        uint256 betAmount,
        uint256 maxPlayers
    );

    event BetLevelUpdated(
        uint256 indexed betLevel,
        uint256 betAmount,
        uint256 maxPlayers
    );

    event GameCreated(
        uint256 indexed gameId,
        uint256 indexed betLevel,
        uint256 maxPlayers,
        uint256 prizePool
    );

    event PlayerJoined(
        uint256 indexed gameId,
        address indexed player,
        uint256 betAmount
    );

    event GameLocked(uint256 indexed gameId);

    event RandomnessRequested(
        uint256 indexed gameId,
        uint256 requestId
    );

    event WinnerDeclared(
        uint256 indexed gameId,
        address indexed winner,
        uint256 prize,
        uint256 randomValue
    );

    event FeesDistributed(
        uint256 indexed gameId,
        uint256 feeAmount,
        address indexed treasury
    );

    event GameCleaned(uint256 indexed gameId);
    event GameRefunded(uint256 indexed gameId);

    event ConfigUpdated(address indexed config);
    event RandomnessProviderUpdated(address indexed provider);
    event TreasuryUpdated(address indexed treasury);

    // ==================== MODIFICADORES ====================

    modifier onlyManager() {
        require(hasRole(MANAGER_ROLE, msg.sender), "RE: not manager");
        _;
    }

    // ==================== CONSTRUCTOR ====================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Inicializa el contrato (reemplaza al constructor en proxies UUPS).
     * @param admin Dirección que recibirá los roles DEFAULT_ADMIN y MANAGER.
     * @param config Dirección del contrato Config.
     * @param randomnessProvider Dirección del contrato RandomnessProvider.
     * @param treasury Dirección del contrato Treasury.
     */
    function initialize(
        address admin,
        address config,
        address randomnessProvider,
        address treasury
    ) external initializer {
        __UUPSUpgradeable_init();
        __AccessControl_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGER_ROLE, admin);

        _config = IConfig(config);
        _randomnessProvider = IRandomnessProvider(randomnessProvider);
        _treasury = ITreasury(treasury);
        _nextGameId = 1;
    }

    // ==================== ADMIN / GESTIÓN ====================

    /**
     * @notice Crea un nuevo nivel de apuesta con cola automática.
     * @param betLevel Identificador del nivel (ej. 1, 5, 10).
     * @param betAmount Monto exacto del token requerido para participar.
     * @param maxPlayers Número máximo de jugadores por partida (mín. 2, máx. 100).
     */
    function createBetLevel(
        uint256 betLevel,
        uint256 betAmount,
        uint256 maxPlayers
    ) external onlyManager {
        require(!_betLevels[betLevel].exists, "RE: level exists");
        require(betAmount > 0, "RE: invalid bet amount");
        require(maxPlayers >= 2, "RE: min 2 players");
        require(maxPlayers <= 100, "RE: max 100 players");

        _betLevels[betLevel] = BetLevel({
            betAmount: betAmount,
            maxPlayers: maxPlayers,
            queueLength: 0,
            exists: true
        });

        emit BetLevelCreated(betLevel, betAmount, maxPlayers);
    }

    /**
     * @notice Actualiza los parámetros de un nivel de apuesta existente.
     * @param betLevel Identificador del nivel.
     * @param betAmount Nuevo monto de apuesta.
     * @param maxPlayers Nuevo límite de jugadores.
     */
    function updateBetLevel(
        uint256 betLevel,
        uint256 betAmount,
        uint256 maxPlayers
    ) external onlyManager {
        BetLevel storage level = _betLevels[betLevel];
        require(level.exists, "RE: level not found");
        require(betAmount > 0, "RE: invalid bet amount");
        require(maxPlayers >= 2, "RE: min 2 players");
        require(maxPlayers <= 100, "RE: max 100 players");

        level.betAmount = betAmount;
        level.maxPlayers = maxPlayers;

        emit BetLevelUpdated(betLevel, betAmount, maxPlayers);
    }

    /**
     * @notice Crea manualmente una partida abierta en un nivel de apuesta existente.
     *         Los jugadores pueden unirse mediante joinGame(gameId).
     * @param betLevel Nivel de apuesta.
     * @param maxPlayers Número de jugadores para esta partida.
     */
    function createGame(
        uint256 betLevel,
        uint256 maxPlayers
    ) external onlyManager {
        BetLevel storage level = _betLevels[betLevel];
        require(level.exists, "RE: level not found");
        require(maxPlayers >= 2, "RE: min 2 players");
        require(maxPlayers <= 100, "RE: max 100 players");

        uint256 prizePool = level.betAmount * maxPlayers;
        _createGame(betLevel, level.betAmount, maxPlayers, prizePool);
    }

    function setConfig(address config) external onlyManager {
        _config = IConfig(config);
        emit ConfigUpdated(config);
    }

    function setRandomnessProvider(address provider) external onlyManager {
        _randomnessProvider = IRandomnessProvider(provider);
        emit RandomnessProviderUpdated(provider);
    }

    function setTreasury(address treasury) external onlyManager {
        _treasury = ITreasury(treasury);
        emit TreasuryUpdated(treasury);
    }

    // ==================== JUGADORES ====================

    /**
     * @notice Un jugador se une a la cola de un nivel de apuesta.
     *         Transfiere el token inmediatamente.
     *         Si la cola se llena, se crea y procesa la partida automáticamente.
     * @param betLevel Nivel de apuesta al cual unirse.
     */
    function joinQueue(uint256 betLevel) external nonReentrant {
        BetLevel storage level = _betLevels[betLevel];
        require(level.exists, "RE: invalid level");
        require(level.queueLength < level.maxPlayers, "RE: queue full");

        IERC20(_config.tokenAddress()).safeTransferFrom(
            msg.sender, address(this), level.betAmount
        );

        _queues[betLevel].push(msg.sender);
        level.queueLength++;

        emit PlayerJoined(0, msg.sender, level.betAmount);

        if (level.queueLength == level.maxPlayers) {
            _startGameFromQueue(betLevel);
        }
    }

    /**
     * @notice Un jugador se une a una partida manual específica.
     *         La partida debe estar en estado OPEN.
     * @param gameId ID de la partida.
     */
    function joinGame(uint256 gameId) external nonReentrant {
        Game storage game = _games[gameId];
        require(game.exists, "RE: game not found");
        require(game.state == GameState.OPEN, "RE: game not open");
        require(game.playerCount < game.maxPlayers, "RE: game full");
        require(_playerIndex[gameId][msg.sender] == 0, "RE: already joined");

        IERC20(game.token).safeTransferFrom(
            msg.sender, address(this), game.betAmount
        );

        _gamePlayers[gameId].push(PlayerEntry({
            player: msg.sender,
            betAmount: game.betAmount
        }));
        _playerIndex[gameId][msg.sender] = _gamePlayers[gameId].length;
        game.playerCount++;

        emit PlayerJoined(gameId, msg.sender, game.betAmount);

        if (game.playerCount == game.maxPlayers) {
            _lockAndRequestRandom(gameId);
        }
    }

    // ==================== INTERNAS: CICLO DE VIDA ====================

    function _createGame(
        uint256 betLevel,
        uint256 betAmount,
        uint256 maxPlayers,
        uint256 prizePool
    ) internal returns (uint256 gameId) {
        gameId = _nextGameId++;

        Game storage game = _games[gameId];
        game.id = gameId;
        game.betLevel = betLevel;
        game.state = GameState.OPEN;
        game.betAmount = betAmount;
        game.prizePool = prizePool;
        game.playerCount = 0;
        game.maxPlayers = maxPlayers;
        game.token = _config.tokenAddress();
        game.feePercentage = _config.feePercentage();
        game.randomnessProvider = address(_randomnessProvider);
        game.exists = true;

        _activeGames++;

        emit GameCreated(gameId, betLevel, maxPlayers, prizePool);
    }

    function _startGameFromQueue(uint256 betLevel) internal {
        BetLevel storage level = _betLevels[betLevel];
        require(level.queueLength == level.maxPlayers, "RE: queue not full");

        uint256 gameId = _createGame(
            betLevel,
            level.betAmount,
            level.maxPlayers,
            level.betAmount * level.maxPlayers
        );

        Game storage game = _games[gameId];

        address[] storage queue = _queues[betLevel];
        for (uint256 i = 0; i < queue.length; i++) {
            address player = queue[i];
            _gamePlayers[gameId].push(PlayerEntry({
                player: player,
                betAmount: level.betAmount
            }));
            _playerIndex[gameId][player] = _gamePlayers[gameId].length;
            game.playerCount++;
        }

        delete _queues[betLevel];
        level.queueLength = 0;

        _lockAndRequestRandom(gameId);
    }

    function _lockAndRequestRandom(uint256 gameId) internal {
        Game storage game = _games[gameId];
        require(game.state == GameState.OPEN, "RE: not open");

        game.state = GameState.LOCKED;
        emit GameLocked(gameId);

        game.state = GameState.DRAWING;
        uint256 requestId = _randomnessProvider.requestRandom(gameId);
        game.requestId = requestId;

        emit RandomnessRequested(gameId, requestId);
    }

    // ==================== CALLBACK DE ALEATORIEDAD ====================

    /**
     * @notice Llamado por RandomnessProvider cuando VRF entrega un número aleatorio.
     *         Calcula el ganador, distribuye premios y comisiones, y limpia la partida.
     * @param gameId ID de la partida.
     * @param randomValue Número aleatorio provisto por Chainlink VRF.
     */
    function fulfillRandomness(
        uint256 gameId,
        uint256 randomValue
    ) external {
        Game storage game = _games[gameId];
        require(game.exists, "RE: game not found");
        require(msg.sender == game.randomnessProvider, "RE: not authorized");
        require(game.state == GameState.DRAWING, "RE: not drawing");

        _resolveGame(gameId, randomValue);
    }

    function _resolveGame(uint256 gameId, uint256 randomValue) internal {
        Game storage game = _games[gameId];

        uint256 winnerIndex = randomValue % game.playerCount;
        address winner = _gamePlayers[gameId][winnerIndex].player;
        game.winner = winner;

        uint256 feeAmount = (game.prizePool * game.feePercentage) / 10000;
        uint256 prizeAmount = game.prizePool - feeAmount;

        game.state = GameState.PAYOUT;
        emit WinnerDeclared(gameId, winner, prizeAmount, randomValue);

        IERC20 token = IERC20(game.token);
        if (prizeAmount > 0) {
            token.safeTransfer(winner, prizeAmount);
        }
        if (feeAmount > 0) {
            token.safeTransfer(address(_treasury), feeAmount);
        }

        emit FeesDistributed(gameId, feeAmount, address(_treasury));

        game.state = GameState.CLOSED;
        _activeGames--;

        _cleanGame(gameId);
    }

    // ==================== LIMPIEZA ====================

    /**
     * @notice Elimina los datos de jugadores de una partida finalizada
     *         para recuperar gas y mantener el almacenamiento ligero.
     *         Se llama automáticamente al resolver la partida; también
     *         puede ser invocado externamente como respaldo.
     * @param gameId ID de la partida.
     */
    function cleanGame(uint256 gameId) external {
        Game storage game = _games[gameId];
        require(game.exists, "RE: not found");
        require(game.state == GameState.CLOSED, "RE: not closed");
        _cleanGame(gameId);
    }

    function _cleanGame(uint256 gameId) internal {
        PlayerEntry[] storage players = _gamePlayers[gameId];
        if (players.length == 0) return;

        for (uint256 i = 0; i < players.length; i++) {
            delete _playerIndex[gameId][players[i].player];
        }
        delete _gamePlayers[gameId];

        emit GameCleaned(gameId);
    }

    // ==================== EMERGENCIA ====================

    /**
     * @notice Reembolsa a todos los jugadores de una partida atascada
     *         (p. ej. VRF nunca responde). Solo para estados LOCKED o DRAWING.
     * @param gameId ID de la partida.
     */
    function refundGame(uint256 gameId) external onlyManager {
        Game storage game = _games[gameId];
        require(game.exists, "RE: not found");
        require(
            game.state == GameState.LOCKED || game.state == GameState.DRAWING,
            "RE: invalid state for refund"
        );

        IERC20 token = IERC20(game.token);
        PlayerEntry[] storage players = _gamePlayers[gameId];
        for (uint256 i = 0; i < players.length; i++) {
            token.safeTransfer(players[i].player, players[i].betAmount);
        }

        game.state = GameState.CLOSED;
        _activeGames--;
        _cleanGame(gameId);

        emit GameRefunded(gameId);
    }

    /**
     * @notice Fuerza el sorteo de una partida atascada usando datos
     *         de la blockchain como fuente de aleatoriedad de respaldo.
     *         Último recurso si VRF falla.
     * @param gameId ID de la partida.
     */
    function forceDraw(uint256 gameId) external onlyManager {
        Game storage game = _games[gameId];
        require(game.exists, "RE: not found");
        require(game.state == GameState.DRAWING, "RE: not drawing");

        uint256 pseudoRandom = uint256(
            keccak256(abi.encodePacked(
                block.timestamp, block.prevrandao, gameId, game.playerCount
            ))
        );

        _resolveGame(gameId, pseudoRandom);
    }

    // ==================== UUPS ====================

    /**
     * @notice Bloquea la actualización del proxy si hay partidas activas.
     *         Garantiza que la lógica de una partida en curso no cambie a mitad del juego.
     */
    function _authorizeUpgrade(
        address
    ) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_activeGames == 0, "RE: active games in progress");
    }

    // ==================== CONSULTAS ====================

    function getGame(uint256 gameId) external view returns (Game memory) {
        require(_games[gameId].exists, "RE: not found");
        return _games[gameId];
    }

    function getGamePlayers(
        uint256 gameId
    ) external view returns (PlayerEntry[] memory) {
        require(_games[gameId].exists, "RE: not found");
        return _gamePlayers[gameId];
    }

    function getBetLevel(
        uint256 betLevel
    ) external view returns (BetLevel memory) {
        BetLevel storage level = _betLevels[betLevel];
        require(level.exists, "RE: not found");
        return level;
    }

    function getQueue(
        uint256 betLevel
    ) external view returns (address[] memory) {
        return _queues[betLevel];
    }

    function getConfig() external view returns (address) {
        return address(_config);
    }

    function getRandomnessProvider() external view returns (address) {
        return address(_randomnessProvider);
    }

    function getTreasury() external view returns (address) {
        return address(_treasury);
    }

    function getActiveGames() external view returns (uint256) {
        return _activeGames;
    }

    function getNextGameId() external view returns (uint256) {
        return _nextGameId;
    }
}
