// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRouletteEngine {
    function fulfillRandomness(uint256 gameId, uint256 randomValue) external;
}
