pragma solidity 0.8.38;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IDMXTokenInfo {
    enum TokenKind { None, Card, NFCReceipt, RedemptionReceipt }

    struct TokenInfo {
        TokenKind kind;
        uint256 cardId;
        uint256 generation;
        uint256 createdByOrder;
        uint256 redeemedByOrder;
        bool burned;
    }

    function getTokenInfo(uint256 tokenId) external view returns (TokenInfo memory);
}

interface IDMXRenderer is IERC165 {
    function tokenURI(address collection, uint256 tokenId) external view returns (string memory);
    function contractURI(address collection) external view returns (string memory);
}
