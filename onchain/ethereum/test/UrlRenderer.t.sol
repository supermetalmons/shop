pragma solidity 0.8.30;

import {NFT111KUrlRenderer} from "../src/NFT111KUrlRenderer.sol";
import {TestSupport} from "./TestSupport.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract NFT111KUrlRendererTest is TestSupport {
    using Strings for uint256;

    string private constant BASE = "https://cdn.mons.shop/111k-sepolia/";
    NFT111KUrlRenderer private renderer;

    function setUp() public {
        renderer = new NFT111KUrlRenderer(BASE);
    }

    function testEveryTokenRangeBoundaryUsesItsTokenId() public view {
        assertEq(renderer.baseURI(), BASE);
        _uri(1, 1, 1);
        _uri(1, 111111, 111111);
        _uri(2, 1, 111112);
        _uri(2, 5555, 116666);
        _uri(3, 1, 116667);
        _uri(3, 505, 117171);
        _uri(4, 1, 1000001);
        _uri(4, 111111, 1111111);
        _uri(4, 111112, 1111112);
        _uri(4, 222222, 1222222);
        _uri(5, 1, 2000001);
        _uri(5, 5555, 2005555);
    }

    function testFuzzArtworkAndReceiptNamesShareArtworkId(uint256 seed) public view {
        uint256 artwork = seed % 111111 + 1;
        _uri(1, artwork, artwork);
        _uri(4, artwork, 1000000 + artwork);
    }

    function testInvalidKindsAndDisplayNumbersRevert() public {
        uint8[9] memory kinds = [uint8(0), 6, 1, 1, 2, 3, 4, 4, 5];
        uint256[9] memory ids = [uint256(1), 1, 0, 111112, 5556, 506, 0, 222223, 5556];
        for (uint256 i; i < kinds.length; ++i) {
            vm.expectRevert(NFT111KUrlRenderer.InvalidItem.selector);
            renderer.tokenURI(kinds[i], ids[i]);
        }
    }

    function testMainnetAndLocalBaseUrisRemainSeparate() public {
        vm.chainId(1);
        NFT111KUrlRenderer mainnet = new NFT111KUrlRenderer("https://cdn.mons.shop/111k/");
        assertEq(mainnet.tokenURI(1, 42), "https://cdn.mons.shop/111k/42.json");
        vm.expectRevert(NFT111KUrlRenderer.InvalidBaseURI.selector);
        new NFT111KUrlRenderer("http://127.0.0.1:8788/111k/");
        vm.chainId(31337);
        NFT111KUrlRenderer local = new NFT111KUrlRenderer("http://127.0.0.1:8788/111k/");
        assertEq(local.tokenURI(4, 111112), "http://127.0.0.1:8788/111k/1111112.json");
    }

    function testMalformedBaseUrisRevert() public {
        string[9] memory invalid = [
            "",
            "https://",
            "https:///",
            "https://cdn.mons.shop/111k",
            "ftp://cdn.mons.shop/111k/",
            "https://cdn.mons.shop/111k/?/",
            "https://cdn.mons.shop/111k/#/",
            "https://name@cdn.mons.shop/111k/",
            "https://cdn.mons.shop/111k /"
        ];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(NFT111KUrlRenderer.InvalidBaseURI.selector);
            new NFT111KUrlRenderer(invalid[i]);
        }
    }

    function _uri(uint8 kind, uint256 displayId, uint256 tokenId) private view {
        assertEq(renderer.tokenURI(kind, displayId), string.concat(BASE, tokenId.toString(), ".json"));
    }
}
