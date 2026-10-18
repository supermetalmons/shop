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
        string memory opening =
            '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720">';
        if (kind == 1) return string.concat(opening, _artwork(displayId), "</svg>");
        bool receipt = kind >= 4;
        string memory hero = kind == 4
            ? string.concat(
                '<svg x="151" y="103" width="418" height="418" viewBox="0 0 720 720" overflow="hidden">',
                _artwork(displayId),
                "</svg>"
            )
            : string.concat(
                '<g transform="translate(360 ',
                receipt ? "312" : "360",
                ") scale(",
                kind == 3 ? "1.28" : receipt ? "1.08" : "1.3",
                ") translate(-360 ",
                receipt ? "-448" : kind == 3 ? "-441" : "-453",
                ')">',
                kind == 3 ? _warehouse(displayId) : _crate(displayId),
                "</g>"
            );
        return string.concat(
            opening,
            receipt ? '<rect width="720" height="720" fill="#f4f0e6"/>' : "",
            '<g fill="#191d29" font-family="Arial,Helvetica,sans-serif">',
            receipt ? '<g transform="translate(360 360) scale(.84) translate(-360 -332)">' : "",
            receipt ? _receiptFrame() : "",
            hero,
            receipt ? "</g>" : "",
            receipt ? _receiptSticker() : "",
            "</g></svg>"
        );
    }

    function _artwork(uint256 id) private pure returns (string memory) {
        uint256 seed = uint256(keccak256(abi.encode(id)));
        string[4] memory colors = _palette(seed % 6);
        // The filled flower center preserves a distinct visible geometry for every display ID.
        uint256 key = ((id - 1) * 65537 + 7919) % 111111;
        uint256 x = 264 + 3 * (key % 64);
        uint256 y = 202 + 2 * ((key / 64) % 64);
        string memory flower = string.concat(
            '<g transform="translate(',
            x.toString(),
            " ",
            y.toString(),
            ") rotate(",
            ((seed >> 16) % 60).toString(),
            ')" fill="',
            colors[1],
            '">',
            _petals(seed, id % 4),
            "</g>"
        );
        return string.concat(
            '<rect width="720" height="720" fill="',
            colors[0],
            '"/>',
            _stem(seed, x, y, colors[2], colors[3]),
            flower,
            '<circle cx="',
            x.toString(),
            '" cy="',
            y.toString(),
            '" r="',
            (24 + key / 4096).toString(),
            '" fill="#efb84c"/>'
        );
    }

    function _petals(uint256 seed, uint256 family) private pure returns (string memory) {
        if (family == 0) {
            return _petalRing(10 + 2 * ((seed >> 8) % 2), '<ellipse cy="-72" rx="23" ry="79"/>');
        }
        if (family == 1) {
            return _petalRing(
                5,
                '<path d="M-18 -12C-54 -24 -80 -75 -65 -113C-54 -145 -22 -151 0 -129C22 -151 54 -145 65 -113C80 -75 54 -24 18 -12Z"/>'
            );
        }
        if (family == 2) {
            return _petalRing(
                4, '<path d="M-18 -10C-92 -22 -108 -91 -66 -129C-22 -163 43 -146 65 -105C91 -58 49 -17 18 -10Z"/>'
            );
        }
        return string.concat(
            _petalRing(8, '<path d="M-10 -20Q-60 -80 0 -157Q60 -80 10 -20Z"/>'),
            '<g transform="rotate(22.5)">',
            _petalRing(8, '<ellipse cy="-49" rx="26" ry="55"/>'),
            '</g><g transform="rotate(22.5)" fill="#ffffff" fill-opacity=".2">',
            _petalRing(8, '<ellipse cy="-49" rx="26" ry="55"/>'),
            "</g>"
        );
    }

    function _petalRing(uint256 count, string memory shape) private pure returns (string memory petals) {
        for (uint256 i; i < count; ++i) {
            petals = string.concat(petals, '<g transform="rotate(', (i * 360 / count).toString(), ')">', shape, "</g>");
        }
    }

    function _stem(uint256 seed, uint256 x, uint256 y, string memory stem, string memory leaf)
        private
        pure
        returns (string memory)
    {
        uint256 base = 320 + (seed >> 32) % 81;
        string memory stalk = string.concat(
            '<path d="M',
            base.toString(),
            " 642Q",
            (x - 50).toString(),
            " 470 ",
            x.toString(),
            " ",
            y.toString(),
            '" fill="none" stroke="',
            stem,
            '" stroke-width="13" stroke-linecap="round"/>'
        );
        return string.concat(
            stalk,
            _leaf((base + 3 * x - 100) / 4, (1582 + y) / 4, false, stem),
            _leaf((9 * base + 7 * x - 300) / 16, (8598 + y) / 16, true, leaf)
        );
    }

    function _leaf(uint256 x, uint256 y, bool left, string memory color) private pure returns (string memory) {
        return string.concat(
            '<path transform="translate(',
            x.toString(),
            " ",
            y.toString(),
            ')" d="',
            left ? "M0 0C-12 -45 -76 -73 -118 -68C-100 -12 -43 8 0 0Z" : "M0 0C10 -62 76 -92 126 -98C122 -36 68 5 0 0Z",
            '" fill="',
            color,
            '"/>'
        );
    }

    function _palette(uint256 palette) private pure returns (string[4] memory) {
        if (palette == 0) return [string("#f8edc8"), "#e47e70", "#567c60", "#739267"];
        if (palette == 1) return [string("#cbdfe5"), "#fff7e5", "#4c7866", "#7b9b7a"];
        if (palette == 2) return [string("#f6e1d5"), "#9b82c0", "#537d62", "#87a178"];
        if (palette == 3) return [string("#e2eddf"), "#dc8fa7", "#4f7c61", "#80a172"];
        if (palette == 4) return [string("#e9e0ee"), "#e99765", "#5d7b62", "#8ba27a"];
        return [string("#f6efdf"), "#7b9fcb", "#4b7860", "#84a17b"];
    }

    function _crate(uint256 id) private pure returns (string memory) {
        return string.concat(
            '<g stroke="#68513b" stroke-width="5" stroke-linejoin="round">'
            '<path d="M360 260L540 350L360 440L180 350Z" fill="#e8c77f"/>'
            '<path d="M180 350L360 440V646L180 553Z" fill="#c59454"/>'
            '<path d="M360 440L540 350V553L360 646Z" fill="#d9b16b"/>'
            '<path d="M264 307L444 398V600M276 600V398L456 307" fill="none"/>'
            '<path d="M180 415L360 507L540 415M180 491L360 583L540 491" fill="none" stroke-width="3"/>'
            '<path d="M405 463L497 417V492L405 538Z" fill="#fff7e6" stroke-width="2"/></g>'
            '<g transform="matrix(1 -.5 0 1 451 478)"><text x="0" y="8" text-anchor="middle" font-size="22" font-weight="900" letter-spacing="-1" fill="#68513b">',
            id.toString(),
            "</text></g>"
        );
    }

    function _warehouse(uint256 id) private pure returns (string memory) {
        return string.concat(
            '<g stroke="#52664f" stroke-width="5" stroke-linejoin="round">'
            '<path d="M150 374L360 246L570 374V644H150Z" fill="#c6d1bb"/>'
            '<path d="M132 382L360 240L588 382" fill="none" stroke-width="9"/>'
            '<path d="M203 409H517V644H203Z" fill="#91a787"/>'
            '<path d="M203 452H517M203 493H517M203 534H517M203 575H517M203 616H517" stroke-width="3"/>'
            '<path d="M258 291H462V355H258Z" fill="#f6f2e6"/>'
            '<rect x="302" y="533" width="116" height="111" fill="#e1e7d8"/>'
            '<path d="M360 533V644M302 588H418" stroke-width="3"/></g>'
            '<text x="360" y="335" text-anchor="middle" font-size="34" font-weight="900" letter-spacing="-1" fill="#52664f">',
            id.toString(),
            "</text>"
        );
    }

    function _receiptFrame() private pure returns (string memory) {
        return '<path d="M88 44H632V620L616 610L600 620L584 610L568 620L552 610L536 620L520 610L504 620L488 610L472 620L456 610L440 620L424 610L408 620L392 610L376 620L360 610L344 620L328 610L312 620L296 610L280 620L264 610L248 620L232 610L216 620L200 610L184 620L168 610L152 620L136 610L120 620L104 610L88 620Z" fill="#fbfaf5" stroke="#191d29" stroke-width="2"/>';
    }

    function _receiptSticker() private pure returns (string memory) {
        return '<g transform="translate(548 580) rotate(-12)"><rect x="-105" y="-28" width="210" height="56" rx="3" fill="#c93c2e"/>'
            '<text x="0" y="7" text-anchor="middle" font-size="19" font-weight="700" letter-spacing="2" fill="#fbfaf5">REDEEMED</text></g>';
    }

    function _label(uint8 kind) private pure returns (string memory) {
        if (kind == 1) return "Artwork";
        if (kind == 2) return "Crate";
        if (kind == 3) return "Warehouse";
        if (kind == 4) return "Artwork Receipt";
        return "Crate Receipt";
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
