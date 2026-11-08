pragma solidity 0.8.38;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

interface PublicRelicStatsView {
    struct Stats {
        uint256 limit;
        uint256 minted;
        uint256 priceWei;
        bool active;
        uint256 mintable;
        uint16 freeLimit;
        uint16 freeUsed;
    }

    function publicRelicStats(address wallet) external view returns (Stats memory);
}

contract PublicRelicReceiver {
    NFT111K private immutable token;
    uint256 public callbacks;
    uint256 public blockedCalls;
    uint256 private rejectAt;
    uint256[4] private expected;
    address private forwardTo;

    error ReceiverRejected();

    constructor(NFT111K token_) {
        token = token_;
    }

    function configure(uint256 rejectAt_, uint256[4] calldata expected_, address forwardTo_) external {
        callbacks = 0;
        blockedCalls = 0;
        rejectAt = rejectAt_;
        expected = expected_;
        forwardTo = forwardTo_;
    }

    function execute(bytes calldata data) external payable {
        (bool success, bytes memory reason) = address(token).call{value: msg.value}(data);
        if (!success) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(token));
        ++callbacks;
        (, uint256 minted,,,,, uint16 used) = token.publicRelicStats(address(this));
        require(minted == expected[0] && used == expected[1]);
        require(token.allocatedCrates() == expected[2] && token.totalMintReceived() == expected[3]);
        require(token.relicsMinted() == 0);
        _blocked(abi.encodeCall(token.mintRelic, (17)));
        _blocked(abi.encodeCall(token.mintFreeRelic, (17)));
        _blocked(abi.encodeCall(token.claimRelic, (17)));
        _blocked(abi.encodeCall(token.unboxRelic, (117189)));
        _blocked(abi.encodeCall(token.releaseAllMint, ()));
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

contract NFT111KPublicRelicTest is TestSupport {
    NFT111K private token;
    address private constant ALICE = address(0xA110);
    address private constant BOB = address(0xB0B);
    uint256 private constant PRICE = 0.013 ether;

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
        vm.deal(BOB, 100 ether);
    }

    function testDefaultsAndConfigurationDoNotReserveCratesOrMint() public {
        _assertStats(ALICE, 0, 0, 0, false, 0, 0, 0);
        token.setPublicRelicSale(18, PRICE, true);
        _allow(ALICE, 18);
        _assertStats(ALICE, 18, 0, PRICE, true, 0, 18, 0);
        assertEq(token.allocatedCrates(), 0);
        assertEq(token.relicsAllocated(), 0);
        assertEq(token.totalSupply(), 0);
        token.setSaleActive(true);
        _assertStats(ALICE, 18, 0, PRICE, true, 18, 18, 0);
    }

    function testConfigurationChecksBothReservationOrdersAndAllEighteenReserved() public {
        token.setPublicRelicSale(3, PRICE, false);
        vm.expectRevert(NFT111K.InvalidRelicAllocation.selector);
        token.allocateRelics(16);
        assertEq(token.allocatedCrates(), 0);
        token.allocateRelics(15);
        vm.expectRevert(NFT111K.InvalidPublicRelicConfig.selector);
        token.setPublicRelicSale(4, PRICE, true);
        token.setPublicRelicSale(3, PRICE, true);
        token.setPublicRelicSale(0, PRICE, false);
        assertEq(token.allocatedCrates(), 1665);
    }

    function testFullReservationLeavesNoPublicCapacity() public {
        token.allocateRelics(18);
        token.setPublicRelicSale(0, PRICE, true);
        token.setSaleActive(true);
        vm.expectRevert(NFT111K.InvalidPublicRelicConfig.selector);
        token.setPublicRelicSale(1, PRICE, true);
        _expectPaidRevert(1, PRICE, NFT111K.SoldOut.selector);
        _allow(ALICE, 18);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintFreeRelic(1);
        _assertStats(ALICE, 0, 0, PRICE, true, 0, 18, 0);
    }

    function testConfigurationIsOwnerOnlyAndRejectsValuesAboveEighteen() public {
        vm.prank(ALICE);
        vm.expectRevert();
        token.setPublicRelicSale(1, PRICE, true);
        vm.expectRevert(NFT111K.InvalidPublicRelicConfig.selector);
        token.setPublicRelicSale(19, PRICE, true);
        vm.expectRevert(NFT111K.InvalidPublicRelicConfig.selector);
        token.setPublicRelicSale(type(uint256).max, PRICE, true);
        token.setPublicRelicSale(18, type(uint256).max, true);
        _assertStats(ALICE, 18, 0, type(uint256).max, true, 0, 0, 0);
    }

    function testTranchesCanIncreaseAndShrinkWithoutResettingMintedCount() public {
        _open(2, PRICE);
        _buy(ALICE, 18, PRICE);
        token.setPublicRelicSale(1, PRICE, true);
        _expectPaidRevert(2, PRICE, NFT111K.SoldOut.selector);
        vm.expectRevert(NFT111K.InvalidPublicRelicConfig.selector);
        token.setPublicRelicSale(0, PRICE, false);
        token.setPublicRelicSale(4, PRICE, true);
        _buy(BOB, 2, PRICE);
        _buy(ALICE, 7, PRICE);
        _buy(BOB, 5, PRICE);
        _expectPaidRevert(1, PRICE, NFT111K.SoldOut.selector);
        _assertStats(ALICE, 4, 4, PRICE, true, 0, 0, 0);
        assertEq(token.allocatedCrates(), 444);
        assertEq(token.relicsMinted(), 0);
    }

    function testBothSaleFlagsGatePaidAndFreeMintsWithoutGatingReservedClaims() public {
        token.allocateRelics(1);
        _claimAllowance(ALICE, 1);
        _allow(ALICE, 1);
        token.setPublicRelicSale(2, PRICE, true);
        _expectPaidRevert(1, PRICE, NFT111K.SaleInactive.selector);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintFreeRelic(1);
        token.setSaleActive(true);
        token.setPublicRelicSale(2, PRICE, false);
        _expectPaidRevert(1, PRICE, NFT111K.SaleInactive.selector);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintFreeRelic(1);
        _claim(ALICE, 18);
        _assertStats(ALICE, 2, 0, PRICE, false, 0, 1, 0);
        token.setPublicRelicSale(2, PRICE, true);
        token.setSaleActive(false);
        _assertStats(ALICE, 2, 0, PRICE, true, 0, 1, 0);
    }

    function testPriceChangesRequireExactPaymentAndAllowAnExplicitZeroPrice() public {
        _open(3, PRICE);
        _expectPaidRevert(1, PRICE - 1, NFT111K.WrongPayment.selector);
        _expectPaidRevert(1, PRICE + 1, NFT111K.WrongPayment.selector);
        token.setPublicRelicSale(3, PRICE * 2, true);
        _expectPaidRevert(1, PRICE, NFT111K.WrongPayment.selector);
        assertEq(token.allocatedCrates(), 0);
        assertEq(token.totalMintReceived(), 0);
        _buy(ALICE, 1, PRICE * 2);
        token.setPublicRelicSale(3, 0, true);
        _buy(BOB, 2, 0);
        assertEq(token.totalMintReceived(), PRICE * 2);
        _assertStats(BOB, 3, 2, 0, true, 1, 0, 0);
    }

    function testInvalidIdsAndGenericFreeMintDoNotConsumeSupply() public {
        _open(2, PRICE);
        _allow(ALICE, 2);
        _expectPaidRevert(0, PRICE, NFT111K.InvalidRelicId.selector);
        _expectPaidRevert(19, PRICE, NFT111K.InvalidRelicId.selector);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.InvalidRelicId.selector);
        token.mintFreeRelic(0);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.mintFree(NFT111K.ItemKind.Relic, 1);
        _assertStats(ALICE, 2, 0, PRICE, true, 2, 2, 0);
        assertEq(token.allocatedCrates(), 0);
    }

    function testInterleavedClaimsAndPublicMintsUseDisjointCrateBlocks() public {
        token.allocateRelics(2);
        _claimAllowance(ALICE, 2);
        _allow(BOB, 1);
        _open(3, PRICE);
        _buy(BOB, 18, PRICE);
        _claim(ALICE, 4);
        vm.prank(ALICE);
        token.mintWarehouses{value: 0.0011 ether}(1);
        _free(BOB, 7);
        _claim(ALICE, 9);
        assertEq(token.relicFirstCrate(18), 223);
        assertEq(token.relicFirstCrate(4), 1);
        assertEq(token.warehouseFirstCrate(1), 334);
        assertEq(token.relicFirstCrate(7), 345);
        assertEq(token.relicFirstCrate(9), 112);
        assertEq(token.allocatedCrates(), 455);
        assertEq(token.relicsMinted(), 2);
        assertEq(token.getRelicClaimedMask(), (1 << 17) | (1 << 3) | (1 << 6) | (1 << 8));
        _assertStats(BOB, 3, 2, PRICE, true, 1, 1, 1);
        vm.prank(BOB);
        token.unboxRelic(117189);
        _crates(223, BOB);
        vm.prank(ALICE);
        token.unboxRelic(117175);
        _crates(1, ALICE);
        assertEq(token.allocatedCrates(), 455);
    }

    function testPublicMintsCanUseAllIdsWithZeroReserved() public {
        _allow(ALICE, 9);
        _open(18, PRICE);
        for (uint256 id = 1; id <= 18; ++id) {
            if (id % 2 == 0) _free(ALICE, id);
            else _buy(ALICE, id, PRICE);
            assertEq(token.relicFirstCrate(id), (id - 1) * 111 + 1);
        }
        assertEq(token.relicsAllocated(), 0);
        assertEq(token.relicsMinted(), 0);
        assertEq(token.getRelicClaimedMask(), (1 << 18) - 1);
        assertEq(token.allocatedCrates(), 1998);
        _assertStats(ALICE, 18, 18, PRICE, true, 0, 9, 9);
        _expectPaidRevert(1, PRICE, NFT111K.SoldOut.selector);
    }

    function testStatsAppendPublicCountAndPreserveLegacyEncoding() public {
        token.allocateRelics(2);
        _claimAllowance(ALICE, 1);
        _allow(ALICE, 1);
        _open(3, PRICE);
        _buy(ALICE, 18, PRICE);
        _claim(ALICE, 4);
        _free(ALICE, 7);
        (bool success, bytes memory data) = address(token).staticcall(abi.encodeCall(token.stats, (ALICE)));
        assertTrue(success);
        assertEq(data.length, 15 * 32);
        uint256[14] memory legacy = abi.decode(data, (uint256[14]));
        NFT111K.Stats memory snapshot = abi.decode(data, (NFT111K.Stats));
        assertEq(legacy[0], 444);
        assertEq(legacy[3], token.cratePrice());
        assertEq(legacy[4], token.warehousePrice());
        assertEq(legacy[5], 1);
        assertEq(legacy[10], 2);
        assertEq(legacy[11], 1);
        assertEq(legacy[12], 5555);
        assertEq(legacy[13], 0);
        assertEq(snapshot.publicRelicsMinted_, 2);
    }

    function testExactly111RemainingCanMintAndReservedClaimsSurviveSellout() public {
        token.allocateRelics(2);
        _claimAllowance(ALICE, 2);
        _open(2, PRICE);
        _consume(5222);
        _assertStats(ALICE, 2, 0, PRICE, true, 1, 0, 0);
        _buy(BOB, 18, PRICE);
        assertEq(token.remainingCrates(), 0);
        assertEq(token.relicFirstCrate(18), 5445);
        _expectPaidRevert(2, PRICE, NFT111K.SoldOut.selector);
        _claim(ALICE, 1);
        _claim(ALICE, 2);
        vm.prank(BOB);
        token.unboxRelic(117189);
        _crates(5445, BOB);
        vm.prank(ALICE);
        token.unboxRelic(117172);
        _crates(1, ALICE);
        assertEq(token.allocatedCrates(), 5555);
    }

    function test110RemainingRejectsPaidAndFreeWithoutConsumingAllowance() public {
        _open(2, PRICE);
        _allow(ALICE, 2);
        _consume(5445);
        _assertStats(ALICE, 2, 0, PRICE, true, 0, 2, 0);
        uint256 received = token.totalMintReceived();
        _expectPaidRevert(18, PRICE, NFT111K.SoldOut.selector);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintFreeRelic(18);
        assertEq(token.remainingCrates(), 110);
        assertEq(token.totalMintReceived(), received);
        assertEq(token.relicFirstCrate(18), 0);
        _assertStats(ALICE, 2, 0, PRICE, true, 0, 2, 0);
    }

    function testPaidAndFreeMintsShareQuotaAndFreeMintsNeverSpendClaimAllowance() public {
        token.allocateRelics(1);
        _claimAllowance(ALICE, 1);
        _allow(ALICE, 2);
        _open(2, PRICE);
        _buy(ALICE, 18, PRICE);
        _free(ALICE, 17);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintFreeRelic(16);
        (,,,,, uint16 claimsUsed) = token.freeMintAllowances(ALICE);
        assertEq(claimsUsed, 0);
        _claim(ALICE, 16);
        _assertStats(ALICE, 2, 2, PRICE, true, 0, 2, 1);
        assertEq(token.totalMintReceived(), PRICE);
    }

    function testLegacyAndPublicAllowancesCannotAuthorizeTheOtherFlow() public {
        token.allocateRelics(1);
        _open(2, PRICE);
        _claimAllowance(ALICE, 1);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.mintFreeRelic(1);
        _allow(BOB, 1);
        vm.prank(BOB);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.claimRelic(1);
        _claimAllowance(BOB, 0);
        _free(BOB, 18);
        _claim(ALICE, 1);
        _assertStats(BOB, 2, 1, PRICE, true, 1, 1, 1);
    }

    function testFreeAllowanceRevocationRestorationAndTransferPreserveLifetimeUsage() public {
        _open(5, PRICE);
        _allow(ALICE, 2);
        _free(ALICE, 18);
        vm.prank(ALICE);
        token.transferFrom(ALICE, BOB, 117189);
        vm.prank(BOB);
        token.unboxRelic(117189);
        _allow(ALICE, 0);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.mintFreeRelic(17);
        _allow(ALICE, 1);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.mintFreeRelic(17);
        _allow(ALICE, 2);
        _free(ALICE, 17);
        _assertStats(ALICE, 5, 2, PRICE, true, 3, 2, 2);
        vm.prank(BOB);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.mintFreeRelic(16);
        vm.prank(ALICE);
        (bool success,) = address(token).call{value: 1}(abi.encodeCall(token.mintFreeRelic, (16)));
        assertFalse(success);
        assertEq(token.totalMintReceived(), 0);
    }

    function testFreeAllowanceSetterRejectsInvalidBatchesAtomically() public {
        address[] memory wallets = _wallets(ALICE);
        vm.prank(ALICE);
        vm.expectRevert();
        token.setPublicRelicFreeMintAllowances(wallets, 1);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setPublicRelicFreeMintAllowances(wallets, 19);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setPublicRelicFreeMintAllowances(new address[](0), 1);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setPublicRelicFreeMintAllowances(new address[](33), 1);
        wallets = new address[](2);
        wallets[0] = ALICE;
        wallets[1] = ALICE;
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setPublicRelicFreeMintAllowances(wallets, 1);
        wallets[1] = address(0);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        token.setPublicRelicFreeMintAllowances(wallets, 1);
        wallets[1] = address(token);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        token.setPublicRelicFreeMintAllowances(wallets, 1);
        _assertStats(ALICE, 0, 0, 0, false, 0, 0, 0);
        wallets = new address[](32);
        for (uint256 i; i < wallets.length; ++i) {
            wallets[i] = address(uint160(0xF000 + i));
        }
        token.setPublicRelicFreeMintAllowances(wallets, 18);
        _assertStats(wallets[31], 0, 0, 0, false, 0, 18, 0);
    }

    function testIdsRemainUnavailableAcrossBothFlowsAfterTransferAndUnboxing() public {
        token.allocateRelics(2);
        _claimAllowance(ALICE, 2);
        _allow(ALICE, 3);
        _open(3, PRICE);
        _claim(ALICE, 1);
        _expectPaidRevert(1, PRICE, NFT111K.TokenAlreadyIssued.selector);
        _buy(ALICE, 18, PRICE);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.TokenAlreadyIssued.selector);
        token.claimRelic(18);
        vm.prank(ALICE);
        token.transferFrom(ALICE, BOB, 117189);
        vm.prank(BOB);
        token.unboxRelic(117189);
        _expectPaidRevert(18, PRICE, NFT111K.TokenAlreadyIssued.selector);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.TokenAlreadyIssued.selector);
        token.mintFreeRelic(18);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.TokenAlreadyIssued.selector);
        token.claimRelic(18);
        assertEq(token.relicFirstCrate(18), 223);
        assertEq(token.relicsMinted(), 1);
        _assertStats(ALICE, 3, 1, PRICE, true, 2, 3, 0);
    }

    function testPublicRevenueUsesExistingProceedsSplitAndFreeMintsAddNoRevenue() public {
        token.allocateRelics{value: 101}(1);
        _open(3, PRICE);
        _allow(ALICE, 1);
        _buy(ALICE, 1, PRICE);
        _free(ALICE, 2);
        token.setPublicRelicSale(3, 137, true);
        _buy(BOB, 3, 137);
        uint256 received = PRICE + 238;
        assertEq(token.totalMintReceived(), received);
        token.releaseAllMint();
        uint256 released;
        for (uint256 i; i < token.mintRecipientCount(); ++i) {
            address recipient = token.mintRecipients(i);
            uint256 amount = received * token.mintSharesBps(recipient) / 10000;
            assertEq(recipient.balance, amount);
            assertEq(token.mintReleased(recipient), amount);
            released += amount;
        }
        assertEq(token.totalMintReleased(), released);
        assertEq(address(token).balance, received - released);
    }

    function testDeliveredPublicRelicKeepsItsIdAndCratesConsumed() public {
        token.allocateRelics(1);
        _open(2, PRICE);
        _allow(ALICE, 1);
        _claimAllowance(ALICE, 1);
        _buy(ALICE, 18, PRICE);
        _deliverRelic(ALICE, 18);
        assertEq(token.ownerOf(3000018), ALICE);
        assertEq(token.relicFirstCrate(18), 112);
        assertEq(token.getRelicClaimedMask(), 1 << 17);
        _expectPaidRevert(18, PRICE, NFT111K.TokenAlreadyIssued.selector);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.TokenAlreadyIssued.selector);
        token.mintFreeRelic(18);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.TokenAlreadyIssued.selector);
        token.claimRelic(18);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.unboxRelic(3000018);
        assertEq(token.allocatedCrates(), 222);
        _assertStats(ALICE, 2, 1, PRICE, true, 1, 1, 0);
    }

    function testEventsDistinguishPaidZeroPriceAndAllowanceMints() public {
        vm.recordLogs();
        token.setPublicRelicSale(2, 0, true);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], keccak256("PublicRelicSaleUpdated(uint256,uint256,bool)"));
        (uint256 limit, uint256 price, bool active) = abi.decode(logs[0].data, (uint256, uint256, bool));
        assertEq(limit, 2);
        assertEq(price, 0);
        assertTrue(active);
        vm.recordLogs();
        _allow(ALICE, 1);
        logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], keccak256("PublicRelicFreeMintAllowanceUpdated(address,uint16)"));
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(ALICE))));
        assertEq(abi.decode(logs[0].data, (uint16)), 1);
        token.setSaleActive(true);
        _assertMintEvent(18, false);
        _assertMintEvent(17, true);
    }

    function testPaidCallbackSeesFinalAccountingAndReentryIsBlocked() public {
        PublicRelicReceiver buyer = _receiver();
        buyer.configure(0, [uint256(1), 0, 222, PRICE], BOB);
        buyer.execute{value: PRICE}(abi.encodeCall(token.mintRelic, (18)));
        assertEq(buyer.callbacks(), 1);
        assertEq(buyer.blockedCalls(), 5);
        assertEq(token.ownerOf(117189), BOB);
        assertEq(token.relicFirstCrate(18), 112);
    }

    function testRejectedPaidCallbackRollsBackPriceQuotaIdAndCrates() public {
        PublicRelicReceiver buyer = _receiver();
        buyer.configure(1, [uint256(1), 0, 222, PRICE], address(0));
        uint256 balance = address(this).balance;
        vm.expectRevert(PublicRelicReceiver.ReceiverRejected.selector);
        buyer.execute{value: PRICE}(abi.encodeCall(token.mintRelic, (18)));
        assertEq(address(this).balance, balance);
        assertEq(token.allocatedCrates(), 111);
        assertEq(token.totalMintReceived(), 0);
        assertEq(token.relicFirstCrate(18), 0);
        _assertStats(address(buyer), 3, 0, PRICE, true, 3, 2, 0);
        buyer.configure(0, [uint256(1), 0, 222, PRICE], address(0));
        buyer.execute{value: PRICE}(abi.encodeCall(token.mintRelic, (18)));
        assertEq(token.ownerOf(117189), address(buyer));
    }

    function testRejectedFreeCallbackRollsBackAllowanceAndRetrySeesFinalUsage() public {
        PublicRelicReceiver buyer = _receiver();
        buyer.configure(1, [uint256(1), 1, 222, 0], address(0));
        vm.expectRevert(PublicRelicReceiver.ReceiverRejected.selector);
        buyer.execute(abi.encodeCall(token.mintFreeRelic, (18)));
        _assertStats(address(buyer), 3, 0, PRICE, true, 3, 2, 0);
        assertEq(token.allocatedCrates(), 111);
        assertEq(token.relicFirstCrate(18), 0);
        buyer.configure(0, [uint256(1), 1, 222, 0], address(0));
        buyer.execute(abi.encodeCall(token.mintFreeRelic, (18)));
        assertEq(buyer.blockedCalls(), 5);
        _assertStats(address(buyer), 3, 1, PRICE, true, 2, 2, 1);
    }

    function testPublicRelicUnboxCallbacksRollBackAndDoNotRefundQuotaOrCrates() public {
        PublicRelicReceiver buyer = _receiver();
        buyer.configure(0, [uint256(1), 1, 222, 0], address(0));
        buyer.execute(abi.encodeCall(token.mintFreeRelic, (18)));
        uint256[3] memory failures = [uint256(1), 56, 111];
        for (uint256 i; i < failures.length; ++i) {
            buyer.configure(failures[i], [uint256(1), 1, 222, 0], address(0));
            vm.expectRevert(PublicRelicReceiver.ReceiverRejected.selector);
            buyer.execute(abi.encodeCall(token.unboxRelic, (117189)));
            assertEq(token.ownerOf(117189), address(buyer));
            assertEq(token.totalSupply(), 1);
            assertEq(token.allocatedCrates(), 222);
        }
        buyer.configure(0, [uint256(1), 1, 222, 0], BOB);
        buyer.execute(abi.encodeCall(token.unboxRelic, (117189)));
        assertEq(buyer.callbacks(), 111);
        assertEq(buyer.blockedCalls(), 555);
        _crates(112, BOB);
        _assertStats(address(buyer), 3, 1, PRICE, true, 2, 2, 1);
        assertEq(token.relicFirstCrate(18), 112);
    }

    function testFuzzReservedAndPublicAllocationRemainDisjoint(uint8 reserveSeed, uint8 idSeed, bool free) public {
        uint256 reserved = reserveSeed % 18;
        if (reserved != 0) token.allocateRelics(reserved);
        _open(18 - reserved, PRICE);
        uint256 id = uint256(idSeed % 18) + 1;
        if (free) {
            _allow(ALICE, 1);
            _free(ALICE, id);
        } else {
            _buy(ALICE, id, PRICE);
        }
        assertEq(token.relicFirstCrate(id), reserved * 111 + 1);
        assertEq(token.allocatedCrates(), (reserved + 1) * 111);
        assertEq(token.relicsMinted(), 0);
        if (reserved != 0) {
            _claimAllowance(BOB, 1);
            uint256 claimId = id == 18 ? 1 : id + 1;
            _claim(BOB, claimId);
            assertEq(token.relicFirstCrate(claimId), 1);
            assertEq(token.allocatedCrates(), (reserved + 1) * 111);
        }
    }

    function _assertMintEvent(uint256 id, bool free) private {
        vm.recordLogs();
        if (free) _free(ALICE, id);
        else _buy(ALICE, id, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory entry = logs[logs.length - 1];
        assertEq(entry.topics[0], keccak256("PublicRelicMinted(address,uint256,uint256,uint256,bool)"));
        assertEq(entry.topics[1], bytes32(uint256(uint160(ALICE))));
        assertEq(entry.topics[2], bytes32(id));
        (uint256 tokenId, uint256 paid, bool freeMint) = abi.decode(entry.data, (uint256, uint256, bool));
        assertEq(tokenId, 117171 + id);
        assertEq(paid, 0);
        assertTrue(freeMint == free);
    }

    function _deliverRelic(address wallet, uint256 id) private {
        uint256 key = 0x5151;
        token.setQuoteSigner(vm.addr(key));
        uint256[] memory ids = new uint256[](1);
        ids[0] = 3000000 + id;
        NFT111K.DeliveryQuote memory quote =
            NFT111K.DeliveryQuote(1, wallet, 0, block.timestamp + 300, keccak256(abi.encode(ids)), 1);
        ids[0] = 117171 + id;
        bytes32 hash = keccak256(
            abi.encode(
                keccak256(
                    "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline,uint256 configId)"
                ),
                wallet,
                keccak256(abi.encode(ids)),
                quote.receiptIdsHash,
                quote.orderId,
                quote.fee,
                quote.deadline,
                quote.configId
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("111K"),
                keccak256("2"),
                block.chainid,
                address(token)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked(hex"1901", domain, hash)));
        vm.prank(wallet);
        token.redeemForDelivery(ids, quote, abi.encodePacked(r, s, v));
    }

    function _receiver() private returns (PublicRelicReceiver buyer) {
        token.allocateRelics(1);
        _open(3, PRICE);
        buyer = new PublicRelicReceiver(token);
        _allow(address(buyer), 2);
    }

    function _open(uint256 limit, uint256 price) private {
        token.setPublicRelicSale(limit, price, true);
        token.setSaleActive(true);
    }

    function _buy(address wallet, uint256 id, uint256 paid) private {
        vm.prank(wallet);
        token.mintRelic{value: paid}(id);
    }

    function _free(address wallet, uint256 id) private {
        vm.prank(wallet);
        token.mintFreeRelic(id);
    }

    function _claim(address wallet, uint256 id) private {
        vm.prank(wallet);
        token.claimRelic(id);
    }

    function _allow(address wallet, uint16 limit) private {
        token.setPublicRelicFreeMintAllowances(_wallets(wallet), limit);
    }

    function _claimAllowance(address wallet, uint16 limit) private {
        token.setFreeMintAllowances(_wallets(wallet), 0, 0, limit);
    }

    function _wallets(address wallet) private pure returns (address[] memory wallets) {
        wallets = new address[](1);
        wallets[0] = wallet;
    }

    function _expectPaidRevert(uint256 id, uint256 paid, bytes4 error_) private {
        vm.prank(ALICE);
        vm.expectRevert(error_);
        token.mintRelic{value: paid}(id);
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

    function _crates(uint256 first, address holder) private view {
        for (uint256 id = first; id < first + 111; ++id) {
            assertEq(token.ownerOf(111111 + id), holder);
        }
    }

    function _assertStats(
        address wallet,
        uint256 expectedLimit,
        uint256 expectedMinted,
        uint256 expectedPrice,
        bool expectedActive,
        uint256 expectedMintable,
        uint16 expectedFreeLimit,
        uint16 expectedFreeUsed
    ) private view {
        PublicRelicStatsView.Stats memory actual = PublicRelicStatsView(address(token)).publicRelicStats(wallet);
        assertEq(actual.limit, expectedLimit);
        assertEq(actual.minted, expectedMinted);
        assertEq(actual.priceWei, expectedPrice);
        assertTrue(actual.active == expectedActive);
        assertEq(actual.mintable, expectedMintable);
        assertEq(actual.freeLimit, expectedFreeLimit);
        assertEq(actual.freeUsed, expectedFreeUsed);
    }
}
