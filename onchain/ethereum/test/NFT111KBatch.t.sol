pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract NFT111KBatchTest is TestSupport {
    NFT111K private token;
    address private constant ALICE = address(0xA110);
    address private constant BOB = address(0xB0B);
    uint256 private constant SIGNER_KEY = 0xA11CE;
    bytes32 private constant TRANSFER = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant UNBOXED = keccak256("CrateUnboxed(uint256,address,uint256,uint256)");
    bytes32 private constant BATCH_UNBOXED = keccak256("CratesUnboxed(address,bytes32,uint256,uint256)");

    function setUp() public {
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
        token = new NFT111K(
            address(this),
            vm.addr(SIGNER_KEY),
            payable(BOB),
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            _proceedsRecipients(),
            _proceedsSharesBps()
        );
        token.setSaleActive(true);
    }

    function testBatchLimitsAndRuntimeSize() public view {
        assertEq(token.MAX_UNBOX_QUANTITY(), 15);
        assertEq(token.MAX_TOKEN_INFO_BATCH_SIZE(), 150);
        assertEq(token.MAX_METADATA_BATCH_SIZE(), 30);
        assertTrue(address(token).code.length <= 24576);
    }

    function testFuzzBatchPreservesInputOrderAndArtworkIdentities(uint8 quantitySeed, uint8 orderSeed) public {
        uint256 quantity = quantitySeed % 15 + 1;
        _buyCrates(quantity);
        uint256[] memory ids = new uint256[](quantity);
        for (uint256 i; i < quantity; ++i) {
            ids[i] = 111112 + (i + orderSeed) % quantity;
        }
        vm.prank(ALICE);
        token.unboxCrates(ids);
        _assertBatch(ids, 1);
        assertEq(token.allocatedCrates(), quantity);
        assertEq(token.totalSupply(), quantity * 20);
        assertEq(token.balanceOf(ALICE), quantity * 20);
    }

    function testMaximumBatchWithBonusFirstMiddleAndLastAfterExistingArtworks() public {
        _buyCrates(15);
        for (uint256 remaining = 503; remaining != 0;) {
            uint256 quantity = remaining > 15 ? 15 : remaining;
            vm.prank(ALICE);
            token.mintWarehouses{value: quantity * 0.0011 ether}(quantity);
            remaining -= quantity;
        }
        _buyCrates(7);
        vm.prank(ALICE);
        token.unboxCrate(111126);
        uint256[3] memory positions = [uint256(0), 7, 14];
        for (uint256 j; j < positions.length; ++j) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory ids = new uint256[](15);
            uint256 next = 111112;
            for (uint256 i; i < ids.length; ++i) {
                ids[i] = i == positions[j] ? 116666 : next++;
            }
            uint256 supply = token.totalSupply();
            vm.recordLogs();
            vm.prank(ALICE);
            token.unboxCrates(ids);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            _assertBatch(ids, 21);
            assertEq(token.totalSupply(), supply + 311 - 15);
            assertEq(token.allocatedCrates(), 5555);
            assertEq(token.warehousesMinted(), 503);
            (,, uint256 artworks,,,,,,,,,) = token.stats(address(0));
            assertEq(artworks, 331);
            _assertSummary(logs[logs.length - 1], ids, 21, 311);
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function testBatchBurnsPrecedeMintsAndEventsPreserveInputOrder() public {
        _buyCrates(3);
        uint256[] memory ids = _range(111112, 3);
        ids[0] = 111114;
        ids[2] = 111112;
        vm.recordLogs();
        vm.prank(ALICE);
        token.unboxCrates(ids);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 67);
        for (uint256 i; i < ids.length; ++i) {
            _assertTransfer(logs[i], ALICE, address(0), ids[i]);
            for (uint256 j; j < 20; ++j) {
                _assertTransfer(logs[3 + i * 21 + j], address(0), ALICE, 1 + i * 20 + j);
            }
            Vm.Log memory unpacked = logs[3 + i * 21 + 20];
            assertEq(unpacked.emitter, address(token));
            assertEq(unpacked.topics.length, 3);
            assertEq(unpacked.topics[0], UNBOXED);
            assertEq(uint256(unpacked.topics[1]), ids[i]);
            assertEq(address(uint160(uint256(unpacked.topics[2]))), ALICE);
            (uint256 first, uint256 count) = abi.decode(unpacked.data, (uint256, uint256));
            assertEq(first, 1 + i * 20);
            assertEq(count, 20);
        }
        _assertSummary(logs[66], ids, 1, 60);
    }

    function testSingleOpeningRetainsItsExistingEventsAndBatchWorksWhilePaused() public {
        _buyCrates(2);
        token.setSaleActive(false);
        token.setRedemptionsPaused(true);
        vm.recordLogs();
        vm.prank(ALICE);
        token.unboxCrate(111112);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 22);
        assertEq(logs[logs.length - 1].topics[0], UNBOXED);
        vm.prank(ALICE);
        token.unboxCrates(_range(111113, 1));
        _assertBatch(_range(111113, 1), 21);
    }

    function testInvalidQuantitiesAndDuplicateCratesRevertAtomically() public {
        _buyCrates(15);
        _expectFailure(new uint256[](0), NFT111K.InvalidQuantity.selector);
        _expectFailure(_range(111112, 16), NFT111K.InvalidQuantity.selector);
        uint256[] memory ids = _range(111112, 3);
        ids[2] = ids[0];
        _expectFailure(ids, NFT111K.WrongOwner.selector);
        ids[1] = ids[0];
        _expectFailure(ids, NFT111K.WrongOwner.selector);
        assertEq(token.balanceOf(ALICE), 15);
        for (uint256 i; i < 15; ++i) {
            assertEq(token.ownerOf(111112 + i), ALICE);
        }
        vm.prank(ALICE);
        token.unboxCrates(_range(111112, 15));
        _assertBatch(_range(111112, 15), 1);
    }

    function testWrongOwnerApprovedOperatorKindsAndBurnedCratesCannotPartiallyOpen() public {
        _buyCrates(4);
        vm.prank(ALICE);
        token.mintWarehouses{value: 0.0011 ether}(1);
        vm.prank(ALICE);
        token.unboxCrate(111115);
        vm.prank(ALICE);
        token.transferFrom(ALICE, BOB, 111114);
        uint256[] memory ids = _range(111112, 2);
        uint256[6] memory invalid = [uint256(0), 111114, 111115, 116666, 116667, 1];
        for (uint256 i; i < invalid.length; ++i) {
            ids[1] = invalid[i];
            _expectFailure(ids, i >= 4 ? NFT111K.WrongItemKind.selector : NFT111K.WrongOwner.selector);
        }
        vm.prank(ALICE);
        token.setApprovalForAll(BOB, true);
        vm.prank(BOB);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxCrates(_range(111112, 2));
        assertEq(token.ownerOf(111112), ALICE);
        assertEq(token.ownerOf(111113), ALICE);
    }

    function testTokenInfoBatchPreservesAllKindsMissingBurnedAndDuplicatePositions() public {
        _buyCrates(4);
        vm.prank(ALICE);
        token.mintWarehouses{value: 0.0011 ether}(1);
        vm.prank(ALICE);
        token.unboxCrate(111112);
        uint256[] memory delivered = new uint256[](2);
        delivered[0] = 1;
        delivered[1] = 111113;
        _deliver(delivered);
        for (uint256 i; i < 2; ++i) {
            uint256[] memory invalid = _range(111114, 2);
            invalid[1] = i == 0 ? 1000001 : 2000002;
            vm.prank(ALICE);
            vm.expectRevert(NFT111K.WrongItemKind.selector);
            token.unboxCrates(invalid);
            assertEq(token.ownerOf(111114), ALICE);
        }
        uint256[] memory ids = new uint256[](150);
        uint256[12] memory samples =
            [uint256(2), 111114, 116667, 1000001, 2000002, 0, 1, 111112, 21, 117172, type(uint256).max, 2];
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = samples[i % samples.length];
        }
        NFT111K.TokenInfo[] memory infos = token.getTokenInfos(ids);
        assertEq(infos.length, ids.length);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint256 displayId, address holder) = token.getTokenInfo(ids[i]);
            assertEq(infos[i].kind, kind);
            assertEq(infos[i].displayId, displayId);
            assertEq(infos[i].holder, holder);
        }
        assertEq(token.getTokenInfos(new uint256[](0)).length, 0);
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.getTokenInfos(new uint256[](151));
    }

    function testMetadataBatchMatchesEveryKindAndPreservesDuplicatesAtLimit() public view {
        uint8[] memory kinds = new uint8[](30);
        uint256[] memory ids = new uint256[](30);
        for (uint256 i; i < ids.length; ++i) {
            kinds[i] = uint8(i % 6 + 1);
            ids[i] = kinds[i] == 6
                ? 30
                : kinds[i] == 3 ? 505 : kinds[i] == 2 || kinds[i] == 5 ? 5555 : kinds[i] == 4 ? 222222 : 111111;
        }
        string[] memory uris = token.previewTokenURIs(kinds, ids);
        assertEq(uris.length, ids.length);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(uris[i], token.previewTokenURI(kinds[i], ids[i]));
        }
        assertEq(token.previewTokenURIs(new uint8[](0), new uint256[](0)).length, 0);
    }

    function testMetadataBatchRejectsOversizeMismatchedAndInvalidPairs() public {
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.previewTokenURIs(new uint8[](31), new uint256[](31));
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.previewTokenURIs(new uint8[](1), new uint256[](0));
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.previewTokenURIs(new uint8[](0), new uint256[](1));
        uint8[] memory kinds = new uint8[](2);
        uint256[] memory ids = new uint256[](2);
        kinds[0] = 1;
        ids[0] = 42;
        uint8[9] memory invalidKinds = [uint8(0), 7, 1, 2, 3, 4, 5, 6, 6];
        uint256[9] memory invalidIds = [uint256(1), 1, 0, 5556, 506, 222223, 5556, 0, 31];
        for (uint256 i; i < invalidKinds.length; ++i) {
            kinds[1] = invalidKinds[i];
            ids[1] = invalidIds[i];
            vm.expectRevert(NFT111K.InvalidMetadataItem.selector);
            token.previewTokenURIs(kinds, ids);
        }
    }

    function testMetadataBatchWorstFixtureFitsResponseAndCallGasBudgets() public view {
        uint8[] memory kinds = new uint8[](30);
        uint256[] memory ids = new uint256[](30);
        for (uint256 i; i < ids.length; ++i) {
            kinds[i] = 4;
            ids[i] = 111111;
        }
        uint256 beforeGas = gasleft();
        string[] memory uris = token.previewTokenURIs(kinds, ids);
        assertTrue(beforeGas - gasleft() < 25000000);
        assertTrue(2 * abi.encode(uris).length + 1024 < 512 * 1024);
        assertEq(uris.length, 30);
    }

    function _assertBatch(uint256[] memory ids, uint256 firstToken) private view {
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,, address holder) = token.getTokenInfo(ids[i]);
            assertEq(kind, 0);
            assertEq(holder, address(0));
            uint256 count = ids[i] == 116666 ? 31 : 20;
            uint256 firstDisplayId = firstToken;
            for (uint256 j; j < count; ++j) {
                uint256 displayId;
                (kind, displayId, holder) = token.getTokenInfo(firstToken + j);
                assertEq(kind, 1);
                assertEq(displayId, firstDisplayId + j);
                assertEq(holder, ALICE);
            }
            assertEq(token.tokenURI(firstToken), token.previewTokenURI(1, firstDisplayId));
            firstToken += count;
        }
    }

    function _expectFailure(uint256[] memory ids, bytes4 reason) private {
        bytes32 state = _state();
        vm.prank(ALICE);
        vm.expectRevert(reason);
        token.unboxCrates(ids);
        assertEq(_state(), state);
        assertEq(token.ownerOf(111112), ALICE);
    }

    function _state() private view returns (bytes32) {
        (uint256 allocations, uint256 warehouses, uint256 artworks,,,,,,,,,) = token.stats(address(0));
        return keccak256(abi.encode(allocations, warehouses, artworks, token.totalSupply(), token.balanceOf(ALICE)));
    }

    function _assertTransfer(Vm.Log memory log, address from, address to, uint256 id) private view {
        assertEq(log.emitter, address(token));
        assertEq(log.topics.length, 4);
        assertEq(log.topics[0], TRANSFER);
        assertEq(address(uint160(uint256(log.topics[1]))), from);
        assertEq(address(uint160(uint256(log.topics[2]))), to);
        assertEq(uint256(log.topics[3]), id);
        assertEq(log.data.length, 0);
    }

    function _assertSummary(Vm.Log memory log, uint256[] memory ids, uint256 first, uint256 count) private view {
        assertEq(log.emitter, address(token));
        assertEq(log.topics.length, 3);
        assertEq(log.topics[0], BATCH_UNBOXED);
        assertEq(address(uint160(uint256(log.topics[1]))), ALICE);
        assertEq(log.topics[2], keccak256(abi.encode(ids)));
        (uint256 actualFirst, uint256 actualCount) = abi.decode(log.data, (uint256, uint256));
        assertEq(actualFirst, first);
        assertEq(actualCount, count);
    }

    function _buyCrates(uint256 quantity) private {
        vm.prank(ALICE);
        token.mintCrates{value: quantity * 0.0001 ether}(quantity);
    }

    function _range(uint256 first, uint256 count) private pure returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = first + i;
        }
    }

    function _deliver(uint256[] memory ids) private {
        uint256[] memory receipts = new uint256[](2);
        receipts[0] = 1000001;
        receipts[1] = 2000002;
        NFT111K.DeliveryQuote memory quote =
            NFT111K.DeliveryQuote(1, ALICE, 0, block.timestamp + 300, keccak256(abi.encode(receipts)));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("111K"),
                keccak256("2"),
                block.chainid,
                address(token)
            )
        );
        bytes32 digest = keccak256(
            abi.encode(
                keccak256(
                    "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)"
                ),
                quote.wallet,
                keccak256(abi.encode(ids)),
                quote.receiptIdsHash,
                quote.orderId,
                quote.fee,
                quote.deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, keccak256(abi.encodePacked(hex"1901", domain, digest)));
        vm.prank(ALICE);
        token.redeemForDelivery(ids, quote, abi.encodePacked(r, s, v));
    }
}
