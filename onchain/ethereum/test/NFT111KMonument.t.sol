pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport, Vm} from "./TestSupport.sol";
import {SecurityCollection, SecurityReceiver, SecurityCall, SecurityVm} from "./NFT111KSecurity.t.sol";

contract NFT111KMonumentTest is TestSupport {
    NFT111K private token;
    address private constant ALICE = address(0xA110);
    address private constant BOB = address(0xB0B);

    function setUp() public {
        token = new SecurityCollection(
            address(this),
            address(0x5151),
            payable(address(0xFEE)),
            "https://cdn.mons.shop/111k-sepolia/",
            _proceedsRecipients(),
            _proceedsSharesBps()
        );
        token.setSaleActive(true);
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
    }

    function testPurchaseAndOpeningEmitExactReservations() public {
        vm.recordLogs();
        _mint(2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory purchase = logs[logs.length - 1];
        assertEq(purchase.topics[0], keccak256("MonumentsPurchased(address,uint256,uint256,uint256)"));
        assertEq(purchase.topics[1], bytes32(uint256(uint160(ALICE))));
        (uint256 first, uint256 quantity, uint256 paid) = abi.decode(purchase.data, (uint256, uint256, uint256));
        assertEq(first, 117172);
        assertEq(quantity, 2);
        assertEq(paid, 0.0176 ether);
        vm.recordLogs();
        vm.prank(ALICE);
        token.unboxMonument(117173);
        logs = vm.getRecordedLogs();
        Vm.Log memory opening = logs[logs.length - 1];
        assertEq(opening.topics[0], keccak256("MonumentUnboxed(uint256,address,uint256,uint256)"));
        assertEq(opening.topics[1], bytes32(uint256(117173)));
        assertEq(opening.topics[2], bytes32(uint256(uint160(ALICE))));
        (first, quantity) = abi.decode(opening.data, (uint256, uint256));
        assertEq(first, 111223);
        assertEq(quantity, 111);
    }

    function testMixedReservationsAndReverseOpeningAreDistinct() public {
        vm.startPrank(ALICE);
        token.mintCrates{value: 0.0002 ether}(2);
        token.mintMonuments{value: 0.0176 ether}(2);
        token.mintWarehouses{value: 0.0011 ether}(1);
        token.mintCrates{value: 0.0001 ether}(1);
        token.transferFrom(ALICE, BOB, 117173);
        vm.stopPrank();
        assertEq(token.allocatedCrates(), 236);
        assertEq(token.monumentFirstCrate(1), 3);
        assertEq(token.monumentFirstCrate(2), 114);
        assertEq(token.warehouseFirstCrate(1), 225);
        _info(117172, 6, 1, ALICE);
        _info(117173, 6, 2, BOB);
        _info(111347, 2, 236, ALICE);
        vm.prank(BOB);
        token.unboxMonument(117173);
        _crates(114, 111, BOB);
        _info(117173, 0, 0, address(0));
        vm.startPrank(ALICE);
        token.unboxWarehouse(116667);
        token.unboxMonument(117172);
        vm.stopPrank();
        _crates(3, 111, ALICE);
        _crates(225, 11, ALICE);
        assertEq(token.allocatedCrates(), 236);
        assertEq(token.monumentsMinted(), 2);
        assertEq(token.totalSupply(), 236);
    }

    function testLifetimeCapStaysConsumedAfterOpening() public {
        _mint(15);
        _mint(3);
        assertEq(token.monumentsMinted(), 18);
        assertEq(token.allocatedCrates(), 1998);
        assertEq(token.remainingCrates(), 3557);
        _info(117189, 6, 18, ALICE);
        vm.prank(ALICE);
        token.unboxMonument(117172);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintMonuments{value: 0.0088 ether}(1);
        _consume(3557);
        assertEq(token.warehousesMinted(), 323);
        _crates(5552, 4, ALICE);
        assertEq(token.remainingCrates(), 0);
        assertEq(token.monumentsMinted(), 18);
    }

    function testBatchCannotExceedRemainingMonumentSlots() public {
        _mint(15);
        _mint(2);
        uint256 received = token.totalMintReceived();
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintMonuments{value: 0.0176 ether}(2);
        assertEq(token.monumentsMinted(), 17);
        assertEq(token.allocatedCrates(), 1887);
        assertEq(token.totalMintReceived(), received);
        assertEq(token.monumentFirstCrate(18), 0);
        _mint(1);
    }

    function testExactly111RemainingCanMintAndFinalCrateRetains31Artworks() public {
        _consume(5444);
        assertEq(token.remainingCrates(), 111);
        _mint(1);
        vm.startPrank(ALICE);
        token.unboxMonument(117172);
        token.unboxCrate(116666);
        vm.stopPrank();
        assertEq(token.remainingCrates(), 0);
        _info(31, 1, 31, ALICE);
        _info(32, 0, 0, address(0));
        _crates(5445, 110, ALICE);
    }

    function testBelow111RemainingAndInsufficientBatchReject() public {
        _consume(5334);
        assertEq(token.remainingCrates(), 221);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintMonuments{value: 0.0176 ether}(2);
        _mint(1);
        assertEq(token.remainingCrates(), 110);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintMonuments{value: 0.0088 ether}(1);
        _consume(110);
        assertEq(token.remainingCrates(), 0);
    }

    function testMintValidationAndIndependentOwnerPrice() public {
        vm.startPrank(ALICE);
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.mintMonuments(0);
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.mintMonuments{value: 0.1408 ether}(16);
        vm.expectRevert(NFT111K.WrongPayment.selector);
        token.mintMonuments{value: 0.0087 ether}(1);
        vm.expectRevert(NFT111K.WrongPayment.selector);
        token.mintMonuments{value: 0.0089 ether}(1);
        vm.expectRevert();
        token.setPrices(1, 11, 0, 88);
        vm.stopPrank();
        token.setSaleActive(false);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintMonuments{value: 0.0088 ether}(1);
        token.setPrices(1, 11, 0, 7);
        assertEq(token.monumentPrice(), 7);
        token.setSaleActive(true);
        vm.prank(ALICE);
        token.mintMonuments{value: 7}(1);
        (,,,,,,,,,, uint256 minted, uint256 price) = token.stats(ALICE);
        assertEq(minted, 1);
        assertEq(price, 7);
        assertEq(token.totalMintReceived(), 7);
        token.releaseMint(token.mintRecipients(0));
        assertEq(token.mintRecipients(0).balance, 3);
    }

    function testOpeningChecksOwnershipKindAndCannotRepeat() public {
        _mint(1);
        vm.prank(BOB);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxMonument(117172);
        vm.prank(ALICE);
        token.mintWarehouses{value: 0.0011 ether}(1);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.unboxMonument(116667);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.unboxWarehouse(117172);
        token.setSaleActive(false);
        vm.prank(ALICE);
        token.unboxMonument(117172);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxMonument(117172);
        vm.expectRevert();
        token.tokenURI(117172);
    }

    function testMintCallbacksObserveFinalCountersAndRejectEveryProtectedReentry() public {
        SecurityReceiver buyer = _receiver();
        buyer.expectPurchaseTotals(333, 0, 0);
        buyer.expectMonumentCount(3);
        buyer.expectProceeds(0.0264 ether, 0);
        buyer.configureAttacks(_attacks());
        buyer.execute(abi.encodeCall(token.mintMonuments, (3)), 0.0264 ether);
        assertEq(buyer.callbacks(), 3);
        assertEq(buyer.blockedCalls(), 39);
        assertEq(token.monumentFirstCrate(3), 223);
    }

    function testOpening111CallbacksSeeBurnedSourceAndRejectEveryProtectedReentry() public {
        SecurityReceiver buyer = _receiver();
        buyer.execute(abi.encodeCall(token.mintMonuments, (1)), 0.0088 ether);
        buyer.configure(0, false, address(0));
        uint256[] memory source = new uint256[](1);
        source[0] = 117172;
        buyer.expectUnboxSources(source);
        buyer.expectPurchaseTotals(111, 0, 0);
        buyer.expectMonumentCount(1);
        buyer.expectProceeds(0.0088 ether, 0);
        buyer.configureAttacks(_attacks());
        buyer.execute(abi.encodeCall(token.unboxMonument, (117172)), 0);
        assertEq(buyer.callbacks(), 111);
        assertEq(buyer.blockedCalls(), 1443);
        assertEq(buyer.sourceTransferFailures(), 111);
        _crates(1, 111, address(buyer));
    }

    function testMintReceiverRejectionsRollbackAndRetry() public {
        _rejections(false);
    }

    function testOpeningReceiverRejectionsRollbackAll111CratesAndRetry() public {
        _rejections(true);
    }

    function testReceiverMayTransferEachFreshMonumentAndCrate() public {
        SecurityReceiver buyer = _receiver();
        buyer.configure(0, false, ALICE);
        buyer.execute(abi.encodeCall(token.mintMonuments, (1)), 0.0088 ether);
        _info(117172, 6, 1, ALICE);
        vm.prank(ALICE);
        token.transferFrom(ALICE, address(buyer), 117172);
        buyer.configure(0, false, BOB);
        buyer.execute(abi.encodeCall(token.unboxMonument, (117172)), 0);
        _crates(1, 111, BOB);
        assertEq(token.balanceOf(address(buyer)), 0);
    }

    function _rejections(bool opening) private {
        SecurityReceiver buyer = _receiver();
        if (opening) buyer.execute(abi.encodeCall(token.mintMonuments, (1)), 0.0088 ether);
        bytes memory call_ =
            opening ? abi.encodeCall(token.unboxMonument, (117172)) : abi.encodeCall(token.mintMonuments, (3));
        uint256 value = opening ? 0 : 0.0264 ether;
        uint256 count = opening ? 111 : 3;
        uint256[3] memory positions = [uint256(1), count / 2 + 1, count];
        uint256 balance = address(buyer).balance;
        for (uint256 i; i < 4; ++i) {
            uint256 position = positions[i % 3];
            buyer.configure(position, i == 3, address(0));
            if (i == 3) {
                vm.expectRevert(bytes4(keccak256("TransferToNonERC721ReceiverImplementer()")));
            } else {
                SecurityVm(address(vm))
                    .expectRevert(abi.encodeWithSelector(SecurityReceiver.ReceiverRejected.selector, position));
            }
            buyer.execute(call_, value);
            assertEq(token.allocatedCrates(), opening ? 111 : 0);
            assertEq(token.monumentsMinted(), opening ? 1 : 0);
            assertEq(token.totalMintReceived(), opening ? 0.0088 ether : 0);
            assertEq(token.totalSupply(), opening ? 1 : 0);
            assertEq(token.monumentFirstCrate(1), opening ? 1 : 0);
            assertEq(token.monumentFirstCrate(2), 0);
            assertEq(address(buyer).balance, balance);
            assertEq(buyer.callbacks(), 0);
            for (uint256 id = 111112; id < 111223; ++id) {
                _info(id, 0, 0, address(0));
            }
            _info(117172, opening ? 6 : 0, opening ? 1 : 0, opening ? address(buyer) : address(0));
        }
        buyer.configure(0, false, address(0));
        buyer.execute(call_, value);
        assertEq(buyer.callbacks(), count);
        if (opening) _crates(1, 111, address(buyer));
        else _info(117174, 6, 3, address(buyer));
    }

    function _attacks() private view returns (SecurityCall[] memory calls) {
        calls = new SecurityCall[](13);
        calls[0] = SecurityCall(abi.encodeCall(token.mintCrates, (1)), token.cratePrice());
        calls[1] = SecurityCall(abi.encodeCall(token.mintWarehouses, (1)), token.warehousePrice());
        calls[2] = SecurityCall(abi.encodeCall(token.mintMonuments, (1)), token.monumentPrice());
        calls[3] =
            SecurityCall(abi.encodeCall(token.mintCratesDiscounted, (1, new bytes32[](0))), token.discountCratePrice());
        calls[4] = SecurityCall(abi.encodeCall(token.unboxCrate, (111112)), 0);
        calls[5] = SecurityCall(abi.encodeCall(token.unboxWarehouse, (116667)), 0);
        calls[6] = SecurityCall(abi.encodeCall(token.unboxMonument, (117172)), 0);
        calls[7] = SecurityCall(abi.encodeCall(token.unboxCrates, (new uint256[](0))), 0);
        NFT111K.DeliveryQuote memory quote;
        calls[8] = SecurityCall(abi.encodeCall(token.redeemForDelivery, (new uint256[](0), quote, bytes(""))), 0);
        calls[9] = SecurityCall(abi.encodeCall(token.claimCrateReceipt, (2000001, bytes32(0), 0, bytes(""))), 0);
        calls[10] = SecurityCall(abi.encodeCall(token.releaseMint, (token.mintRecipients(0))), 0);
        calls[11] = SecurityCall(abi.encodeCall(token.releaseDelivery, ()), 0);
        calls[12] = SecurityCall(abi.encodeCall(token.releaseAllMint, ()), 0);
    }

    function _receiver() private returns (SecurityReceiver buyer) {
        buyer = new SecurityReceiver(token);
        vm.deal(address(buyer), 100 ether);
    }

    function _mint(uint256 count) private {
        uint256 value = token.monumentPrice() * count;
        vm.prank(ALICE);
        token.mintMonuments{value: value}(count);
    }

    function _consume(uint256 crates) private {
        vm.startPrank(ALICE);
        while (crates >= 11) {
            uint256 quantity = crates / 11;
            if (quantity > 15) quantity = 15;
            token.mintWarehouses{value: quantity * 0.0011 ether}(quantity);
            crates -= quantity * 11;
        }
        if (crates != 0) token.mintCrates{value: crates * 0.0001 ether}(crates);
        vm.stopPrank();
    }

    function _crates(uint256 first, uint256 count, address holder) private view {
        for (uint256 i; i < count; ++i) {
            _info(111111 + first + i, 2, first + i, holder);
        }
    }

    function _info(uint256 id, uint8 kind, uint256 number, address holder) private view {
        (uint8 actualKind, uint256 actualNumber, address actualHolder) = token.getTokenInfo(id);
        assertEq(actualKind, kind);
        assertEq(actualNumber, number);
        assertEq(actualHolder, holder);
        if (kind != 0) assertEq(token.tokenURI(id), token.previewTokenURI(kind, number));
    }
}
