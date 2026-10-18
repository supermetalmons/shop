pragma solidity 0.8.30;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IMons111kRenderer} from "./IMons111kRenderer.sol";

contract Mons111kRenderer is IMons111kRenderer {
    using Strings for uint256;

    error InvalidItem();

    function tokenURI(uint8 kind, uint256 displayId) external pure returns (string memory) {
        _validate(kind, displayId);
        string memory label = _label(kind);
        string memory number = displayId.toString();
        string memory image = string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(_svg(kind, displayId))));
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(
                bytes(
                    string.concat(
                        '{"name":"111k ',
                        label,
                        " #",
                        number,
                        '","description":"Mons 111k test collection. Fully onchain artwork placeholders. ',
                        _description(kind, displayId),
                        '","image":"',
                        image,
                        '","attributes":[{"trait_type":"Type","value":"',
                        label,
                        '"},{"trait_type":"Item number","value":',
                        number,
                        '},{"trait_type":"Network","value":"Testnet"}]}'
                    )
                )
            )
        );
    }

    function _svg(uint8 kind, uint256 displayId) private pure returns (string memory) {
        string memory hero = kind == 3 ? _warehouse() : kind == 2 || kind == 5 ? _crate() : _artwork(displayId);
        string memory frame = kind >= 4 ? _receiptFrame() : "";
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960" viewBox="0 0 720 960">',
            '<rect width="720" height="960" fill="#f4f0e6"/>',
            '<path d="M32 32H688V928H32Z" fill="none" stroke="#191d29" stroke-width="2"/>',
            '<g fill="#191d29" font-family="Arial,Helvetica,sans-serif">',
            '<text x="60" y="96" font-size="52" font-weight="900" letter-spacing="-3">111k</text>',
            '<text x="660" y="83" text-anchor="end" font-size="13" font-weight="700" letter-spacing="3">MONS / TESTNET</text>',
            '<path d="M60 127H660" stroke="#191d29" stroke-width="2"/>',
            '<text x="60" y="173" font-size="15" font-weight="700" letter-spacing="3">',
            _upperLabel(kind),
            "</text>",
            frame,
            hero,
            '<path d="M60 733H660" stroke="#191d29" stroke-width="2"/>',
            '<text x="60" y="807" font-size="62" font-weight="900" letter-spacing="-2">#',
            displayId.toString(),
            "</text>",
            '<text x="60" y="847" font-size="15" font-weight="700" letter-spacing="2">',
            _caption(kind, displayId),
            "</text>",
            '<text x="60" y="900" font-size="11" letter-spacing="2">MONS / 111K EDITION</text>',
            '<circle cx="648" cy="892" r="9" fill="#315cf4"/></g></svg>'
        );
    }

    function _artwork(uint256 id) private pure returns (string memory) {
        return string.concat(
            '<g transform="translate(360 448) rotate(',
            (id % 4 * 90).toString(),
            ')">',
            '<rect x="-167" y="-167" width="334" height="334" rx="5" fill="#e4e0d6"/>',
            '<path d="M-142 142V-142H142V-48H-48V142Z" fill="#315cf4"/>',
            '<circle cx="49" cy="49" r="94" fill="#191d29"/>',
            '<circle cx="49" cy="49" r="38" fill="#f4f0e6"/>',
            '<path d="M-141 -142L141 140" stroke="#f4f0e6" stroke-width="5"/>',
            '<rect x="-139" y="-26" width="77" height="167" fill="#315cf4"/>',
            '</g><path d="M159 247H191M159 247V279M529 247H561V279M159 617V649H191M529 649H561V617" fill="none" stroke="#191d29" stroke-width="2"/>'
        );
    }

    function _crate() private pure returns (string memory) {
        return '<g stroke="#191d29" stroke-width="5" stroke-linejoin="round">'
            '<path d="M360 260L540 350L360 440L180 350Z" fill="#f4f0e6"/>'
            '<path d="M180 350L360 440V646L180 553Z" fill="#315cf4"/>'
            '<path d="M360 440L540 350V553L360 646Z" fill="#e4e0d6"/>'
            '<path d="M264 307L444 398V600M276 600V398L456 307" fill="none"/>'
            '<path d="M180 415L360 507L540 415M180 491L360 583L540 491" fill="none" stroke-width="3"/>'
            '<path d="M405 463L497 417V492L405 538Z" fill="#f4f0e6" stroke-width="2"/>'
            '</g><g transform="matrix(1 -.5 0 1 419 485)" font-size="24" font-weight="900"><text>111k</text></g>';
    }

    function _warehouse() private pure returns (string memory) {
        return '<g stroke="#191d29" stroke-width="5" stroke-linejoin="round">'
            '<path d="M150 374L360 246L570 374V644H150Z" fill="#e4e0d6"/>'
            '<path d="M132 382L360 240L588 382" fill="none" stroke-width="9"/>'
            '<path d="M203 409H517V644H203Z" fill="#315cf4"/>'
            '<path d="M203 452H517M203 493H517M203 534H517M203 575H517M203 616H517" stroke-width="3"/>'
            '<path d="M258 291H462V355H258Z" fill="#f4f0e6"/>' '<path d="M112 646H608" stroke-width="7"/>'
            '<rect x="302" y="533" width="116" height="111" fill="#f4f0e6"/>'
            '<path d="M360 533V644M302 588H418" stroke-width="3"/>'
            '</g><text x="360" y="335" text-anchor="middle" font-size="31" font-weight="900">111k</text>';
    }

    function _receiptFrame() private pure returns (string memory) {
        return '<path d="M116 218H604V684L586 674L568 684L550 674L532 684L514 674L496 684L478 674L460 684L442 674L424 684L406 674L388 684L370 674L352 684L334 674L316 684L298 674L280 684L262 674L244 684L226 674L208 684L190 674L172 684L154 674L136 684L116 674Z" fill="#fbfaf5" stroke="#191d29" stroke-width="2"/>'
            '<path d="M133 232H587" stroke="#315cf4" stroke-width="6"/>'
            '<g transform="translate(565 648) rotate(-12)"><rect x="-80" y="-21" width="160" height="38" rx="3" fill="#315cf4"/>'
            '<text x="0" y="5" text-anchor="middle" font-size="12" font-weight="700" letter-spacing="2" fill="#fbfaf5">RECEIPT</text></g>';
    }

    function _label(uint8 kind) private pure returns (string memory) {
        if (kind == 1) return "Artwork";
        if (kind == 2) return "Crate";
        if (kind == 3) return "Warehouse";
        if (kind == 4) return "Artwork Receipt";
        return "Crate Receipt";
    }

    function _upperLabel(uint8 kind) private pure returns (string memory) {
        if (kind == 1) return "ARTWORK";
        if (kind == 2) return "SEALED CRATE";
        if (kind == 3) return "WAREHOUSE";
        if (kind == 4) return "ARTWORK RECEIPT";
        return "CRATE RECEIPT";
    }

    function _caption(uint8 kind, uint256 id) private pure returns (string memory) {
        if (kind == 1) return "ONE OF 111,111 ARTWORKS";
        if (kind == 2) return id == 5555 ? "31 ARTWORKS INSIDE / BONUS CRATE" : "20 ARTWORKS INSIDE";
        if (kind == 3) return "11 CRATES INSIDE";
        if (kind == 4) return "PHYSICAL ARTWORK / REDEEMED";
        return id == 5555 ? "CLAIM 31 ARTWORK RECEIPTS WITH YOUR CODE" : "CLAIM 20 ARTWORK RECEIPTS WITH YOUR CODE";
    }

    function _description(uint8 kind, uint256 id) private pure returns (string memory) {
        if (kind == 1) return "A numbered artwork, redeemable for physical delivery.";
        if (kind == 2) {
            return id == 5555 ? "Crate number 5555 contains 31 artworks." : "A sealed crate containing 20 artworks.";
        }
        if (kind == 3) return "A warehouse containing 11 crates. Unpack it before opening or redeeming its crates.";
        if (kind == 4) return "A receipt for a physical artwork. This receipt cannot be redeemed again.";
        return "A receipt for a physical crate. Its secret code allows its owner to claim the artwork receipts.";
    }

    function _validate(uint8 kind, uint256 id) private pure {
        if (id == 0 || kind == 0 || kind > 5) revert InvalidItem();
        uint256 maximum = kind == 3 ? 505 : kind == 2 || kind == 5 ? 5555 : 111111;
        if (id > maximum) revert InvalidItem();
    }
}
