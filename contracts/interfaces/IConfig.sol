// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IConfig {
    function tokenAddress() external view returns (address);
    function feePercentage() external view returns (uint256);
    function setToken(address _token) external;
    function setFeePercentage(uint256 _fee) external;
}
