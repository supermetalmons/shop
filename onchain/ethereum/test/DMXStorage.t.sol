pragma solidity 0.8.38;

import {TarotCards} from "../src/TarotCards.sol";
import {DMXTestSupport, DMXStateReceiver} from "./DMXTestSupport.sol";

contract DMXStorageTest is DMXTestSupport {
    function setUp() public override {
        super.setUp();
        token.setRedemptionsPaused(false);
    }

    function testIssuanceAcrossBitmapBoundariesSurvivesRedemptionWithoutAffectingNeighbors() public {
        uint256[13] memory boundaries = [uint256(1), 255, 256, 257, 511, 512, 513, 767, 768, 769, 777, 778, 999_999];
        uint256[] memory ids = new uint256[](boundaries.length);
        for (uint256 i; i < ids.length; ++i) ids[i] = boundaries[i];

        token.mintTo(ALICE, ids);
        for (uint256 i; i < ids.length; ++i) _assertIssuance(ids[i], false);
        _assertUnissuedNeighbors();

        _redeem(ids, new uint256[](0), _quote(ALICE, BOB, 1, 0, 0));
        for (uint256 i; i < ids.length; ++i) {
            _assertIssuance(ids[i], true);
            _absent(ids[i]);
            assertEq(token.ownerOf(token.redemptionReceiptTokenId(ids[i])), BOB);
            if (ids[i] <= 777) assertEq(token.ownerOf(token.receiptTokenId(ids[i])), ALICE);
        }
        _assertUnissuedNeighbors();
    }

    function testClaimedIsFalseForReceiptsAndOutOfRangeGettersDoNotRevert() public {
        uint256[] memory ids = _two(1, 999_999);
        token.mintTo(ALICE, ids);
        _redeem(ids, new uint256[](0), _quote(ALICE, BOB, 1, 0, 0));

        uint256[3] memory receipts = [uint256(1_000_000), 1_000_777, 2_000_775];
        for (uint256 i; i < receipts.length; ++i) {
            assertTrue(token.issued(receipts[i]));
            assertFalse(token.claimed(receipts[i]));
        }
        assertFalse(token.claimed(999_999));

        uint256[4] memory invalid = [uint256(0), 2_000_776, uint256(type(uint32).max) + 1, type(uint256).max];
        for (uint256 i; i < invalid.length; ++i) {
            assertFalse(token.issued(invalid[i]));
            assertFalse(token.claimed(invalid[i]));
            vm.expectRevert(TarotCards.InvalidTokenId.selector);
            token.getTokenInfo(invalid[i]);
        }
    }

    function testFuzzIssuanceAndRedemptionDoNotChangeAdjacentCards(uint256 seed) public {
        uint256 cardId = seed % 999_999 + 1;
        uint256 neighbor = cardId == 999_999 ? cardId - 1 : cardId + 1;
        token.mintTo(ALICE, _one(cardId));
        _assertIssuance(cardId, false);
        _assertUnissued(neighbor);

        _redeem(_one(cardId), new uint256[](0), _quote(ALICE, BOB, 1, 0, 0));
        _assertIssuance(cardId, true);
        _assertUnissued(neighbor);
    }

    function testPackedRedemptionPreservesEightInputsAndNineOutputs() public {
        _assertPackedRoundTrip(8, 9);
    }

    function testPackedRedemptionPreservesNineInputsAndEightOutputs() public {
        _assertPackedRoundTrip(9, 8);
    }

    function testPackedRedemptionPreservesFiftyInputsAndOutputs() public {
        _assertPackedRoundTrip(50, 50);
    }

    function testRejectedReceiptRollsBackPackedRecordsBeforeShorterRetry() public {
        uint256[] memory inputs = _descendingIds(999_999, 9);
        uint256[] memory outputs = _range(700_000, 9);
        token.mintTo(ALICE, inputs);
        DMXStateReceiver receiver = new DMXStateReceiver();
        receiver.configure(token, token.redemptionReceiptTokenId(inputs[8]), "");
        TarotCards.RedemptionQuote memory quote = _quote(ALICE, address(receiver), 1, 0, 0);
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);

        vm.prank(ALICE);
        vm.expectRevert();
        token.redeem(inputs, outputs, quote, signature);
        assertFalse(token.usedRedemptionOrders(1));
        vm.expectRevert(TarotCards.InvalidAuthorization.selector);
        token.getRedemption(1);
        for (uint256 i; i < inputs.length; ++i) {
            assertEq(token.ownerOf(inputs[i]), ALICE);
            _assertIssuance(inputs[i], false);
            _assertUnissued(outputs[i]);
            assertEq(token.generation(outputs[i]), 0);
            assertEq(token.createdByOrder(outputs[i]), 0);
        }

        inputs = _descendingIds(999_999, 8);
        outputs = _range(700_000, 8);
        _redeem(inputs, outputs, quote);
        _assertRecord(1, address(receiver), inputs, outputs);
        assertEq(token.ownerOf(999_991), ALICE);
        _assertIssuance(999_991, false);
        _assertUnissued(700_008);
    }

    function _assertPackedRoundTrip(uint256 inputCount, uint256 outputCount) private {
        uint256[] memory inputs = _descendingIds(999_999, inputCount);
        uint256[] memory outputs = _range(700_000, outputCount);
        token.mintTo(ALICE, inputs);
        _redeem(inputs, outputs, _quote(ALICE, BOB, 1, 0, 0));
        _assertRecord(1, BOB, inputs, outputs);
    }

    function _assertRecord(uint256 orderId, address expectedRecipient, uint256[] memory inputs, uint256[] memory outputs)
        private view
    {
        (address wallet, address recipient, uint256[] memory storedInputs, uint256[] memory storedOutputs) =
            token.getRedemption(orderId);
        assertEq(wallet, ALICE);
        assertEq(recipient, expectedRecipient);
        _sameIds(storedInputs, inputs);
        _sameIds(storedOutputs, outputs);
    }

    function _assertIssuance(uint256 cardId, bool redeemed) private view {
        assertTrue(token.issued(cardId));
        assertTrue(token.claimed(cardId) == (cardId <= 777));
        assertTrue(token.issued(token.redemptionReceiptTokenId(cardId)) == redeemed);
        assertTrue(token.getTokenInfo(cardId).burned == redeemed);
        if (cardId <= 777) assertTrue(token.issued(token.receiptTokenId(cardId)));
    }

    function _assertUnissued(uint256 cardId) private view {
        assertFalse(token.issued(cardId));
        assertFalse(token.claimed(cardId));
        assertFalse(token.issued(token.redemptionReceiptTokenId(cardId)));
        if (cardId <= 777) assertFalse(token.issued(token.receiptTokenId(cardId)));
    }

    function _assertUnissuedNeighbors() private view {
        uint256[10] memory neighbors = [uint256(2), 254, 258, 510, 514, 766, 770, 776, 779, 999_998];
        for (uint256 i; i < neighbors.length; ++i) _assertUnissued(neighbors[i]);
    }

    function _descendingIds(uint256 highest, uint256 count) private pure returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) ids[i] = highest - i;
    }
}
