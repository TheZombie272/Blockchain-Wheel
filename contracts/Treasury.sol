// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ITreasury.sol";

/**
 * @title Treasury
 * @notice Recibe y resguarda las comisiones del protocolo.
 *         Solo direcciones con rol WITHDRAWER_ROLE pueden retirar fondos.
 */
contract Treasury is AccessControl, ITreasury {
    using SafeERC20 for IERC20;

    bytes32 public constant WITHDRAWER_ROLE = keccak256("WITHDRAWER_ROLE");

    event Withdrawn(address indexed token, uint256 amount, address indexed to);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WITHDRAWER_ROLE, admin);
    }

    function withdraw(address token, uint256 amount, address to) external onlyRole(WITHDRAWER_ROLE) {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, amount, to);
    }

    function withdrawAll(address token, address to) external onlyRole(WITHDRAWER_ROLE) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);
        emit Withdrawn(token, balance, to);
    }
}
