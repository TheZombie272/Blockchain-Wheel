// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IConfig.sol";

/**
 * @title Config
 * @notice Almacena variables configurables del protocolo.
 *         Contrato minimalista no-upgradeable; si se necesita cambiar la lógica
 *         se despliega uno nuevo y se actualiza la referencia en RouletteEngine.
 */
contract Config is AccessControl, IConfig {
    bytes32 public constant CONFIGURATOR_ROLE = keccak256("CONFIGURATOR_ROLE");

    address public tokenAddress;
    uint256 public feePercentage;

    event TokenUpdated(address indexed oldToken, address indexed newToken);
    event FeePercentageUpdated(uint256 oldFee, uint256 newFee);

    constructor(address admin, address _token, uint256 _fee) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIGURATOR_ROLE, admin);
        tokenAddress = _token;
        feePercentage = _fee;
    }

    function setToken(address _token) external onlyRole(CONFIGURATOR_ROLE) {
        emit TokenUpdated(tokenAddress, _token);
        tokenAddress = _token;
    }

    function setFeePercentage(uint256 _fee) external onlyRole(CONFIGURATOR_ROLE) {
        require(_fee <= 2000, "Max 20%");
        emit FeePercentageUpdated(feePercentage, _fee);
        feePercentage = _fee;
    }
}
