// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/vrf/VRFConsumerBaseV2.sol";
import "@chainlink/contracts/src/v0.8/interfaces/VRFCoordinatorV2Interface.sol";
import "./interfaces/IRandomnessProvider.sol";
import "./interfaces/IRouletteEngine.sol";

/**
 * @title RandomnessProvider
 * @notice Wrapper sobre Chainlink VRF v2 que permite cambiar de proveedor
 *         sin modificar la lógica del juego en RouletteEngine.
 *
 *         El VRF Coordinator llama a fulfillRandomWords, que a su vez
 *         invoca RouletteEngine.fulfillRandomness.
 */
contract RandomnessProvider is VRFConsumerBaseV2, IRandomnessProvider {
    VRFCoordinatorV2Interface private immutable _coordinator;

    bytes32 private _keyHash;
    uint64 private _subscriptionId;
    uint32 private _callbackGasLimit;
    uint16 private _requestConfirmations;

    address private _consumer;

    mapping(uint256 => uint256) private _requestToGame;
    mapping(uint256 => uint256) private _gameToRequest;

    event ConsumerUpdated(address indexed consumer);
    event RandomnessRequested(uint256 indexed gameId, uint256 indexed requestId);

    constructor(
        address vrfCoordinator,
        bytes32 keyHash,
        uint64 subscriptionId,
        uint32 callbackGasLimit,
        uint16 requestConfirmations
    ) VRFConsumerBaseV2(vrfCoordinator) {
        _coordinator = VRFCoordinatorV2Interface(vrfCoordinator);
        _keyHash = keyHash;
        _subscriptionId = subscriptionId;
        _callbackGasLimit = callbackGasLimit;
        _requestConfirmations = requestConfirmations;
    }

    function setConsumer(address consumer) external {
        require(consumer != address(0), "Invalid consumer");
        _consumer = consumer;
        emit ConsumerUpdated(consumer);
    }

    function requestRandom(uint256 gameId) external returns (uint256 requestId) {
        require(msg.sender == _consumer, "Only consumer");

        requestId = _coordinator.requestRandomWords(
            _keyHash,
            _subscriptionId,
            _requestConfirmations,
            _callbackGasLimit,
            1
        );

        _requestToGame[requestId] = gameId;
        _gameToRequest[gameId] = requestId;

        emit RandomnessRequested(gameId, requestId);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        uint256 gameId = _requestToGame[requestId];
        require(gameId != 0, "Invalid request");

        IRouletteEngine(_consumer).fulfillRandomness(gameId, randomWords[0]);
    }

    function getGameIdByRequest(uint256 requestId) external view returns (uint256) {
        return _requestToGame[requestId];
    }

    function isRequestPending(uint256 gameId) external view returns (bool) {
        return _gameToRequest[gameId] != 0;
    }
}
