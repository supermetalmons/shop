pragma solidity 0.8.38;

import {TarotCards} from "../src/TarotCards.sol";
import {DMXTestSupport, DMXPaymentReceiver} from "./DMXTestSupport.sol";
import {Vm} from "./TestSupport.sol";

contract DMXProceedsTest is DMXTestSupport {
    function setUp() public override {
        super.setUp();
        token.setRedemptionsPaused(false);
    }

    function _fund(uint256 configId, uint256 orderId, uint256 fee) private {
        uint256[] memory ids = _one(10_000 + orderId);
        token.mintTo(ALICE, ids);
        _redeem(ids, new uint256[](0), _quote(ALICE, ALICE, orderId, fee, configId));
    }

    function _credit(uint256 configId, uint256 expected1, uint256 expected2) private view {
        (uint256 amount1, uint256 amount2) = token.releasableRedemption(configId);
        assertEq(amount1, expected1);
        assertEq(amount2, expected2);
    }

    function testConfigRegistrationRequiresOwnerAndCanonicalRecipientsAndShares() public {
        vm.prank(ALICE);
        vm.expectRevert();
        token.registerRedemptionConfig(TREASURY1, TREASURY2, 2500);
        vm.expectRevert(TarotCards.InvalidAddress.selector);
        token.registerRedemptionConfig(address(0), address(0), 0);
        vm.expectRevert(TarotCards.InvalidAddress.selector);
        token.registerRedemptionConfig(address(token), address(0), 0);
        vm.expectRevert(TarotCards.InvalidAddress.selector);
        token.registerRedemptionConfig(TREASURY1, address(token), 2500);
        vm.expectRevert(TarotCards.InvalidRedemptionSplit.selector);
        token.registerRedemptionConfig(TREASURY1, TREASURY1, 2500);
        vm.expectRevert(TarotCards.InvalidRedemptionSplit.selector);
        token.registerRedemptionConfig(TREASURY1, address(0), 1);
        uint16[3] memory invalid = [uint16(0), 10_000, type(uint16).max];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(TarotCards.InvalidRedemptionSplit.selector);
            token.registerRedemptionConfig(TREASURY1, TREASURY2, invalid[i]);
        }
        assertEq(token.redemptionConfigCount(), 0);
        assertEq(token.registerRedemptionConfig(TREASURY1, address(0), 0), 1);
        assertEq(token.registerRedemptionConfig(TREASURY1, TREASURY2, 1), 2);
        assertEq(token.registerRedemptionConfig(TREASURY1, TREASURY2, 9999), 3);
    }

    function testConfigRegistryExceedsBatchLimitAndOldSplitsRemainIndependent() public {
        for (uint256 i = 1; i <= 40; ++i) {
            assertEq(token.registerRedemptionConfig(TREASURY1, TREASURY2, uint16(i * 100)), i);
        }
        assertEq(token.redemptionConfigCount(), 40);
        (address first, address second, uint16 bps,,,) = token.redemptionConfigs(1);
        assertEq(first, TREASURY1);
        assertEq(second, TREASURY2);
        assertEq(bps, 100);
        _fund(1, 1, 1001);
        _fund(40, 2, 2003);
        _credit(1, 991, 10);
        _credit(40, 1202, 801);
        token.releaseRedemption(_one(40));
        assertEq(TREASURY1.balance, 1202);
        assertEq(TREASURY2.balance, 801);
        _credit(1, 991, 10);
        assertEq(_configReceived(1), 1001);
        assertEq(_configReceived(40), 2003);
        (first, second, bps,,,) = token.redemptionConfigs(1);
        assertEq(first, TREASURY1);
        assertEq(second, TREASURY2);
        assertEq(bps, 100);
    }

    function testFreeRedemptionsAllowZeroOrRegisteredConfigButRejectUnknownConfigs() public {
        _fund(0, 1, 0);
        uint256 configId = token.registerRedemptionConfig(TREASURY1, address(0), 0);
        _fund(configId, 2, 0);
        assertEq(_configReceived(configId), 0);
        assertEq(address(token).balance, 0);
        token.mintTo(ALICE, _one(10_003));
        uint256[] memory inputs = _one(10_003);
        uint256[] memory outputs = new uint256[](0);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 3, 0, 2);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidRedemptionConfig.selector);
        token.redeem(inputs, outputs, quote, signature);
        quote = _quote(ALICE, ALICE, 3, 1, 0);
        signature = _redemptionSignature(inputs, outputs, quote);
        vm.deal(ALICE, 1);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidRedemptionConfig.selector);
        token.redeem{value: 1}(inputs, outputs, quote, signature);
        assertEq(token.ownerOf(10_003), ALICE);
        assertFalse(token.usedRedemptionOrders(3));
        assertEq(ALICE.balance, 1);
        assertEq(address(token).balance, 0);
    }

    function testFeesAccrueWithoutCallingReceiversAndReleaseOnlyTheirSignedConfig() public {
        DMXPaymentReceiver receiver = new DMXPaymentReceiver();
        uint256 first = token.registerRedemptionConfig(address(receiver), address(0), 0);
        uint256 second = token.registerRedemptionConfig(TREASURY1, TREASURY2, 2500);
        receiver.configure(token, first, 1);
        _fund(first, 1, 17);
        _fund(second, 2, 1001);
        assertEq(receiver.received(), 0);
        assertEq(TREASURY1.balance, 0);
        assertEq(TREASURY2.balance, 0);
        _credit(first, 17, 0);
        _credit(second, 751, 250);
        token.releaseRedemption(_one(second));
        assertEq(address(token).balance, 17);
        _credit(first, 17, 0);
        _credit(second, 0, 0);
    }

    function testCumulativeRoundingRetainsFractionalSharesAcrossWithdrawals() public {
        uint256 configId = token.registerRedemptionConfig(TREASURY1, TREASURY2, 2500);
        _fund(configId, 1, 3);
        token.releaseRedemption(_one(configId));
        assertEq(TREASURY1.balance, 3);
        assertEq(TREASURY2.balance, 0);
        _fund(configId, 2, 1);
        _credit(configId, 0, 1);
        token.releaseRedemptionFor(configId, true);
        _fund(configId, 3, 5);
        _credit(configId, 4, 1);
        token.releaseRedemptionFor(configId, false);
        _credit(configId, 0, 1);
        token.releaseRedemption(_one(configId));
        assertEq(TREASURY1.balance, 7);
        assertEq(TREASURY2.balance, 2);
        assertEq(address(token).balance, 0);
    }

    function testFuzzCumulativeFeesConserveEveryWeiAfterPartialWithdrawals(
        uint96 fee1, uint96 fee2, uint96 fee3, uint16 rawShare
    ) public {
        uint16 share = uint16(uint256(rawShare) % 9999 + 1);
        uint256 configId = token.registerRedemptionConfig(TREASURY1, TREASURY2, share);
        _fund(configId, 1, fee1);
        token.releaseRedemptionFor(configId, false);
        _fund(configId, 2, fee2);
        token.releaseRedemptionFor(configId, true);
        _fund(configId, 3, fee3);
        uint256 total = uint256(fee1) + fee2 + fee3;
        uint256 secondary = total * share / 10_000;
        (uint256 amount1, uint256 amount2) = token.releasableRedemption(configId);
        assertEq(TREASURY1.balance + amount1, total - secondary);
        assertEq(TREASURY2.balance + amount2, secondary);
        assertEq(address(token).balance, amount1 + amount2);
        token.releaseRedemption(_two(configId, configId));
        assertEq(TREASURY1.balance, total - secondary);
        assertEq(TREASURY2.balance, secondary);
        assertEq(address(token).balance, 0);
        _credit(configId, 0, 0);
    }

    function testMaximumUintFeeSplitDoesNotOverflow() public {
        uint256 configId = token.registerRedemptionConfig(TREASURY1, TREASURY2, 9999);
        _fund(configId, 1, type(uint256).max);
        uint256 primary = type(uint256).max / 10_000 + 1;
        _credit(configId, primary, type(uint256).max - primary);
        token.releaseRedemption(_one(configId));
        assertEq(TREASURY1.balance, primary);
        assertEq(TREASURY2.balance, type(uint256).max - primary);
        assertEq(address(token).balance, 0);
    }

    function testDuplicateConfigsNeverPayTwiceAndFailedCreditRemainsRecoverable() public {
        DMXPaymentReceiver receiver = new DMXPaymentReceiver();
        uint256 configId = token.registerRedemptionConfig(address(receiver), TREASURY2, 5000);
        receiver.configure(token, configId, 1);
        _fund(configId, 1, 10);
        uint256[] memory ids = new uint256[](3);
        ids[0] = configId;
        ids[1] = configId;
        ids[2] = configId;
        vm.recordLogs();
        token.releaseRedemption(ids);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 failures;
        uint256 successes;
        for (uint256 i; i < logs.length; ++i) {
            assertEq(logs[i].emitter, address(token));
            if (logs[i].topics[0] == keccak256("RedemptionProceedsReleaseFailed(uint256,address,uint256)")) {
                assertEq(logs[i].topics[1], bytes32(configId));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(receiver)))));
                assertEq(abi.decode(logs[i].data, (uint256)), 5);
                failures++;
            } else if (logs[i].topics[0] == keccak256("RedemptionProceedsReleased(uint256,address,uint256)")) {
                assertEq(abi.decode(logs[i].data, (uint256)), 5);
                successes++;
            }
        }
        assertEq(failures, 3);
        assertEq(successes, 1);
        assertEq(TREASURY2.balance, 5);
        assertEq(receiver.received(), 0);
        _credit(configId, 5, 0);
        vm.expectRevert(TarotCards.ProceedsPaymentFailed.selector);
        token.releaseRedemptionFor(configId, false);
        _credit(configId, 5, 0);
        receiver.configure(token, configId, 0);
        token.releaseRedemption(ids);
        assertEq(receiver.received(), 5);
        assertEq(TREASURY2.balance, 5);
        assertEq(address(token).balance, 0);
        _credit(configId, 0, 0);
    }

    function testGasBurningRecipientCannotBlockTheOtherShareInFundedBatch() public {
        DMXPaymentReceiver receiver = new DMXPaymentReceiver();
        uint256 configId = token.registerRedemptionConfig(address(receiver), TREASURY2, 2500);
        receiver.configure(token, configId, 2);
        _fund(configId, 1, 100);
        uint256 gasBefore = gasleft();
        token.releaseRedemption{gas: 400_000}(_one(configId));
        assertTrue(gasBefore - gasleft() < 300_000);
        assertEq(TREASURY2.balance, 25);
        assertEq(address(token).balance, 75);
        _credit(configId, 75, 0);
    }

    function testFullGasWithdrawalRecoversReceiverTooExpensiveForBatch() public {
        DMXPaymentReceiver receiver = new DMXPaymentReceiver();
        uint256 configId = token.registerRedemptionConfig(address(receiver), address(0), 0);
        receiver.configure(token, configId, 3);
        _fund(configId, 1, 123);
        token.releaseRedemption(_one(configId));
        assertEq(receiver.received(), 0);
        _credit(configId, 123, 0);
        vm.prank(BOB);
        token.releaseRedemptionFor(configId, false);
        assertEq(receiver.received(), 123);
        _credit(configId, 0, 0);
    }

    function testReceiverSeesConsumedCreditAndCannotReenterEitherReleasePath() public {
        DMXPaymentReceiver receiver = new DMXPaymentReceiver();
        uint256 configId = token.registerRedemptionConfig(address(receiver), TREASURY2, 5000);
        receiver.configure(token, configId, 4);
        _fund(configId, 1, 21);
        token.releaseRedemptionFor(configId, false);
        assertEq(receiver.received(), 11);
        assertEq(receiver.blockedCalls(), 1);
        _fund(configId, 2, 19);
        token.releaseRedemption(_two(configId, configId));
        assertEq(receiver.received(), 20);
        assertEq(receiver.blockedCalls(), 2);
        assertEq(TREASURY2.balance, 20);
        assertEq(address(token).balance, 0);
    }

    function testBatchLimitOfThirtyTwoBoundsGasAndRejectsThirtyThree() public {
        DMXPaymentReceiver receiver = new DMXPaymentReceiver();
        receiver.configure(token, 0, 2);
        for (uint256 i = 1; i <= 32; ++i) {
            uint256 configId = token.registerRedemptionConfig(address(receiver), TREASURY2, 5000);
            _fund(configId, i, 2);
        }
        uint256[] memory oversized = _range(1, 33);
        vm.expectRevert(TarotCards.InvalidQuantity.selector);
        token.releaseRedemption(oversized);
        uint256 gasBefore = gasleft();
        token.releaseRedemption{gas: 6_000_000}(_range(1, 32));
        assertTrue(gasBefore - gasleft() < 5_600_000);
        assertEq(TREASURY2.balance, 32);
        assertEq(receiver.received(), 0);
        assertEq(address(token).balance, 32);
        for (uint256 i = 1; i <= 32; ++i) _credit(i, 1, 0);
    }

    function testInsufficientBatchGasRollsBackAllPaymentsAndAccounting() public {
        uint256 first = token.registerRedemptionConfig(TREASURY1, address(0), 0);
        DMXPaymentReceiver receiver = new DMXPaymentReceiver();
        uint256 second = token.registerRedemptionConfig(address(receiver), TREASURY2, 5000);
        receiver.configure(token, second, 2);
        _fund(first, 1, 1);
        _fund(second, 2, 2);
        (bool success, bytes memory reason) = address(token).call{gas: 210_000}(
            abi.encodeCall(token.releaseRedemption, (_two(first, second)))
        );
        assertFalse(success);
        assertEq(bytes32(bytes4(reason)), bytes32(TarotCards.InsufficientPayoutGas.selector));
        assertEq(TREASURY1.balance, 0);
        assertEq(TREASURY2.balance, 0);
        assertEq(address(token).balance, 3);
        _credit(first, 1, 0);
        _credit(second, 1, 1);
    }

    function testEmptyAndUnknownWithdrawalConfigsRevertWithoutPayingEarlierEntries() public {
        uint256 configId = token.registerRedemptionConfig(TREASURY1, address(0), 0);
        _fund(configId, 1, 7);
        uint256[] memory empty = new uint256[](0);
        vm.expectRevert(TarotCards.InvalidQuantity.selector);
        token.releaseRedemption(empty);
        for (uint256 i; i < 2; ++i) {
            uint256 invalid = i == 0 ? 0 : configId + 1;
            vm.expectRevert(TarotCards.InvalidRedemptionConfig.selector);
            token.releasableRedemption(invalid);
            vm.expectRevert(TarotCards.InvalidRedemptionConfig.selector);
            token.releaseRedemptionFor(invalid, false);
            uint256[] memory ids = _two(configId, invalid);
            vm.expectRevert(TarotCards.InvalidRedemptionConfig.selector);
            token.releaseRedemption(ids);
        }
        assertEq(TREASURY1.balance, 0);
        _credit(configId, 7, 0);
        token.releaseRedemptionFor(configId, true);
        _credit(configId, 7, 0);
    }

    function testDirectEthIsRejectedAndUnsolicitedBalanceIsNotDistributed() public {
        uint256 configId = token.registerRedemptionConfig(TREASURY1, TREASURY2, 5000);
        _fund(configId, 1, 10);
        vm.deal(address(this), 1);
        (bool accepted,) = address(token).call{value: 1}("");
        assertFalse(accepted);
        vm.deal(address(token), 1010);
        _credit(configId, 5, 5);
        token.releaseRedemption(_one(configId));
        assertEq(TREASURY1.balance, 5);
        assertEq(TREASURY2.balance, 5);
        assertEq(address(token).balance, 1000);
        _credit(configId, 0, 0);
    }

    function testBothPausesLeavePermissionlessWithdrawalsAvailable() public {
        uint256 configId = token.registerRedemptionConfig(TREASURY1, TREASURY2, 2500);
        _fund(configId, 1, 100);
        token.setMintingPaused(true);
        token.setRedemptionsPaused(true);
        vm.prank(BOB);
        token.releaseRedemptionFor(configId, true);
        assertEq(TREASURY2.balance, 25);
        vm.prank(ALICE);
        token.releaseRedemption(_one(configId));
        assertEq(TREASURY1.balance, 75);
        assertEq(address(token).balance, 0);
    }
}
