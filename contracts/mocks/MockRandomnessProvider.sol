// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IRandomnessProvider.sol";
import "../interfaces/IRouletteEngine.sol";

contract MockRandomnessProvider is IRandomnessProvider {
    address private _consumer;
    uint256 private _nextRequestId = 1;

    mapping(uint256 => uint256) private _gameToRequest;
    mapping(uint256 => uint256) private _requestToGame;

    event RandomnessRequested(uint256 indexed gameId, uint256 indexed requestId);

    function setConsumer(address consumer) external {
        _consumer = consumer;
    }

    function requestRandom(uint256 gameId) external returns (uint256 requestId) {
        require(msg.sender == _consumer, "Only consumer");

        requestId = _nextRequestId++;
        _requestToGame[requestId] = gameId;
        _gameToRequest[gameId] = requestId;

        emit RandomnessRequested(gameId, requestId);
    }

    function fulfill(uint256 gameId, uint256 randomValue) external {
        IRouletteEngine(_consumer).fulfillRandomness(gameId, randomValue);
    }

    function getGameIdByRequest(uint256 requestId) external view returns (uint256) {
        return _requestToGame[requestId];
    }

    function isRequestPending(uint256 gameId) external view returns (bool) {
        return _gameToRequest[gameId] != 0;
    }
}
