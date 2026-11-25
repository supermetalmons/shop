pragma solidity 0.8.38;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IDMXRenderer, IDMXTokenInfo} from "./IDMXRenderer.sol";

contract DMXWebpRenderer is ERC165, IDMXRenderer {
    using Strings for uint256;

    error InvalidTokenKind();

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IDMXRenderer).interfaceId || super.supportsInterface(interfaceId);
    }

    function tokenURI(address collection, uint256 tokenId) external view returns (string memory) {
        IDMXTokenInfo.TokenInfo memory info = IDMXTokenInfo(collection).getTokenInfo(tokenId);
        bool card = info.kind == IDMXTokenInfo.TokenKind.Card;
        bool nfc = info.kind == IDMXTokenInfo.TokenKind.NFCReceipt;
        if (!card && !nfc && info.kind != IDMXTokenInfo.TokenKind.RedemptionReceipt) revert InvalidTokenKind();
        string memory displayId = info.cardId.toString();
        string memory name = card ? "Tarot Card" : nfc ? "Tarot Card Receipt" : "DMX Redemption Receipt";
        string memory kind = card ? "Mutating Card" : nfc ? "NFC Card Receipt" : "Redemption Receipt";
        string memory description = card
            ? info.cardId <= 777 ? "A mutating Tarot card. Initial base artwork." : "A mutating Tarot card."
            : nfc ? "Proves the authenticity of the physical Tarot card you scanned."
                : "Records the redemption of a divination machina x card.";
        return _dataURI(string.concat(
            '{"name":"', name, ' #', displayId, '","description":"', description,
            '","image":"https://wip.lil.org/dmx/', card ? "cards/" : "receipts/", displayId,
            '.webp","attributes":[{"trait_type":"Kind","value":"', kind,
            '"},{"trait_type":"Card ID","value":', displayId, '}', _provenance(info), ']}'
        ));
    }

    function contractURI(address) external pure returns (string memory) {
        return _dataURI('{"name":"divination machina x","symbol":"DMX","description":"777 Tarot cards and their paired NFC receipts.","image":"https://wip.lil.org/dmx/cards/1.webp","external_link":"https://mons.shop"}');
    }

    function _provenance(IDMXTokenInfo.TokenInfo memory info) private pure returns (string memory) {
        if (info.kind != IDMXTokenInfo.TokenKind.RedemptionReceipt && info.cardId <= 777) return "";
        return string.concat(
            ',{"trait_type":"Generation","value":', info.generation.toString(),
            '},{"trait_type":"Created By Order","value":"', info.createdByOrder.toString(),
            '"},{"trait_type":"Redeemed By Order","value":"', info.redeemedByOrder.toString(), '"}'
        );
    }

    function _dataURI(string memory value) private pure returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(value)));
    }
}
