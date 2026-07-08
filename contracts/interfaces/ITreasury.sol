// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITreasury {
    function withdraw(address token, uint256 amount, address to) external;
    function withdrawAll(address token, address to) external;
}
