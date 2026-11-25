pragma solidity 0.8.38;

import {DMXWebpRenderer} from "../src/DMXWebpRenderer.sol";
import {IDMXRenderer, IDMXTokenInfo} from "../src/IDMXRenderer.sol";
import {TestSupport, Vm} from "./TestSupport.sol";
import {DMXTestSupport} from "./DMXTestSupport.sol";
import {TarotCards} from "../src/TarotCards.sol";

contract DMXRendererCollection is IDMXTokenInfo {
    mapping(uint256 => TokenInfo) private infos;

    function set(uint256 tokenId, TokenInfo calldata info) external { infos[tokenId] = info; }

    function getTokenInfo(uint256 tokenId) external view returns (TokenInfo memory) {
        require(infos[tokenId].cardId != 0, "Unknown token");
        return infos[tokenId];
    }
}

contract DMXFutureRenderer is IDMXRenderer {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == type(IDMXRenderer).interfaceId;
    }

    function tokenURI(address collection, uint256 tokenId) external view returns (string memory) {
        IDMXTokenInfo.TokenInfo memory info = IDMXTokenInfo(collection).getTokenInfo(tokenId);
        require(info.kind != IDMXTokenInfo.TokenKind.None);
        return 'data:application/json,{"image":"data:image/svg+xml,<svg/>","animation_url":"data:text/html,<html></html>"}';
    }

    function contractURI(address) external pure returns (string memory) { return "ipfs://future-collection"; }
}

contract DMXInvalidERC165 {
    function supportsInterface(bytes4) external pure returns (bool) { return true; }
}

contract DMXRevertingERC165 {
    function supportsInterface(bytes4) external pure returns (bool) { revert(); }
}

contract DMXRendererIntegrationTest is DMXTestSupport {
    function testRendererSwapSupportsFutureSvgHtmlAndRefreshesAllMetadata() public {
        _claim(ALICE, 1);
        DMXFutureRenderer next = new DMXFutureRenderer();
        vm.recordLogs();
        token.setRenderer(address(next));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        assertEq(logs[0].topics[0], keccak256("RendererUpdated(address,address)"));
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(address(renderer)))));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(address(next)))));
        assertEq(logs[1].topics[0], keccak256("BatchMetadataUpdate(uint256,uint256)"));
        (uint256 first, uint256 last) = abi.decode(logs[1].data, (uint256, uint256));
        assertEq(first, 1);
        assertEq(last, 2_000_775);
        assertEq(logs[2].topics[0], keccak256("ContractURIUpdated()"));
        assertEq(token.renderer(), address(next));
        assertEq(token.tokenURI(1), next.tokenURI(address(token), 1));
        assertEq(token.contractURI(), "ipfs://future-collection");
        assertEq(token.ownerOf(1), ALICE);
        assertEq(token.ownerOf(1_000_000), ALICE);
        assertTrue(token.supportsInterface(0x49064906));
    }

    function testRendererAndRefreshChangesRequireOwnerAndValidTargets() public {
        DMXWebpRenderer next = new DMXWebpRenderer();
        vm.prank(ALICE);
        vm.expectRevert();
        token.setRenderer(address(next));
        address[5] memory invalid = [address(0), ALICE, address(token), address(new DMXInvalidERC165()), address(new DMXRevertingERC165())];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(TarotCards.InvalidRenderer.selector);
            token.setRenderer(invalid[i]);
            assertEq(token.renderer(), address(renderer));
        }
        DMXRendererCollection unsupported = new DMXRendererCollection();
        vm.expectRevert(TarotCards.InvalidRenderer.selector);
        token.setRenderer(address(unsupported));
        vm.prank(ALICE);
        vm.expectRevert();
        token.refreshMetadata(1, 2_000_775);
        vm.prank(ALICE);
        vm.expectRevert();
        token.refreshContractMetadata();
    }

    function testOwnerRefreshBoundsAndCollectionEvent() public {
        vm.recordLogs();
        token.refreshMetadata(1_000_000, 2_000_775);
        token.refreshContractMetadata();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], keccak256("BatchMetadataUpdate(uint256,uint256)"));
        (uint256 first, uint256 last) = abi.decode(logs[0].data, (uint256, uint256));
        assertEq(first, 1_000_000);
        assertEq(last, 2_000_775);
        assertEq(logs[1].topics[0], keccak256("ContractURIUpdated()"));
        vm.expectRevert(TarotCards.InvalidTokenId.selector);
        token.refreshMetadata(0, 1);
        vm.expectRevert(TarotCards.InvalidTokenId.selector);
        token.refreshMetadata(2, 1);
        vm.expectRevert(TarotCards.InvalidTokenId.selector);
        token.refreshMetadata(1, 2_000_776);
    }

    function testWebpRendererUsesActualCollectionProvenanceAfterBurn() public {
        DMXWebpRenderer next = new DMXWebpRenderer();
        token.setRenderer(address(next));
        _claim(ALICE, 1);
        token.setRedemptionsPaused(false);
        _redeem(_one(1), _one(778), _quote(ALICE, BOB, 7, 0, 0));
        vm.expectRevert();
        token.tokenURI(1);
        vm.expectRevert();
        token.tokenURI(2);
        IDMXTokenInfo.TokenInfo memory source = token.getTokenInfo(1);
        assertTrue(source.burned);
        assertEq(source.redeemedByOrder, 7);
        assertEq(token.tokenURI(1_000_777), next.tokenURI(address(token), 1_000_777));
        assertEq(token.tokenURI(778), next.tokenURI(address(token), 778));
        assertEq(token.ownerOf(1_000_000), ALICE);
        assertEq(token.ownerOf(1_000_777), BOB);
    }
}

