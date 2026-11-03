pragma solidity 0.8.38;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport, Vm, NFT111KStats} from "./TestSupport.sol";

contract RelicReceiver {
    NFT111K private immutable token;
    uint256 public callbacks;
    uint256 public blockedCalls;
    uint256 private rejectAt;
    uint256 private expectedMinted;
    uint256 private expectedUsed;
    address private forwardTo;

    error ReceiverRejected();

    constructor(NFT111K token_) {
        token = token_;
    }

    function configure(uint256 rejectAt_, uint256 minted_, uint256 used_, address forwardTo_) external {
        callbacks = 0;
        blockedCalls = 0;
        rejectAt = rejectAt_;
        expectedMinted = minted_;
        expectedUsed = used_;
        forwardTo = forwardTo_;
    }

    function execute(bytes calldata data) external {
        (bool success, bytes memory reason) = address(token).call(data);
        if (!success) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(token));
        ++callbacks;
        (,,,,, uint16 used) = token.freeMintAllowances(address(this));
        require(used == expectedUsed && token.relicsMinted() == expectedMinted);
        require(token.allocatedCrates() == token.relicsAllocated() * 111);
        _blocked(abi.encodeCall(token.claimRelic, (17)));
        _blocked(abi.encodeCall(token.mintCrates, (1)));
        _blocked(abi.encodeCall(token.mintWarehouses, (1)));
        _blocked(abi.encodeCall(token.mintFree, (NFT111K.ItemKind.Crate, 1)));
        _blocked(abi.encodeCall(token.unboxRelic, (117189)));
        _blocked(abi.encodeCall(token.releaseAllMint, ()));
        _blocked(abi.encodeCall(token.releaseDelivery, ()));
        if (callbacks == rejectAt) revert ReceiverRejected();
        if (forwardTo != address(0)) token.transferFrom(address(this), forwardTo, tokenId);
        return this.onERC721Received.selector;
    }

    function _blocked(bytes memory data) private {
        (bool success, bytes memory reason) = address(token).call(data);
        require(!success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        ++blockedCalls;
    }
}

