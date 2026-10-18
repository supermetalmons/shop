pragma solidity 0.8.30;

interface IMons111kRenderer {
    function tokenURI(uint8 kind, uint256 displayId) external view returns (string memory);
}
