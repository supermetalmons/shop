pragma solidity 0.8.30;

interface INFT111KRenderer {
    function tokenURI(uint8 kind, uint256 displayId) external view returns (string memory);
}
