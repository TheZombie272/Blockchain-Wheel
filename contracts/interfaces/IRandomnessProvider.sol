// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRandomnessProvider {
    function requestRandom(uint256 gameId) external returns (uint256 requestId);
    function setConsumer(address consumer) external;
}
