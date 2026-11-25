pragma solidity 0.8.38;

import {TarotCards} from "../src/TarotCards.sol";
import {IDMXTokenInfo} from "../src/IDMXRenderer.sol";
import {DMXTestSupport, DMXStateReceiver} from "./DMXTestSupport.sol";
import {Vm} from "./TestSupport.sol";

contract DMXRedemptionTest is DMXTestSupport {
    function setUp() public override {
        super.setUp();
        token.setRedemptionsPaused(false);
    }

    function testMergeSplitAndMixedGenerationsRetainEveryProofAndProvenance() public {
        token.mintTo(ALICE, _two(1, 778));
        uint256[] memory firstInputs = _two(778, 1);
        uint256[] memory firstOutputs = _two(779, 780);
        _redeem(firstInputs, firstOutputs, _quote(ALICE, BOB, 7, 0, 0));
        _absent(1);
        _absent(778);
        assertEq(token.ownerOf(1_000_000), ALICE);
        assertEq(token.ownerOf(1_000_777), BOB);
        assertEq(token.ownerOf(1_001_554), BOB);
        assertEq(token.ownerOf(779), BOB);
        assertEq(token.ownerOf(780), BOB);
        assertEq(token.generation(779), 1);
        assertEq(token.createdByOrder(779), 7);
        assertEq(token.redeemedByOrder(1), 7);
        (address wallet, address recipient, uint256[] memory storedInputs, uint256[] memory storedOutputs) =
            token.getRedemption(7);
        assertEq(wallet, ALICE);
        assertEq(recipient, BOB);
        _sameIds(storedInputs, firstInputs);
        _sameIds(storedOutputs, firstOutputs);
        token.mintTo(BOB, _one(781));
        _redeem(_two(781, 779), _one(999_999), _quote(BOB, ALICE, 8, 0, 0));
        assertEq(token.generation(999_999), 2);
        assertEq(token.createdByOrder(999_999), 8);
        assertEq(token.generation(779), 1);
        assertEq(token.createdByOrder(779), 7);
        assertEq(token.redeemedByOrder(779), 8);
        assertEq(token.ownerOf(1_001_555), ALICE);
        assertEq(token.ownerOf(1_001_557), ALICE);
        assertEq(token.ownerOf(780), BOB);
        assertEq(token.ownerOf(1_000_777), BOB);
        IDMXTokenInfo.TokenInfo memory info = token.getTokenInfo(779);
        assertTrue(info.burned);
        assertEq(uint256(info.kind), uint256(IDMXTokenInfo.TokenKind.Card));
        assertEq(info.generation, 1);
        assertEq(info.createdByOrder, 7);
        assertEq(info.redeemedByOrder, 8);
        info = token.getTokenInfo(1_001_555);
        assertFalse(info.burned);
        assertEq(uint256(info.kind), uint256(IDMXTokenInfo.TokenKind.RedemptionReceipt));
        assertEq(info.cardId, 779);
        assertEq(info.generation, 1);
        assertEq(info.createdByOrder, 7);
        assertEq(info.redeemedByOrder, 8);
    }

    function testBurnOnlyProducesOnePermanentReceiptForEveryInput() public {
        token.mintTo(ALICE, _two(1, 999_999));
        _redeem(_two(999_999, 1), new uint256[](0), _quote(ALICE, BOB, 1, 0, 0));
        assertEq(token.balanceOf(ALICE), 1);
        assertEq(token.ownerOf(1_000_000), ALICE);
        assertEq(token.balanceOf(BOB), 2);
        assertEq(token.ownerOf(2_000_775), BOB);
        assertEq(token.ownerOf(1_000_777), BOB);
        vm.startPrank(BOB);
        token.transferFrom(BOB, ALICE, 2_000_775);
        vm.expectRevert();
        token.transferFrom(BOB, address(0), 1_000_777);
        vm.stopPrank();
        assertEq(token.ownerOf(2_000_775), ALICE);
        uint256[] memory inputs = _one(2_000_775);
        uint256[] memory outputs = new uint256[](0);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 2, 0, 0);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidTokenId.selector);
        token.redeem(inputs, outputs, quote, signature);
        assertFalse(token.usedRedemptionOrders(2));
    }

    function testLifetimeIssuancePreventsRemintingBurnedInitialAndFutureCards() public {
        token.mintTo(ALICE, _two(1, 778));
        _redeem(_two(1, 778), _one(779), _quote(ALICE, ALICE, 1, 0, 0));
        uint256[] memory ids = _two(1, 778);
        vm.expectRevert();
        token.mintTo(BOB, ids);
        TarotCards.MintQuote memory mint = _mintQuote(BOB, 1);
        bytes memory signature = _mintSignature(ids, mint);
        vm.expectRevert();
        token.mintToAuthorized(ids, mint, signature);
        uint256 deadline = block.timestamp + 600;
        signature = _authorize(BOB, 1, deadline);
        vm.expectRevert(TarotCards.AlreadyClaimed.selector);
        token.claimTo(BOB, 1, deadline, signature);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 2, 0, 0);
        uint256[] memory inputs = _one(779);
        uint256[] memory outputs = _one(778);
        signature = _redemptionSignature(inputs, outputs, quote);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.AlreadyIssued.selector);
        token.redeem(inputs, outputs, quote, signature);
        assertEq(token.ownerOf(779), ALICE);
        assertTrue(token.issued(1));
        assertTrue(token.issued(778));
        assertTrue(token.claimed(1));
        assertFalse(token.usedMintAuthorizations(mint.authorizationId));
    }

    function testReceiptsAndUnissuedIdsCannotBeRedemptionInputs() public {
        token.mintTo(ALICE, _one(1));
        uint256[5] memory invalid = [uint256(0), 2, 1_000_000, 1_000_777, type(uint256).max];
        for (uint256 i; i < invalid.length; ++i) {
            uint256[] memory inputs = _one(invalid[i]);
            TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 1, 0, 0);
            bytes memory signature = invalid[i] > 999_999 ? bytes("") : _redemptionSignature(inputs, new uint256[](0), quote);
            vm.prank(ALICE);
            vm.expectRevert();
            token.redeem(inputs, new uint256[](0), quote, signature);
            assertEq(token.ownerOf(1), ALICE);
            assertEq(token.ownerOf(1_000_000), ALICE);
            assertFalse(token.usedRedemptionOrders(1));
        }
    }

    function testApprovedOperatorCannotBurnAnotherHoldersCards() public {
        token.mintTo(ALICE, _one(778));
        vm.prank(ALICE);
        token.setApprovalForAll(BOB, true);
        uint256[] memory inputs = _one(778);
        uint256[] memory outputs = _one(779);
        TarotCards.RedemptionQuote memory quote = _quote(BOB, BOB, 1, 0, 0);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        vm.prank(BOB);
        vm.expectRevert(TarotCards.WrongOwner.selector);
        token.redeem(inputs, outputs, quote, signature);
        quote = _quote(ALICE, ALICE, 1, 0, 0);
        signature = _redemptionSignature(inputs, outputs, quote);
        vm.prank(BOB);
        vm.expectRevert(TarotCards.InvalidAuthorization.selector);
        token.redeem(inputs, outputs, quote, signature);
        assertEq(token.ownerOf(778), ALICE);
    }

    function testOwnershipIsRecheckedAtExecutionAndQuoteSurvivesFailedAttempt() public {
        token.mintTo(ALICE, _two(778, 779));
        uint256[] memory inputs = _two(778, 779);
        uint256[] memory outputs = _one(780);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, BOB, 1, 0, 0);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        vm.prank(ALICE);
        token.transferFrom(ALICE, BOB, 779);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.WrongOwner.selector);
        token.redeem(inputs, outputs, quote, signature);
        assertFalse(token.usedRedemptionOrders(1));
        assertEq(token.redeemedByOrder(778), 0);
        assertFalse(token.issued(1_001_554));
        vm.prank(BOB);
        token.transferFrom(BOB, ALICE, 779);
        vm.prank(ALICE);
        token.redeem(inputs, outputs, quote, signature);
        assertEq(token.ownerOf(780), BOB);
    }

    function testDuplicateInputsAndOutputsAndInputOutputOverlapRevertAtomically() public {
        token.mintTo(ALICE, _two(778, 779));
        uint256[][] memory inputs = new uint256[][](4);
        uint256[][] memory outputs = new uint256[][](4);
        inputs[0] = _two(778, 778);
        outputs[0] = _one(780);
        inputs[1] = _two(778, 779);
        outputs[1] = _two(780, 780);
        inputs[2] = _one(778);
        outputs[2] = _one(778);
        inputs[3] = _one(778);
        outputs[3] = _one(779);
        for (uint256 i; i < inputs.length; ++i) {
            TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 1, 0, 0);
            bytes memory signature = _redemptionSignature(inputs[i], outputs[i], quote);
            vm.prank(ALICE);
            vm.expectRevert(TarotCards.AlreadyIssued.selector);
            token.redeem(inputs[i], outputs[i], quote, signature);
            _assertSeedUnchanged();
        }
    }

    function testRedemptionBatchBoundsAndOutputNamespace() public {
        token.mintTo(ALICE, _two(778, 779));
        uint256[][] memory inputs = new uint256[][](7);
        uint256[][] memory outputs = new uint256[][](7);
        inputs[0] = new uint256[](0);
        inputs[1] = _range(778, 51);
        inputs[2] = _one(778);
        outputs[0] = _one(780);
        outputs[1] = _one(900);
        outputs[2] = _range(900, 51);
        uint256[4] memory invalid = [uint256(0), 777, 1_000_000, type(uint256).max];
        for (uint256 i; i < invalid.length; ++i) {
            inputs[i + 3] = _one(778);
            outputs[i + 3] = _one(invalid[i]);
        }
        for (uint256 i; i < inputs.length; ++i) {
            TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 1, 0, 0);
            bytes memory signature = _redemptionSignature(inputs[i], outputs[i], quote);
            vm.prank(ALICE);
            vm.expectRevert();
            token.redeem(inputs[i], outputs[i], quote, signature);
            _assertSeedUnchanged();
        }
    }

    function testRedemptionAuthorizationBindsBothArraysAndEveryQuoteField() public {
        token.mintTo(ALICE, _two(778, 779));
        uint256[] memory inputs = _two(778, 779);
        uint256[] memory outputs = _two(780, 781);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, BOB, 1, 0, 0);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        for (uint256 i; i < 6; ++i) {
            TarotCards.RedemptionQuote memory changed = _quote(ALICE, BOB, 1, 0, 0);
            if (i == 0) changed.wallet = BOB;
            else if (i == 1) changed.recipient = ALICE;
            else if (i == 2) changed.orderId = 2;
            else if (i == 3) changed.fee = 1;
            else if (i == 4) changed.deadline--;
            else changed.configId = 1;
            vm.deal(ALICE, changed.fee);
            vm.prank(ALICE);
            vm.expectRevert(TarotCards.InvalidAuthorization.selector);
            token.redeem{value: changed.fee}(inputs, outputs, changed, signature);
        }
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidAuthorization.selector);
        token.redeem(_two(779, 778), outputs, quote, signature);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidAuthorization.selector);
        token.redeem(inputs, _two(781, 780), quote, signature);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidAuthorization.selector);
        token.redeem(inputs, _one(780), quote, signature);
        _assertSeedUnchanged();
        vm.prank(ALICE);
        token.redeem(inputs, outputs, quote, signature);
    }

    function testRedemptionAuthorizationRejectsOtherDomainAndWrongReceiptCommitment() public {
        token.mintTo(ALICE, _one(778));
        uint256[] memory inputs = _one(778);
        uint256[] memory outputs = _one(779);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 1, 0, 0);
        bytes32[3] memory digests;
        digests[0] = _redemptionDigest(inputs, outputs, quote, address(token), 1);
        digests[1] = _redemptionDigest(inputs, outputs, quote, BOB, block.chainid);
        digests[2] = _wrongReceiptDigest(inputs, outputs, quote);
        for (uint256 i; i < digests.length; ++i) {
            bytes memory signature = _sign(SIGNER_KEY, digests[i]);
            vm.prank(ALICE);
            vm.expectRevert(TarotCards.InvalidAuthorization.selector);
            token.redeem(inputs, outputs, quote, signature);
        }
        assertEq(token.ownerOf(778), ALICE);
        assertFalse(token.usedRedemptionOrders(1));
    }

    function testOrderReplayIsRejectedEvenForFreshInputsAndNewSignature() public {
        token.mintTo(ALICE, _two(778, 779));
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 1, 0, 0);
        _redeem(_one(778), new uint256[](0), quote);
        uint256[] memory inputs = _one(779);
        uint256[] memory outputs = _one(780);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.AuthorizationAlreadyUsed.selector);
        token.redeem(inputs, outputs, quote, signature);
        assertEq(token.ownerOf(779), ALICE);
        assertFalse(token.issued(780));
    }

    function testInvalidOrderRecipientDeadlineAndSignatureLeaveInputsUnspent() public {
        token.mintTo(ALICE, _one(778));
        uint256[] memory inputs = _one(778);
        uint256[] memory outputs = _one(779);
        for (uint256 i; i < 7; ++i) {
            TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 1, 0, 0);
            if (i == 0) quote.orderId = 0;
            else if (i == 1) quote.recipient = address(0);
            else if (i == 2) quote.recipient = address(token);
            else if (i == 3) quote.deadline = block.timestamp;
            else if (i == 4) quote.deadline = block.timestamp - 1;
            else if (i == 5) quote.deadline = block.timestamp + 601;
            else quote.deadline = type(uint256).max;
            bytes memory signature = _redemptionSignature(inputs, outputs, quote);
            vm.prank(ALICE);
            vm.expectRevert();
            token.redeem(inputs, outputs, quote, signature);
        }
        TarotCards.RedemptionQuote memory valid = _quote(ALICE, ALICE, 1, 0, 0);
        bytes[] memory bad = new bytes[](3);
        bad[0] = "";
        bad[1] = new bytes(65);
        bad[2] = _sign(NEXT_SIGNER_KEY, _redemptionDigest(inputs, outputs, valid, address(token), block.chainid));
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(ALICE);
            vm.expectRevert();
            token.redeem(inputs, outputs, valid, bad[i]);
        }
        assertFalse(token.usedRedemptionOrders(1));
        _redeem(inputs, outputs, valid);
    }

    function testExactPaymentAndValidConfigurationAreRequiredForPaidRedemption() public {
        token.mintTo(ALICE, _one(778));
        uint256 configId = token.registerRedemptionConfig(TREASURY1, address(0), 0);
        uint256[] memory inputs = _one(778);
        uint256[] memory outputs = new uint256[](0);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 1, 10, configId);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        vm.deal(ALICE, 11);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.WrongPayment.selector);
        token.redeem{value: 9}(inputs, outputs, quote, signature);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.WrongPayment.selector);
        token.redeem{value: 11}(inputs, outputs, quote, signature);
        quote.configId = 0;
        signature = _redemptionSignature(inputs, outputs, quote);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidRedemptionConfig.selector);
        token.redeem{value: 10}(inputs, outputs, quote, signature);
        quote.configId = 2;
        signature = _redemptionSignature(inputs, outputs, quote);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidRedemptionConfig.selector);
        token.redeem{value: 10}(inputs, outputs, quote, signature);
        assertEq(_configReceived(configId), 0);
        assertEq(address(token).balance, 0);
        quote.configId = configId;
        _redeem(inputs, outputs, quote);
        assertEq(_configReceived(configId), 10);
        assertEq(address(token).balance, 10);
        assertEq(TREASURY1.balance, 0);
    }

    function testFreeRedemptionAcceptsZeroOrExistingConfigButRejectsMissingConfig() public {
        token.mintTo(ALICE, _range(778, 3));
        uint256 configId = token.registerRedemptionConfig(TREASURY1, address(0), 0);
        _redeem(_one(778), new uint256[](0), _quote(ALICE, ALICE, 1, 0, 0));
        _redeem(_one(779), new uint256[](0), _quote(ALICE, ALICE, 2, 0, configId));
        uint256[] memory inputs = _one(780);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 3, 0, configId + 1);
        bytes memory signature = _redemptionSignature(inputs, new uint256[](0), quote);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidRedemptionConfig.selector);
        token.redeem(inputs, new uint256[](0), quote, signature);
        assertEq(_configReceived(configId), 0);
        assertEq(address(token).balance, 0);
    }

    function testRedemptionPauseIsIndependentFromMintPauseAndDoesNotConsumeQuote() public {
        token.mintTo(ALICE, _one(778));
        uint256[] memory inputs = _one(778);
        uint256[] memory outputs = _one(779);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, ALICE, 1, 0, 0);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        token.setRedemptionsPaused(true);
        token.mintTo(BOB, _one(780));
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.RedemptionsPaused.selector);
        token.redeem(inputs, outputs, quote, signature);
        assertFalse(token.usedRedemptionOrders(1));
        vm.prank(ALICE);
        vm.expectRevert();
        token.setRedemptionsPaused(false);
        token.setMintingPaused(true);
        token.setRedemptionsPaused(false);
        vm.prank(ALICE);
        token.redeem(inputs, outputs, quote, signature);
        assertEq(token.ownerOf(779), ALICE);
    }

    function testSignerRotationInvalidatesPreparedRedemption() public {
        token.mintTo(ALICE, _one(778));
        uint256[] memory inputs = _one(778);
        uint256[] memory outputs = _one(779);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, BOB, 1, 0, 0);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        token.setQuoteSigner(vm.addr(NEXT_SIGNER_KEY));
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidAuthorization.selector);
        token.redeem(inputs, outputs, quote, signature);
        signature = _sign(NEXT_SIGNER_KEY, _redemptionDigest(inputs, outputs, quote, address(token), block.chainid));
        vm.prank(ALICE);
        token.redeem(inputs, outputs, quote, signature);
    }

    function testEveryCallbackSeesAllInputsBurnedOutputsReservedAndCompleteProvenance() public {
        token.mintTo(ALICE, _two(1, 778));
        DMXStateReceiver receiver = new DMXStateReceiver();
        uint256[] memory inputs = _two(1, 778);
        uint256[] memory outputs = _two(779, 780);
        receiver.configure(token, 0, "");
        receiver.observe(1, inputs, outputs);
        receiver.forward(BOB);
        _redeem(inputs, outputs, _quote(ALICE, address(receiver), 1, 0, 0));
        assertEq(receiver.callbacks(), 4);
        assertEq(token.balanceOf(BOB), 4);
        assertEq(token.balanceOf(address(receiver)), 0);
        assertEq(token.ownerOf(1_000_000), ALICE);
        (, address recipient,,) = token.getRedemption(1);
        assertEq(recipient, address(receiver));
    }

    function testRejectedOutputOrReceiptRollsBackBurnsNonceFeesAndProvenance() public {
        token.mintTo(ALICE, _two(778, 779));
        DMXStateReceiver receiver = new DMXStateReceiver();
        uint256 configId = token.registerRedemptionConfig(TREASURY1, address(0), 0);
        uint256[] memory inputs = _two(778, 779);
        uint256[] memory outputs = _two(780, 781);
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, address(receiver), 1, 100, configId);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        receiver.observe(1, inputs, outputs);
        uint256[4] memory rejected = [uint256(780), 781, 1_001_554, 1_001_555];
        for (uint256 i; i < rejected.length; ++i) {
            receiver.configure(token, rejected[i], "");
            vm.deal(ALICE, 100);
            vm.prank(ALICE);
            vm.expectRevert();
            token.redeem{value: 100}(inputs, outputs, quote, signature);
            _assertSeedUnchanged();
            assertFalse(token.issued(781));
            assertEq(_configReceived(configId), 0);
            assertEq(address(token).balance, 0);
            assertEq(receiver.callbacks(), 0);
            assertEq(token.generation(780), 0);
            assertEq(token.createdByOrder(780), 0);
            vm.expectRevert(TarotCards.InvalidAuthorization.selector);
            token.getRedemption(1);
        }
        receiver.configure(token, 0, "");
        _redeem(inputs, outputs, quote);
        assertEq(receiver.callbacks(), 4);
        assertEq(_configReceived(configId), 100);
    }

    function testRedemptionCallbacksCannotReenterProtectedMintRedemptionOrReleaseRoutes() public {
        DMXStateReceiver receiver = new DMXStateReceiver();
        uint256 deadline = block.timestamp + 600;
        bytes memory claimSignature = _authorize(address(receiver), 1, deadline);
        TarotCards.MintQuote memory mint = _mintQuote(address(receiver), 1);
        uint256[] memory mintIds = _one(900);
        bytes memory mintSignature = _mintSignature(mintIds, mint);
        TarotCards.RedemptionQuote memory nested = _quote(address(receiver), address(receiver), 100, 0, 0);
        bytes memory nestedSignature = _redemptionSignature(_one(901), new uint256[](0), nested);
        bytes[] memory calls = new bytes[](6);
        calls[0] = abi.encodeCall(token.claim, (1, deadline, claimSignature));
        calls[1] = abi.encodeCall(token.claimTo, (address(receiver), 1, deadline, claimSignature));
        calls[2] = abi.encodeCall(token.mintToAuthorized, (mintIds, mint, mintSignature));
        calls[3] = abi.encodeCall(token.redeem, (_one(901), new uint256[](0), nested, nestedSignature));
        calls[4] = abi.encodeCall(token.releaseRedemptionFor, (1, false));
        calls[5] = abi.encodeCall(token.releaseRedemption, (_one(1)));
        for (uint256 i; i < calls.length; ++i) {
            token.mintTo(ALICE, _one(778 + i));
            receiver.configure(token, 0, calls[i]);
            _redeem(_one(778 + i), _one(800 + i), _quote(ALICE, address(receiver), i + 1, 0, 0));
        }
        assertEq(receiver.blockedCalls(), 12);
        assertFalse(token.claimed(1));
        assertFalse(token.issued(900));
        assertFalse(token.usedMintAuthorizations(mint.authorizationId));
        assertFalse(token.usedRedemptionOrders(100));
    }

    function testInitialRedemptionRefreshesTheExistingNfcReceiptMetadata() public {
        token.mintTo(ALICE, _two(1, 778));
        vm.recordLogs();
        _redeem(_two(1, 778), new uint256[](0), _quote(ALICE, BOB, 1, 0, 0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 updates;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("MetadataUpdate(uint256)")) {
                updates++;
                assertEq(abi.decode(logs[i].data, (uint256)), 1_000_000);
            }
        }
        assertEq(updates, 1);
        IDMXTokenInfo.TokenInfo memory proof = token.getTokenInfo(1_000_000);
        assertEq(proof.redeemedByOrder, 1);
        assertFalse(proof.burned);
    }

    function testBurnedCardInfoRemainsReadableButTokenUriRequiresExistence() public {
        token.mintTo(ALICE, _one(778));
        _redeem(_one(778), new uint256[](0), _quote(ALICE, ALICE, 1, 0, 0));
        assertTrue(token.getTokenInfo(778).burned);
        vm.expectRevert();
        token.tokenURI(778);
        assertEq(token.tokenURI(1_001_554), "fixture-token");
        vm.expectRevert(TarotCards.InvalidTokenId.selector);
        token.getTokenInfo(779);
        vm.expectRevert(TarotCards.InvalidAuthorization.selector);
        token.getRedemption(0);
    }

    function testMaximumFiftyInputFiftyOutputRedemptionFitsTransactionGasBudget() public {
        uint256[] memory inputs = _range(1, 50);
        uint256[] memory outputs = _range(999_950, 50);
        token.mintTo(ALICE, inputs);
        uint256 gasBefore = gasleft();
        _redeem(inputs, outputs, _quote(ALICE, BOB, 1, 0, 0));
        uint256 gasUsed = gasBefore - gasleft();
        assertTrue(gasUsed < 16_000_000);
        assertEq(token.balanceOf(ALICE), 50);
        assertEq(token.balanceOf(BOB), 100);
        for (uint256 i; i < 50; ++i) {
            _absent(inputs[i]);
            assertEq(token.ownerOf(outputs[i]), BOB);
            assertEq(token.ownerOf(1_000_776 + inputs[i]), BOB);
            assertEq(token.ownerOf(999_999 + inputs[i]), ALICE);
            assertEq(token.generation(outputs[i]), 1);
        }
    }

    function testRedemptionDigestMatchesSharedFixture() public pure {
        TarotCards.RedemptionQuote memory quote = TarotCards.RedemptionQuote(7,
            0x1111111111111111111111111111111111111111, 0x2222222222222222222222222222222222222222,
            123_456_789, 2_000_000_600, 2);
        assertEq(_redemptionDigest(_two(1, 778), _two(779, 780), quote,
            0x3333333333333333333333333333333333333333, 11155111),
            0x9bb9dc12e7d0cd784083141a4550dca3758e5552bc137a1c44cb8afcdf74b5a9);
    }

    function testFuzzReceiptNamespacesAreDisjointAndOneToOne(uint256 firstSeed, uint256 secondSeed) public view {
        uint256 initial = firstSeed % 777 + 1;
        uint256 card = secondSeed % 999_999 + 1;
        uint256 nfc = token.receiptTokenId(initial);
        uint256 receipt = token.redemptionReceiptTokenId(card);
        assertTrue(nfc >= 1_000_000 && nfc <= 1_000_776);
        assertTrue(receipt >= 1_000_777 && receipt <= 2_000_775);
        assertTrue(nfc != receipt);
        assertEq(receipt - 1_000_776, card);
        assertEq(nfc - 999_999, initial);
    }

    function testFuzzRepeatedTransformationsConserveProofsAndIncrementMixedGenerations(
        uint8 inputSeed, uint8 outputSeed, uint8 finalSeed
    ) public {
        uint256 inputCount = uint256(inputSeed) % 8 + 1;
        uint256 outputCount = uint256(outputSeed) % 8 + 1;
        uint256 finalCount = uint256(finalSeed) % 9;
        uint256[] memory inputs = _range(1, inputCount);
        uint256[] memory outputs = _range(778, outputCount);
        token.mintTo(ALICE, inputs);
        _redeem(inputs, outputs, _quote(ALICE, BOB, 7, 0, 0));
        token.mintTo(BOB, _one(1_000));
        uint256[] memory mixed = new uint256[](outputCount + 1);
        mixed[0] = 1_000;
        for (uint256 i; i < outputCount; ++i) mixed[i + 1] = outputs[outputCount - i - 1];
        uint256[] memory finalOutputs = _range(900, finalCount);
        _redeem(mixed, finalOutputs, _quote(BOB, ALICE, 8, 0, 0));
        assertEq(token.balanceOf(ALICE), inputCount + outputCount + 1 + finalCount);
        assertEq(token.balanceOf(BOB), inputCount);
        for (uint256 i; i < inputCount; ++i) {
            _absent(inputs[i]);
            assertEq(token.ownerOf(999_999 + inputs[i]), ALICE);
            assertEq(token.ownerOf(1_000_776 + inputs[i]), BOB);
            assertEq(token.redeemedByOrder(inputs[i]), 7);
        }
        for (uint256 i; i < outputCount; ++i) {
            _absent(outputs[i]);
            assertEq(token.ownerOf(1_000_776 + outputs[i]), ALICE);
            assertEq(token.generation(outputs[i]), 1);
            assertEq(token.createdByOrder(outputs[i]), 7);
            assertEq(token.redeemedByOrder(outputs[i]), 8);
        }
        for (uint256 i; i < finalCount; ++i) {
            assertEq(token.ownerOf(finalOutputs[i]), ALICE);
            assertEq(token.generation(finalOutputs[i]), 2);
            assertEq(token.createdByOrder(finalOutputs[i]), 8);
            assertEq(token.redeemedByOrder(finalOutputs[i]), 0);
        }
        assertEq(token.ownerOf(1_001_776), ALICE);
        assertEq(token.generation(1_000), 0);
        assertEq(token.createdByOrder(1_000), 0);
        assertEq(token.redeemedByOrder(1_000), 8);
        (,, uint256[] memory storedInputs, uint256[] memory storedOutputs) = token.getRedemption(8);
        _sameIds(storedInputs, mixed);
        _sameIds(storedOutputs, finalOutputs);
    }

    function _assertSeedUnchanged() private view {
        assertEq(token.ownerOf(778), ALICE);
        assertEq(token.ownerOf(779), ALICE);
        assertFalse(token.usedRedemptionOrders(1));
        assertFalse(token.issued(780));
        assertFalse(token.issued(1_001_554));
        assertFalse(token.issued(1_001_555));
        assertEq(token.redeemedByOrder(778), 0);
        assertEq(token.redeemedByOrder(779), 0);
    }

    function _wrongReceiptDigest(uint256[] memory inputs, uint256[] memory outputs, TarotCards.RedemptionQuote memory quote)
        private view returns (bytes32)
    {
        return _typedDigest(keccak256(abi.encode(
            keccak256("DMXRedemption(address wallet,address recipient,bytes32 inputIdsHash,bytes32 outputIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline,uint256 configId)"),
            quote.wallet, quote.recipient, keccak256(abi.encode(inputs)), keccak256(abi.encode(outputs)),
            keccak256(abi.encode(_one(1_001_555))), quote.orderId, quote.fee, quote.deadline, quote.configId
        )), address(token), block.chainid);
    }
}