contract DMXWebpRendererTest is TestSupport {
    DMXWebpRenderer private renderer;
    DMXRendererCollection private collection;

    function setUp() public {
        renderer = new DMXWebpRenderer();
        collection = new DMXRendererCollection();
    }

    function _decode(string memory uri) private pure returns (string memory) {
        bytes memory data = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        require(data.length >= prefix.length && (data.length - prefix.length) % 4 == 0);
        for (uint256 i; i < prefix.length; ++i) require(data[i] == prefix[i]);
        uint256 size = (data.length - prefix.length) / 4 * 3;
        if (data[data.length - 1] == "=") --size;
        if (data[data.length - 2] == "=") --size;
        bytes memory decoded = new bytes(size);
        uint256 buffer;
        uint256 bits;
        uint256 index;
        for (uint256 i = prefix.length; i < data.length && data[i] != "="; ++i) {
            uint8 character = uint8(data[i]);
            uint256 value;
            if (character >= 65 && character <= 90) value = character - 65;
            else if (character >= 97 && character <= 122) value = character - 71;
            else if (character >= 48 && character <= 57) value = character + 4;
            else if (character == 43) value = 62;
            else { require(character == 47); value = 63; }
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) { bits -= 8; decoded[index++] = bytes1(uint8(buffer >> bits)); }
        }
        return string(decoded);
    }

    function testInitialCardAndNfcMetadataKeepExistingArtworkAndDescriptions() public {
        collection.set(1, IDMXTokenInfo.TokenInfo(IDMXTokenInfo.TokenKind.Card, 1, 0, 0, 0, false));
        collection.set(1_000_000, IDMXTokenInfo.TokenInfo(IDMXTokenInfo.TokenKind.NFCReceipt, 1, 0, 0, 0, false));
        string memory card = _decode(renderer.tokenURI(address(collection), 1));
        assertEq(vm.parseJsonString(card, ".name"), "Tarot Card #1");
        assertEq(vm.parseJsonString(card, ".description"), "A mutating Tarot card. Initial base artwork.");
        assertEq(vm.parseJsonString(card, ".image"), "https://wip.lil.org/tarot/bases/1.webp");
        assertEq(vm.parseJsonString(card, ".attributes[0].value"), "Mutating Card");
        assertEq(vm.parseJsonUint(card, ".attributes[1].value"), 1);
        string memory receipt = _decode(renderer.tokenURI(address(collection), 1_000_000));
        assertEq(vm.parseJsonString(receipt, ".name"), "Tarot Card Receipt #1");
        assertEq(vm.parseJsonString(receipt, ".description"), "Proves the authenticity of the physical Tarot card you scanned.");
        assertEq(vm.parseJsonString(receipt, ".image"), "https://wip.lil.org/tarot/receipts/1.webp");
        assertEq(vm.parseJsonString(receipt, ".attributes[0].value"), "NFC Card Receipt");
    }

    function testFutureCardsAndRedemptionReceiptsUseSourceProvenance() public {
        collection.set(999_999, IDMXTokenInfo.TokenInfo(IDMXTokenInfo.TokenKind.Card, 999_999, 7, 42, 43, true));
        collection.set(2_000_775, IDMXTokenInfo.TokenInfo(IDMXTokenInfo.TokenKind.RedemptionReceipt, 999_999, 7, 42, 43, false));
        string memory card = _decode(renderer.tokenURI(address(collection), 999_999));
        assertEq(vm.parseJsonString(card, ".image"), "https://wip.lil.org/tarot/bases/999999.webp");
        assertEq(vm.parseJsonUint(card, ".attributes[2].value"), 7);
        assertEq(vm.parseJsonString(card, ".attributes[3].value"), "42");
        string memory receipt = _decode(renderer.tokenURI(address(collection), 2_000_775));
        assertEq(vm.parseJsonString(receipt, ".name"), "DMX Redemption Receipt #999999");
        assertEq(vm.parseJsonString(receipt, ".image"), "https://wip.lil.org/tarot/receipts/999999.webp");
        assertEq(vm.parseJsonString(receipt, ".attributes[0].value"), "Redemption Receipt");
        assertEq(vm.parseJsonString(receipt, ".attributes[4].value"), "43");
    }

    function testOrderReferencesPreserveTheFullUint256RangeAsStrings() public {
        collection.set(1_001_554, IDMXTokenInfo.TokenInfo(
            IDMXTokenInfo.TokenKind.RedemptionReceipt, 778, 1, 9_007_199_254_740_993, type(uint256).max, false
        ));
        string memory metadata = _decode(renderer.tokenURI(address(collection), 1_001_554));
        assertEq(vm.parseJsonUint(metadata, ".attributes[2].value"), 1);
        assertEq(vm.parseJsonString(metadata, ".attributes[3].value"), "9007199254740993");
        assertEq(vm.parseJsonString(metadata, ".attributes[4].value"),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935");
    }

    function testCollectionMetadataAndInterface() public view {
        string memory metadata = _decode(renderer.contractURI(address(collection)));
        assertEq(vm.parseJsonString(metadata, ".name"), "divination machina x");
        assertEq(vm.parseJsonString(metadata, ".symbol"), "DMX");
        assertEq(vm.parseJsonString(metadata, ".image"), "https://wip.lil.org/tarot/bases/1.webp");
        assertTrue(renderer.supportsInterface(type(IDMXRenderer).interfaceId));
        assertTrue(renderer.supportsInterface(0x01ffc9a7));
        assertFalse(renderer.supportsInterface(0xffffffff));
    }

    function testUnknownTokensAndUnsupportedKindsRevert() public {
        vm.expectRevert();
        renderer.tokenURI(address(collection), 0);
        collection.set(1, IDMXTokenInfo.TokenInfo(IDMXTokenInfo.TokenKind.None, 1, 0, 0, 0, false));
        vm.expectRevert(DMXWebpRenderer.InvalidTokenKind.selector);
        renderer.tokenURI(address(collection), 1);
    }
}
