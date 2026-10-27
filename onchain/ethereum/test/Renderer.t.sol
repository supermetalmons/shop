pragma solidity 0.8.30;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {NFT111KRenderer} from "../src/NFT111KRenderer.sol";
import {TestSupport} from "./TestSupport.sol";

interface RendererVm {
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
}

contract NFT111KRendererTest is TestSupport {
    using Strings for uint256;

    uint256 private constant MAX_ARTWORKS = 111111;
    uint256 private constant MAX_ARTWORK_RECEIPTS = 222222;
    NFT111KRenderer private renderer;
    NFT111KRenderer private secondRenderer;

    function setUp() public {
        renderer = new NFT111KRenderer();
        secondRenderer = new NFT111KRenderer();
    }

    function testRuntimeFitsCompactDeploymentBudget() public view {
        assertTrue(address(renderer).code.length <= 12 * 1024);
    }

    function testFuzzArtworkIsDeterministicAcrossDeployments(uint256 seed) public view {
        uint256 id = seed % MAX_ARTWORKS + 1;
        bytes32 original = keccak256(_svg(renderer, 1, id));
        assertEq(original, keccak256(_svg(renderer, 1, id)));
        assertEq(original, keccak256(_svg(secondRenderer, 1, id)));
    }

    function testFuzzDistinctArtworkIdsHaveDifferentImages(uint256 firstSeed, uint256 secondSeed) public view {
        uint256 first = firstSeed % MAX_ARTWORKS + 1;
        uint256 second = (first - 1 + secondSeed % (MAX_ARTWORKS - 1) + 1) % MAX_ARTWORKS + 1;
        assertTrue(keccak256(_svg(renderer, 1, first)) != keccak256(_svg(renderer, 1, second)));
    }

    function testFuzzAllKindsPreserveCanvasBackgroundsAndSvgBudget(uint256 seed, uint8 kindSeed) public view {
        uint8 kind = kindSeed % 5 + 1;
        uint256 maximum =
            kind == 3 ? 505 : kind == 2 || kind == 5 ? 5555 : kind == 4 ? MAX_ARTWORK_RECEIPTS : MAX_ARTWORKS;
        bytes memory svg = _svg(renderer, kind, seed % maximum + 1);
        uint256 background = _find(svg, bytes('<rect width="720" height="720"'), 0);
        if (kind == 2 || kind == 3) assertEq(background, type(uint256).max);
        else assertEq(background, Bytes.indexOf(svg, ">") + 1);
    }

    function testFuzzReceiptPreservesArtworkAndVisibleFlowerCenter(uint256 seed) public view {
        uint256 id = seed % MAX_ARTWORKS + 1;
        (uint256 x, uint256 y, uint256 radius) = _flowerCenter(id);
        bytes memory center = bytes(
            string.concat(
                '<circle cx="', x.toString(), '" cy="', y.toString(), '" r="', radius.toString(), '" fill="#efb84c"/>'
            )
        );
        bytes memory artwork = _svg(renderer, 1, id);
        bytes memory receipt = _svg(renderer, 4, id);
        _assertFinalArtworkShape(artwork, center);
        _assertFinalArtworkShape(receipt, center);
        bytes memory artworkContents =
            Bytes.slice(artwork, Bytes.indexOf(artwork, ">") + 1, Bytes.lastIndexOf(artwork, "<"));
        assertTrue(_find(receipt, artworkContents, 0) != type(uint256).max);
    }

    function testFlowerCenterGeometryMappingIsUniqueAcrossFullSupply() public pure {
        uint256[896] memory seen;
        for (uint256 id = 1; id <= MAX_ARTWORK_RECEIPTS; ++id) {
            (uint256 x, uint256 y, uint256 radius) = _flowerCenter(id);
            assertTrue(x >= radius && y >= radius);
            assertTrue(x + radius <= 720 && y + radius <= 720);
            uint256 signature = (x - 264) / 3 | ((y - 202) / 2) << 6 | (radius - 24) << 12;
            uint256 mask = uint256(1) << (signature & 255);
            assertTrue(seen[signature >> 8] & mask == 0);
            seen[signature >> 8] |= mask;
        }
    }

    function testFuzzPhysicalReceiptUsesDistinctVisibleFlowerCenter(uint256 seed) public view {
        uint256 id = MAX_ARTWORKS + seed % MAX_ARTWORKS + 1;
        (uint256 x, uint256 y, uint256 radius) = _flowerCenter(id);
        bytes memory center = bytes(
            string.concat(
                '<circle cx="', x.toString(), '" cy="', y.toString(), '" r="', radius.toString(), '" fill="#efb84c"/>'
            )
        );
        _assertFinalArtworkShape(_svg(renderer, 4, id), center);
        assertTrue(keccak256(_svg(renderer, 4, id)) != keccak256(_svg(renderer, 4, id - MAX_ARTWORKS)));
    }

    function _svg(NFT111KRenderer source, uint8 kind, uint256 id) private pure returns (bytes memory svg) {
        bytes memory uri = bytes(source.tokenURI(kind, id));
        assertEq(string(Bytes.slice(uri, 0, 29)), "data:application/json;base64,");
        string memory metadata = string(Base64.decode(string(Bytes.slice(uri, 29))));
        bytes memory image = bytes(RendererVm(address(vm)).parseJsonString(metadata, ".image"));
        assertEq(string(Bytes.slice(image, 0, 26)), "data:image/svg+xml;base64,");
        svg = Base64.decode(string(Bytes.slice(image, 26)));
        assertTrue(svg.length <= 4 * 1024);
    }

    function _flowerCenter(uint256 id) private pure returns (uint256 x, uint256 y, uint256 radius) {
        uint256 key =
            (((id - 1) % MAX_ARTWORKS) * 65537 + 7919) % MAX_ARTWORKS + ((id - 1) / MAX_ARTWORKS) * MAX_ARTWORKS;
        x = 264 + 3 * (key % 64);
        y = 202 + 2 * ((key / 64) % 64);
        radius = 24 + key / 4096;
    }

    function _assertFinalArtworkShape(bytes memory svg, bytes memory shape) private pure {
        uint256 color = _find(svg, bytes("#efb84c"), 0);
        assertTrue(color != type(uint256).max);
        assertEq(_find(svg, bytes("#efb84c"), color + 1), type(uint256).max);
        uint256 position = _find(svg, shape, 0);
        assertTrue(position != type(uint256).max);
        assertEq(_find(svg, shape, position + 1), type(uint256).max);
        position += shape.length;
        while (position < svg.length) {
            position = Bytes.indexOf(svg, "<", position);
            assertTrue(position < svg.length - 1 && svg[position + 1] == "/");
            if (keccak256(Bytes.slice(svg, position, position + 6)) == keccak256(bytes("</svg>"))) return;
            position = Bytes.indexOf(svg, ">", position) + 1;
        }
        revert("missing closing SVG");
    }

    function _find(bytes memory haystack, bytes memory needle, uint256 start) private pure returns (uint256) {
        bytes32 expected = keccak256(needle);
        uint256 position = Bytes.indexOf(haystack, needle[0], start);
        while (position != type(uint256).max) {
            if (keccak256(Bytes.slice(haystack, position, position + needle.length)) == expected) return position;
            position = Bytes.indexOf(haystack, needle[0], position + 1);
        }
        return type(uint256).max;
    }
}
