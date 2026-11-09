pragma solidity 0.8.38;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport, Vm} from "./TestSupport.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract NFT111KMetadataTest is TestSupport {
    using Strings for uint256;

    string private constant BASE = "https://cdn.mons.shop/111k-sepolia/";
    NFT111K private token;

    function setUp() public {
        token = _deploy(BASE);
        token.setSaleActive(true);
    }

    function testCollectionUriSharedAcrossChainsAndIndependentOfTokenBaseUri() public {
        uint256[3] memory chains = [uint256(1), 11155111, 31337];
        string[3] memory prefixes = [
            "https://cdn.mons.shop/111k/mainnet-v1/",
            "https://cdn.mons.shop/111k-sepolia/v18/",
            "http://127.0.0.1:8788/111k/"
        ];
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            NFT111K deployed = _deploy(prefixes[i]);
            assertEq(deployed.contractURI(), "https://cdn.mons.shop/111k/collection.json");
            assertEq(deployed.previewTokenURI(1, 42), string.concat(prefixes[i], "42.json"));
            deployed.setBaseURI("https://cdn.mons.shop/111k/updated/");
            assertEq(deployed.contractURI(), "https://cdn.mons.shop/111k/collection.json");
            assertEq(deployed.previewTokenURI(1, 42), "https://cdn.mons.shop/111k/updated/42.json");
        }
    }

    function testEveryTokenRangeBoundaryUsesItsTokenId() public view {
        assertEq(token.baseURI(), BASE);
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
        _uri(6, 1, 117172);
        _uri(6, 18, 117189);
        _uri(7, 1, 3000001);
        _uri(7, 18, 3000018);
    }

    function testFuzzArtworkAndReceiptNamesShareArtworkId(uint256 seed) public view {
        uint256 artwork = seed % 111111 + 1;
        _uri(1, artwork, artwork);
        _uri(4, artwork, 1000000 + artwork);
    }

    function testInvalidKindsAndDisplayNumbersRevert() public {
        uint8[13] memory kinds = [uint8(0), 8, 1, 1, 2, 3, 4, 4, 5, 6, 6, 7, 7];
        uint256[13] memory ids = [uint256(1), 1, 0, 111112, 5556, 506, 0, 222223, 5556, 0, 19, 0, 19];
        for (uint256 i; i < kinds.length; ++i) {
            vm.expectRevert(NFT111K.InvalidMetadataItem.selector);
            token.previewTokenURI(kinds[i], ids[i]);
        }
    }

    function testMainnetAndLocalBaseUrisRemainSeparate() public {
        vm.chainId(1);
        NFT111K mainnet = _deploy("https://cdn.mons.shop/111k/");
        assertEq(mainnet.previewTokenURI(1, 42), "https://cdn.mons.shop/111k/42.json");
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        _deploy("http://127.0.0.1:8788/111k/");
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        mainnet.setBaseURI("http://127.0.0.1:8788/111k/");
        vm.chainId(11155111);
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        _deploy("http://127.0.0.1:8788/111k/");
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        token.setBaseURI("http://127.0.0.1:8788/111k/");
        vm.chainId(31337);
        NFT111K local = _deploy("http://127.0.0.1:8788/111k/");
        assertEq(local.previewTokenURI(4, 111112), "http://127.0.0.1:8788/111k/1111112.json");
        local.setBaseURI("http://localhost:8789/111k/");
        assertEq(local.previewTokenURI(1, 42), "http://localhost:8789/111k/42.json");
    }

    function testEveryBaseUriSchemeByteMustMatchExactly() public {
        vm.chainId(31337);
        string[2] memory uris = ["https://a/", "http://a/"];
        for (uint256 scheme; scheme < uris.length; ++scheme) {
            token.setBaseURI(uris[scheme]);
            bytes memory value = bytes(uris[scheme]);
            for (uint256 index; index < (scheme == 0 ? 8 : 7); ++index) {
                bytes1 original = value[index];
                for (uint256 replacement; replacement < 256; ++replacement) {
                    if (bytes1(uint8(replacement)) == original) continue;
                    value[index] = bytes1(uint8(replacement));
                    vm.expectRevert(NFT111K.InvalidBaseURI.selector);
                    token.setBaseURI(string(value));
                }
                value[index] = original;
            }
            assertEq(token.baseURI(), uris[scheme]);
        }
    }

    function testMalformedBaseUrisRevertInConstructorAndSetter() public {
        string[14] memory invalid = [
            "",
            "https://",
            "https:///",
            "https://cdn.mons.shop/111k",
            "ftp://cdn.mons.shop/111k/",
            "https://cdn.mons.shop/111k/?/",
            "https://cdn.mons.shop/111k/#/",
            "https://name@cdn.mons.shop/111k/",
            "https://cdn.mons.shop/111k /",
            "https://cdn.mons.shop/111k\\/",
            "https://cdn.mons.shop/111k\n/",
            "https://cdn.mons.shop/111k\x00/",
            "https://cdn.mons.shop/111k\x7f/",
            "https://cdn.mons.shop/111k\xc3\xa9/"
        ];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(NFT111K.InvalidBaseURI.selector);
            _deploy(invalid[i]);
            vm.expectRevert(NFT111K.InvalidBaseURI.selector);
            token.setBaseURI(invalid[i]);
            assertEq(token.baseURI(), BASE);
            _uri(2, 1, 111112);
        }
    }

    function testEveryBaseUriCharacterInConstructorAndSetter() public {
        for (uint256 character; character < 256; ++character) {
            string memory uri = string(bytes.concat(bytes(BASE), bytes1(uint8(character)), bytes("/")));
            if (
                character > 32 && character < 127 && character != 35 && character != 63 && character != 64
                    && character != 92
            ) {
                NFT111K deployed = _deploy(uri);
                assertEq(deployed.baseURI(), uri);
                assertEq(deployed.previewTokenURI(1, 42), string.concat(uri, "42.json"));
                token.setBaseURI(uri);
                assertEq(token.baseURI(), uri);
                assertEq(token.previewTokenURI(1, 42), string.concat(uri, "42.json"));
                token.setBaseURI(BASE);
            } else {
                vm.expectRevert(NFT111K.InvalidBaseURI.selector);
                _deploy(uri);
                vm.expectRevert(NFT111K.InvalidBaseURI.selector);
                token.setBaseURI(uri);
                assertEq(token.baseURI(), BASE);
            }
        }
    }

    function testLongBaseUriChecksItsFinalPathCharacters() public {
        bytes memory value = new bytes(1024);
        bytes memory prefix = bytes(BASE);
        for (uint256 i; i < prefix.length; ++i) {
            value[i] = prefix[i];
        }
        for (uint256 i = prefix.length; i < value.length - 1; ++i) {
            value[i] = "a";
        }
        value[value.length - 1] = "/";
        string memory uri = string(value);
        NFT111K deployed = _deploy(uri);
        assertEq(deployed.baseURI(), uri);
        token.setBaseURI(uri);
        assertEq(token.baseURI(), uri);
        assertEq(token.previewTokenURI(1, 42), string.concat(uri, "42.json"));
        bytes memory invalid = bytes.concat(value);
        invalid[invalid.length - 2] = "?";
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        _deploy(string(invalid));
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        token.setBaseURI(string(invalid));
        assertEq(token.baseURI(), uri);
    }

    function testOnlyOwnerCanChangeBaseURI() public {
        vm.prank(address(0xA110));
        vm.expectRevert();
        token.setBaseURI("https://cdn.mons.shop/111k/");
        assertEq(token.baseURI(), BASE);
    }

    function testUpdateChangesTokenAndAllPreviewUrlsWithoutChangingOwnership() public {
        address alice = address(0xA110);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        token.mintCrates{value: 0.0001 ether}(1);
        string memory replacement = "https://cdn.mons.shop/111k/";
        vm.recordLogs();
        token.setBaseURI(replacement);
        _assertUpdateLogs(vm.getRecordedLogs(), replacement);
        assertEq(token.baseURI(), replacement);
        assertEq(token.ownerOf(111112), alice);
        assertEq(token.totalSupply(), 1);
        assertEq(token.tokenURI(111112), "https://cdn.mons.shop/111k/111112.json");
        uint8[] memory kinds = new uint8[](7);
        uint256[] memory displayIds = new uint256[](7);
        uint256[7] memory tokenIds = [uint256(1), 111112, 116667, 1000001, 2000001, 117172, 3000001];
        for (uint256 i; i < kinds.length; ++i) {
            kinds[i] = uint8(i + 1);
            displayIds[i] = 1;
        }
        string[] memory uris = token.previewTokenURIs(kinds, displayIds);
        for (uint256 i; i < kinds.length; ++i) {
            assertEq(uris[i], string.concat(replacement, tokenIds[i].toString(), ".json"));
            assertEq(uris[i], token.previewTokenURI(kinds[i], displayIds[i]));
        }
    }

    function testSameBaseURIEmitsMetadataRefresh() public {
        vm.recordLogs();
        token.setBaseURI(BASE);
        _assertUpdateLogs(vm.getRecordedLogs(), BASE);
        assertEq(token.baseURI(), BASE);
        _uri(4, 222222, 1222222);
    }

    function _assertUpdateLogs(Vm.Log[] memory logs, string memory expectedBaseURI) private view {
        assertEq(logs.length, 2);
        assertEq(logs[0].emitter, address(token));
        assertEq(logs[0].topics.length, 1);
        assertEq(logs[0].topics[0], keccak256("BaseURIUpdated(string)"));
        assertEq(abi.decode(logs[0].data, (string)), expectedBaseURI);
        assertEq(logs[1].emitter, address(token));
        assertEq(logs[1].topics.length, 1);
        assertEq(logs[1].topics[0], keccak256("BatchMetadataUpdate(uint256,uint256)"));
        (uint256 first, uint256 last) = abi.decode(logs[1].data, (uint256, uint256));
        assertEq(first, 1);
        assertEq(last, 3000018);
    }

    function _deploy(string memory baseURI) private returns (NFT111K) {
        return new NFT111K(
            address(this),
            address(0x5151),
            address(0xBEEF),
            baseURI,
            bytes32(0),
            _proceedsRecipients(),
            _proceedsSharesBps(),
            new NFT111K.FreeMintAllocation[](0),
            5555
        );
    }

    function _uri(uint8 kind, uint256 displayId, uint256 tokenId) private view {
        assertEq(token.previewTokenURI(kind, displayId), string.concat(BASE, tokenId.toString(), ".json"));
    }
}