contract NFT111KRelicTest is TestSupport {
    NFT111K private token;
    address private constant ALICE = address(0xA110);
    address private constant BOB = address(0xB0B);

    function setUp() public {
        token = new NFT111K(
            address(this),
            address(0x5151),
            address(0xBEEF),
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            _proceedsRecipients(),
            _proceedsSharesBps(),
            new NFT111K.FreeMintAllocation[](0),
            5555
        );
        vm.deal(address(this), 100 ether);
        vm.deal(ALICE, 100 ether);
        _allow(ALICE, 18);
        _allow(BOB, 18);
    }

    function testInitialSupplyIsZeroAndAllowancesDoNotAllocate() public {
        assertEq(token.getRelicClaimedMask(), 0);
        assertEq(token.relicsAllocated(), 0);
        assertEq(token.relicsMinted(), 0);
        assertEq(token.allocatedCrates(), 0);
        assertEq(token.remainingCrates(), 5555);
        token.setSaleActive(true);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.claimRelic(18);
        assertEq(_used(ALICE), 0);
    }

    function testAllocationReservesAllCratesAndCreditsDepositWithoutMinting() public {
        vm.recordLogs();
        token.allocateRelics{value: 101}(2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], keccak256("RelicsAllocated(uint256,uint256)"));
        (uint256 quantity, uint256 paid) = abi.decode(logs[0].data, (uint256, uint256));
        assertEq(quantity, 2);
        assertEq(paid, 101);
        assertEq(token.relicsAllocated(), 2);
        assertEq(token.relicsMinted(), 0);
        assertEq(token.allocatedCrates(), 222);
        assertEq(token.remainingCrates(), 5333);
        assertEq(token.totalSupply(), 0);
        assertEq(token.getRelicClaimedMask(), 0);
        assertEq(token.totalMintReceived(), 101);
        token.releaseAllMint();
        uint256 released;
        for (uint256 i; i < token.mintRecipientCount(); ++i) {
            address recipient = token.mintRecipients(i);
            uint256 amount = 101 * token.mintSharesBps(recipient) / 10000;
            assertEq(recipient.balance, amount);
            released += amount;
        }
        assertEq(token.totalMintReleased(), released);
        assertEq(address(token).balance, 101 - released);
    }

    function testAllocationIsOwnerOnlyBoundedAndCanHaveZeroPayment() public {
        vm.prank(ALICE);
        vm.expectRevert();
        token.allocateRelics{value: 1}(1);
        vm.expectRevert(NFT111K.InvalidRelicAllocation.selector);
        token.allocateRelics{value: 1}(0);
        vm.expectRevert(NFT111K.InvalidRelicAllocation.selector);
        token.allocateRelics{value: 1}(19);
        assertEq(token.totalMintReceived(), 0);
        assertEq(token.allocatedCrates(), 0);
        assertEq(address(token).balance, 0);
        token.allocateRelics(18);
        assertEq(token.relicsAllocated(), 18);
        assertEq(token.remainingCrates(), 3557);
        assertEq(token.totalMintReceived(), 0);
    }

    function testAllocationCanOnlyHappenOnceAndFailureReturnsPayment() public {
        token.allocateRelics{value: 7}(1);
        uint256 balance = address(this).balance;
        vm.expectRevert(NFT111K.InvalidRelicAllocation.selector);
        token.allocateRelics{value: 11}(1);
        assertEq(address(this).balance, balance);
        assertEq(token.relicsAllocated(), 1);
        assertEq(token.allocatedCrates(), 111);
        assertEq(token.totalMintReceived(), 7);
    }

    function testFirstSaleActivationPermanentlyClosesAllocation() public {
        token.setSaleActive(false);
        token.setSaleActive(true);
        token.setSaleActive(false);
        vm.expectRevert(NFT111K.InvalidRelicAllocation.selector);
        token.allocateRelics{value: 1}(1);
        assertEq(token.relicsAllocated(), 0);
        assertEq(token.totalMintReceived(), 0);
        token.setSaleActive(true);
        vm.expectRevert(NFT111K.InvalidRelicAllocation.selector);
        token.allocateRelics(1);
    }

    function testClaimsSelectAnyIdAndAssignDistinctBlocksByClaimOrder() public {
        token.allocateRelics{value: 23}(2);
        token.setSaleActive(true);
        vm.recordLogs();
        _claim(ALICE, 18);
        assertEq(token.getRelicClaimedMask(), 1 << 17);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory event_ = logs[logs.length - 1];
        assertEq(event_.topics[0], keccak256("RelicClaimed(address,uint256,uint256)"));
        assertEq(event_.topics[1], bytes32(uint256(uint160(ALICE))));
        assertEq(event_.topics[2], bytes32(uint256(18)));
        assertEq(abi.decode(event_.data, (uint256)), 117189);
        _claim(BOB, 4);
        assertEq(token.getRelicClaimedMask(), (1 << 17) | (1 << 3));
        assertEq(token.relicFirstCrate(18), 1);
        assertEq(token.relicFirstCrate(4), 112);
        assertEq(token.relicFirstCrate(1), 0);
        assertEq(token.ownerOf(117189), ALICE);
        assertEq(token.ownerOf(117175), BOB);
        assertEq(token.allocatedCrates(), 222);
        assertEq(token.totalMintReceived(), 23);
        NFT111KStats.Stats memory snapshot1 = NFT111KStats(address(token)).stats(ALICE);
        uint256 allocated = snapshot1.relicsAllocated_;
        uint256 minted = snapshot1.relicsMinted_;
        assertEq(allocated, 2);
        assertEq(minted, 2);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.claimRelic(1);
        assertEq(_used(ALICE), 1);
    }

    function testClaimsNeedSaleAllowanceValidIdAndNoPayment() public {
        token.allocateRelics(2);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.claimRelic(1);
        token.setSaleActive(true);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.InvalidRelicId.selector);
        token.claimRelic(0);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.InvalidRelicId.selector);
        token.claimRelic(19);
        vm.prank(address(0xBAD));
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.claimRelic(1);
        vm.prank(ALICE);
        (bool paid,) = address(token).call{value: 1}(abi.encodeCall(token.claimRelic, (1)));
        assertFalse(paid);
        assertEq(token.relicsMinted(), 0);
        assertEq(_used(ALICE), 0);
        token.setRedemptionsPaused(true);
        _claim(ALICE, 1);
    }

    function testPublicAndGenericFreeRelicMintEntrypointsAreUnavailable() public {
        token.allocateRelics(1);
        token.setSaleActive(true);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.mintFree(NFT111K.ItemKind.Relic, 1);
        vm.prank(ALICE);
        (bool success,) = address(token).call(abi.encodeWithSignature("mintRelics(uint256)", 1));
        assertFalse(success);
        assertEq(token.relicsMinted(), 0);
    }

    function testDuplicateIdCannotConsumeUsageOrOverwriteItsReservation() public {
        token.allocateRelics(3);
        token.setSaleActive(true);
        _claim(ALICE, 18);
        vm.prank(BOB);
        vm.expectRevert(NFT111K.TokenAlreadyIssued.selector);
        token.claimRelic(18);
        assertEq(_used(BOB), 0);
        assertEq(token.relicsMinted(), 1);
        assertEq(token.relicFirstCrate(18), 1);
        vm.prank(ALICE);
        token.transferFrom(ALICE, BOB, 117189);
        assertEq(token.getRelicClaimedMask(), 1 << 17);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.TokenAlreadyIssued.selector);
        token.claimRelic(18);
        vm.prank(BOB);
        token.unboxRelic(117189);
        assertEq(token.getRelicClaimedMask(), 1 << 17);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.TokenAlreadyIssued.selector);
        token.claimRelic(18);
        assertEq(_used(ALICE), 1);
        assertEq(token.relicsMinted(), 1);
        assertEq(token.allocatedCrates(), 333);
        _claim(BOB, 4);
        assertEq(token.relicFirstCrate(4), 112);
    }

    function testAllowanceRevocationRestorationAndKindsRemainIndependent() public {
        token.allocateRelics(3);
        token.setSaleActive(true);
        _allow(ALICE, 1);
        _claim(ALICE, 18);
        _allow(ALICE, 0);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.claimRelic(4);
        _allow(ALICE, 1);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.claimRelic(4);
        _allow(ALICE, 2);
        _claim(ALICE, 4);
        (uint16 crates, uint16 warehouses, uint16 relics, uint16 cratesUsed, uint16 warehousesUsed, uint16 relicsUsed) =
            token.freeMintAllowances(ALICE);
        assertEq(crates + warehouses + cratesUsed + warehousesUsed, 0);
        assertEq(relics, 2);
        assertEq(relicsUsed, 2);
    }

    function testReservedClaimsSurvivePublicSelloutAndUnboxWithoutExtraAllocation() public {
        token.allocateRelics(2);
        token.setSaleActive(true);
        _consume(5333);
        assertEq(token.remainingCrates(), 0);
        _claim(ALICE, 18);
        _claim(BOB, 4);
        vm.prank(BOB);
        token.unboxRelic(117175);
        vm.prank(ALICE);
        token.unboxRelic(117189);
        _crates(1, 111, ALICE);
        _crates(112, 111, BOB);
        assertEq(token.allocatedCrates(), 5555);
        assertEq(token.relicsMinted(), 2);
        assertEq(token.relicsAllocated(), 2);
        uint256 balance = token.balanceOf(ALICE);
        vm.prank(ALICE);
        token.unboxCrate(116666);
        assertEq(token.balanceOf(ALICE), balance + 30);
    }

    function testAllEighteenIdsCanBeClaimedInReverseOrder() public {
        token.allocateRelics(18);
        token.setSaleActive(true);
        for (uint256 id = 18; id != 0; --id) {
            _claim(ALICE, id);
            assertEq(token.relicFirstCrate(id), (18 - id) * 111 + 1);
            assertEq(token.getRelicClaimedMask(), ((1 << 18) - 1) ^ ((1 << (id - 1)) - 1));
        }
        assertEq(token.relicsMinted(), 18);
        assertEq(_used(ALICE), 18);
        assertEq(token.allocatedCrates(), 1998);
        assertEq(token.totalSupply(), 18);
    }

    function testOpeningChecksOwnershipKindPauseAndCannotRepeat() public {
        token.allocateRelics(1);
        token.setSaleActive(true);
        _claim(ALICE, 18);
        vm.prank(BOB);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxRelic(117189);
        vm.prank(ALICE);
        token.mintWarehouses{value: 0.0011 ether}(1);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.unboxRelic(116667);
        token.setSaleActive(false);
        vm.prank(ALICE);
        token.unboxRelic(117189);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxRelic(117189);
    }

    function testClaimCallbackSeesFinalUsageAndRejectsReentry() public {
        RelicReceiver buyer = _receiver();
        buyer.configure(0, 1, 1, address(0));
        buyer.execute(abi.encodeCall(token.claimRelic, (18)));
        assertEq(buyer.callbacks(), 1);
        assertEq(buyer.blockedCalls(), 7);
        assertEq(token.relicFirstCrate(18), 1);
    }

    function testRejectedClaimRollsBackUsageIdAndCountButKeepsReservationAndDeposit() public {
        RelicReceiver buyer = _receiver();
        buyer.configure(1, 1, 1, address(0));
        vm.expectRevert(RelicReceiver.ReceiverRejected.selector);
        buyer.execute(abi.encodeCall(token.claimRelic, (18)));
        assertEq(_used(address(buyer)), 0);
        assertEq(token.relicsMinted(), 0);
        assertEq(token.relicFirstCrate(18), 0);
        assertEq(token.getRelicClaimedMask(), 0);
        assertEq(token.allocatedCrates(), 222);
        assertEq(token.totalMintReceived(), 17);
        buyer.configure(0, 1, 1, ALICE);
        buyer.execute(abi.encodeCall(token.claimRelic, (18)));
        assertEq(token.ownerOf(117189), ALICE);
    }

    function testOpeningCallbacksRollbackAllCratesAndRetryWithTransfers() public {
        RelicReceiver buyer = _receiver();
        buyer.configure(0, 1, 1, address(0));
        buyer.execute(abi.encodeCall(token.claimRelic, (18)));
        uint256[3] memory positions = [uint256(1), 56, 111];
        for (uint256 i; i < positions.length; ++i) {
            buyer.configure(positions[i], 1, 1, address(0));
            vm.expectRevert(RelicReceiver.ReceiverRejected.selector);
            buyer.execute(abi.encodeCall(token.unboxRelic, (117189)));
            assertEq(token.ownerOf(117189), address(buyer));
            assertEq(token.totalSupply(), 1);
            assertEq(token.allocatedCrates(), 222);
            for (uint256 id = 111112; id < 111223; ++id) {
                (uint8 kind,,) = token.getTokenInfo(id);
                assertEq(kind, 0);
            }
        }
        buyer.configure(0, 1, 1, BOB);
        buyer.execute(abi.encodeCall(token.unboxRelic, (117189)));
        assertEq(buyer.callbacks(), 111);
        assertEq(buyer.blockedCalls(), 777);
        _crates(1, 111, BOB);
    }

    function testFuzzAllocationAndClaimsPreserveReservedSupply(uint8 supplySeed, uint8 idSeed) public {
        uint256 quantity = uint256(supplySeed % 18) + 1;
        uint256 id = uint256(idSeed % 18) + 1;
        token.allocateRelics{value: 37}(quantity);
        token.setSaleActive(true);
        _claim(ALICE, id);
        assertEq(token.getRelicClaimedMask(), 1 << (id - 1));
        assertEq(token.allocatedCrates(), quantity * 111);
        assertEq(token.remainingCrates(), 5555 - quantity * 111);
        assertEq(token.relicFirstCrate(id), 1);
        assertEq(token.totalMintReceived(), 37);
    }

    function _receiver() private returns (RelicReceiver buyer) {
        token.allocateRelics{value: 17}(2);
        buyer = new RelicReceiver(token);
        _allow(address(buyer), 2);
        token.setSaleActive(true);
    }

    function _allow(address wallet, uint16 limit) private {
        address[] memory wallets = new address[](1);
        wallets[0] = wallet;
        token.setFreeMintAllowances(wallets, 0, 0, limit);
    }

    function _used(address wallet) private view returns (uint16 used) {
        (,,,,, used) = token.freeMintAllowances(wallet);
    }

    function _claim(address wallet, uint256 id) private {
        vm.prank(wallet);
        token.claimRelic(id);
    }

    function _consume(uint256 count) private {
        vm.startPrank(ALICE);
        while (count >= 11) {
            uint256 quantity = count / 11;
            if (quantity > 15) quantity = 15;
            token.mintWarehouses{value: quantity * 0.0011 ether}(quantity);
            count -= quantity * 11;
        }
        if (count != 0) token.mintCrates{value: count * 0.0001 ether}(count);
        vm.stopPrank();
    }

    function _crates(uint256 first, uint256 count, address holder) private view {
        for (uint256 id = first; id < first + count; ++id) {
            assertEq(token.ownerOf(111111 + id), holder);
        }
    }
}
