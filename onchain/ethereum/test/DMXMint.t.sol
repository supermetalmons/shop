pragma solidity 0.8.38;

import {TarotCards} from "../src/TarotCards.sol";
import {IDMXTokenInfo} from "../src/IDMXRenderer.sol";
import {DMXTestSupport, DMXStateReceiver} from "./DMXTestSupport.sol";
import {Vm} from "./TestSupport.sol";

contract DMXMintTest is DMXTestSupport {
    function testRelayerClaimsToSignedRecipientAndCannotRedirect() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(BOB, 777, deadline);
        vm.prank(ALICE);
        vm.expectRevert();
        token.claimTo(ALICE, 777, deadline, signature);
        vm.prank(ALICE);
        token.claimTo(BOB, 777, deadline, signature);
        assertEq(token.ownerOf(777), BOB);
        assertEq(token.ownerOf(1_000_776), BOB);
        assertEq(token.balanceOf(ALICE), 0);
        assertTrue(token.claimed(777));
    }

    function testOwnerMintsMixedUnorderedCardsWithOnlyInitialReceiptPairs() public {
        uint256[] memory ids = new uint256[](4);
        ids[0] = 999_999;
        ids[1] = 777;
        ids[2] = 778;
        ids[3] = 1;
        token.mintTo(ALICE, ids);
        assertEq(token.balanceOf(ALICE), 6);
        assertEq(token.ownerOf(1_000_000), ALICE);
        assertEq(token.ownerOf(1_000_776), ALICE);
        assertFalse(token.issued(1_000_777));
        for (uint256 i; i < ids.length; ++i) {
            assertEq(token.ownerOf(ids[i]), ALICE);
            assertTrue(token.issued(ids[i]));
            assertEq(token.generation(ids[i]), 0);
            assertEq(token.createdByOrder(ids[i]), 0);
            IDMXTokenInfo.TokenInfo memory info = token.getTokenInfo(ids[i]);
            assertEq(uint256(info.kind), uint256(IDMXTokenInfo.TokenKind.Card));
            assertEq(info.cardId, ids[i]);
            assertFalse(info.burned);
        }
        assertTrue(token.claimed(1));
        assertTrue(token.claimed(777));
        assertFalse(token.claimed(778));
    }

    function testSignedMintIsRelayableAndUsesIndependentAuthorizationNamespace() public {
        uint256[] memory ids = _two(999_999, 1);
        TarotCards.MintQuote memory quote = _mintQuote(BOB, 1);
        bytes memory signature = _mintSignature(ids, quote);
        vm.recordLogs();
        vm.prank(ALICE);
        token.mintToAuthorized(ids, quote, signature);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory minted = logs[logs.length - 1];
        assertEq(minted.topics[0], keccak256("CardsMinted(address,bytes32,uint256[])"));
        assertEq(minted.topics[1], bytes32(uint256(uint160(BOB))));
        assertEq(minted.topics[2], bytes32(uint256(1)));
        _sameIds(abi.decode(minted.data, (uint256[])), ids);
        assertTrue(token.usedMintAuthorizations(bytes32(uint256(1))));
        assertEq(token.balanceOf(BOB), 3);
        assertEq(token.ownerOf(1_000_000), BOB);
        token.setRedemptionsPaused(false);
        _redeem(_one(999_999), new uint256[](0), _quote(BOB, BOB, 1, 0, 0));
        assertTrue(token.usedRedemptionOrders(1));
    }

    function testOwnerMintRequiresCurrentAcceptedOwner() public {
        vm.prank(ALICE);
        vm.expectRevert();
        token.mintTo(ALICE, _one(778));
        token.transferOwnership(BOB);
        vm.prank(BOB);
        vm.expectRevert();
        token.mintTo(ALICE, _one(778));
        vm.prank(BOB);
        token.acceptOwnership();
        vm.expectRevert();
        token.mintTo(ALICE, _one(778));
        vm.prank(BOB);
        token.mintTo(ALICE, _one(778));
        assertEq(token.ownerOf(778), ALICE);
    }

    function testAllMintPathsRejectZeroAndCollectionRecipient() public {
        address[2] memory recipients = [address(0), address(token)];
        uint256[] memory ids = _one(1);
        for (uint256 i; i < recipients.length; ++i) {
            uint256 deadline = block.timestamp + 600;
            bytes memory signature = _authorize(recipients[i], 1, deadline);
            vm.expectRevert();
            token.claimTo(recipients[i], 1, deadline, signature);
            vm.expectRevert();
            token.mintTo(recipients[i], ids);
            TarotCards.MintQuote memory quote = _mintQuote(recipients[i], i + 1);
            signature = _mintSignature(ids, quote);
            vm.expectRevert();
            token.mintToAuthorized(ids, quote, signature);
        }
        assertFalse(token.issued(1));
    }

    function testMintBatchBoundsAndNamespacesAreEnforcedAtomically() public {
        uint256[][6] memory invalid;
        invalid[0] = new uint256[](0);
        invalid[1] = _range(778, 51);
        invalid[2] = _two(1, 0);
        invalid[3] = _two(1, 1_000_000);
        invalid[4] = _two(1, 2_000_775);
        invalid[5] = _two(1, type(uint256).max);
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert();
            token.mintTo(ALICE, invalid[i]);
            TarotCards.MintQuote memory quote = _mintQuote(ALICE, i + 1);
            bytes memory signature = _mintSignature(invalid[i], quote);
            vm.expectRevert();
            token.mintToAuthorized(invalid[i], quote, signature);
            assertFalse(token.usedMintAuthorizations(quote.authorizationId));
            assertFalse(token.issued(1));
            assertFalse(token.claimed(1));
            assertEq(token.balanceOf(ALICE), 0);
        }
    }

    function testDuplicatesAndExistingIdsRollBackEveryBatchMintRoute() public {
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 778;
        ids[2] = 1;
        TarotCards.MintQuote memory quote = _mintQuote(ALICE, 1);
        bytes memory signature = _mintSignature(ids, quote);
        vm.expectRevert();
        token.mintTo(ALICE, ids);
        vm.expectRevert();
        token.mintToAuthorized(ids, quote, signature);
        assertFalse(token.issued(778));
        assertFalse(token.claimed(1));
        assertFalse(token.issued(1_000_000));
        assertFalse(token.usedMintAuthorizations(quote.authorizationId));
        _claim(BOB, 1);
        ids = _two(778, 1);
        signature = _mintSignature(ids, quote);
        vm.expectRevert();
        token.mintToAuthorized(ids, quote, signature);
        assertEq(token.ownerOf(1), BOB);
        assertFalse(token.issued(778));
        token.mintTo(ALICE, _one(778));
    }

    function testInitialClaimStateIsSharedAcrossAllMintRoutes() public {
        token.mintTo(ALICE, _one(1));
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(BOB, 1, deadline);
        vm.expectRevert();
        token.claimTo(BOB, 1, deadline, signature);
        TarotCards.MintQuote memory quote = _mintQuote(BOB, 1);
        uint256[] memory ids = _one(2);
        token.mintToAuthorized(ids, quote, _mintSignature(ids, quote));
        assertTrue(token.claimed(2));
        vm.expectRevert();
        token.mintTo(ALICE, ids);
        signature = _authorize(ALICE, 2, deadline);
        vm.prank(ALICE);
        vm.expectRevert();
        token.claim(2, deadline, signature);
    }

    function testMintAuthorizationBindsEveryFieldChainAndContract() public {
        uint256[] memory ids = _two(778, 779);
        TarotCards.MintQuote memory quote = _mintQuote(ALICE, 1);
        bytes memory signature = _mintSignature(ids, quote);
        TarotCards.MintQuote memory modified = _mintQuote(BOB, 1);
        vm.expectRevert();
        token.mintToAuthorized(ids, modified, signature);
        modified = _mintQuote(ALICE, 2);
        vm.expectRevert();
        token.mintToAuthorized(ids, modified, signature);
        modified = _mintQuote(ALICE, 1);
        modified.deadline--;
        vm.expectRevert();
        token.mintToAuthorized(ids, modified, signature);
        vm.expectRevert();
        token.mintToAuthorized(_two(779, 778), quote, signature);
        vm.expectRevert();
        token.mintToAuthorized(_two(778, 780), quote, signature);
        bytes memory wrongChain = _sign(SIGNER_KEY, _mintDigest(ids, quote, address(token), 1));
        vm.expectRevert();
        token.mintToAuthorized(ids, quote, wrongChain);
        bytes memory wrongContract = _sign(SIGNER_KEY, _mintDigest(ids, quote, BOB, block.chainid));
        vm.expectRevert();
        token.mintToAuthorized(ids, quote, wrongContract);
        token.mintToAuthorized(ids, quote, signature);
        vm.expectRevert();
        token.mintToAuthorized(ids, quote, signature);
        vm.prank(ALICE);
        token.transferFrom(ALICE, BOB, 778);
        vm.expectRevert();
        token.mintToAuthorized(ids, quote, signature);
    }

    function testMintAuthorizationRejectsZeroNonceDeadlinesAndRotatedSigner() public {
        uint256[] memory ids = _one(778);
        TarotCards.MintQuote memory quote = _mintQuote(ALICE, 0);
        bytes memory signature = _mintSignature(ids, quote);
        vm.expectRevert();
        token.mintToAuthorized(ids, quote, signature);
        uint256[4] memory deadlines = [block.timestamp - 1, block.timestamp, block.timestamp + 601, type(uint256).max];
        for (uint256 i; i < deadlines.length; ++i) {
            quote = _mintQuote(ALICE, 1);
            quote.deadline = deadlines[i];
            signature = _mintSignature(ids, quote);
            vm.expectRevert();
            token.mintToAuthorized(ids, quote, signature);
        }
        quote = _mintQuote(ALICE, 1);
        signature = _mintSignature(ids, quote);
        token.setQuoteSigner(vm.addr(NEXT_SIGNER_KEY));
        vm.expectRevert();
        token.mintToAuthorized(ids, quote, signature);
        signature = _sign(NEXT_SIGNER_KEY, _mintDigest(ids, quote, address(token), block.chainid));
        token.mintToAuthorized(ids, quote, signature);
    }

    function testMintPauseCoversEveryMintPathAndLeavesTransfersIndependent() public {
        _claim(ALICE, 1);
        token.setMintingPaused(true);
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(ALICE, 2, deadline);
        vm.prank(ALICE);
        vm.expectRevert();
        token.claim(2, deadline, signature);
        vm.expectRevert();
        token.claimTo(ALICE, 2, deadline, signature);
        vm.expectRevert();
        token.mintTo(ALICE, _one(2));
        TarotCards.MintQuote memory quote = _mintQuote(ALICE, 1);
        uint256[] memory ids = _one(778);
        signature = _mintSignature(ids, quote);
        vm.expectRevert();
        token.mintToAuthorized(ids, quote, signature);
        vm.prank(ALICE);
        token.transferFrom(ALICE, BOB, 1);
        assertEq(token.ownerOf(1), BOB);
        vm.prank(ALICE);
        vm.expectRevert();
        token.setMintingPaused(false);
        token.setMintingPaused(false);
        token.mintToAuthorized(ids, quote, signature);
    }

    function testEveryMintReservesCompleteBatchBeforeCallbacksAndCanForwardOutputs() public {
        DMXStateReceiver receiver = new DMXStateReceiver();
        uint256[] memory ids = new uint256[](3);
        ids[0] = 778;
        ids[1] = 1;
        ids[2] = 777;
        receiver.configure(token, 0, "");
        receiver.observeMint(ids);
        receiver.forward(BOB);
        token.mintTo(address(receiver), ids);
        assertEq(receiver.callbacks(), 5);
        assertEq(token.balanceOf(address(receiver)), 0);
        assertEq(token.balanceOf(BOB), 5);
        for (uint256 i; i < ids.length; ++i) assertEq(token.ownerOf(ids[i]), BOB);
    }

    function testSignedMintRejectionRollsBackNonceIssuanceAndClaimState() public {
        DMXStateReceiver receiver = new DMXStateReceiver();
        uint256[] memory ids = _two(1, 778);
        TarotCards.MintQuote memory quote = _mintQuote(address(receiver), 1);
        bytes memory signature = _mintSignature(ids, quote);
        uint256[3] memory rejected = [uint256(1), 1_000_000, 778];
        for (uint256 i; i < rejected.length; ++i) {
            receiver.configure(token, rejected[i], "");
            vm.expectRevert();
            token.mintToAuthorized(ids, quote, signature);
            assertFalse(token.usedMintAuthorizations(quote.authorizationId));
            assertFalse(token.issued(1));
            assertFalse(token.issued(778));
            assertFalse(token.issued(1_000_000));
            assertFalse(token.claimed(1));
            assertEq(receiver.callbacks(), 0);
        }
        receiver.configure(token, 0, "");
        token.mintToAuthorized(ids, quote, signature);
        assertEq(receiver.callbacks(), 3);
    }

    function testMintCallbackCannotConsumeAnotherValidAuthorization() public {
        DMXStateReceiver receiver = new DMXStateReceiver();
        uint256[] memory outerIds = _two(1, 778);
        uint256[] memory nestedIds = _one(779);
        TarotCards.MintQuote memory outer = _mintQuote(address(receiver), 1);
        TarotCards.MintQuote memory nested = _mintQuote(address(receiver), 2);
        bytes memory nestedSignature = _mintSignature(nestedIds, nested);
        receiver.configure(token, 0, abi.encodeCall(token.mintToAuthorized, (nestedIds, nested, nestedSignature)));
        token.mintToAuthorized(outerIds, outer, _mintSignature(outerIds, outer));
        assertEq(receiver.blockedCalls(), 3);
        assertFalse(token.usedMintAuthorizations(nested.authorizationId));
        assertFalse(token.issued(779));
        receiver.configure(token, 0, "");
        token.mintToAuthorized(nestedIds, nested, nestedSignature);
        assertEq(token.ownerOf(779), address(receiver));
    }

    function testMaximumInitialAndFutureMintBatchesStayWithinTransactionGasBudget() public {
        uint256 gasBefore = gasleft();
        token.mintTo(ALICE, _range(1, 50));
        uint256 initialGas = gasBefore - gasleft();
        assertTrue(initialGas < 12_000_000);
        assertEq(token.balanceOf(ALICE), 100);
        gasBefore = gasleft();
        token.mintTo(BOB, _range(999_950, 50));
        uint256 futureGas = gasBefore - gasleft();
        assertTrue(futureGas < 6_000_000);
        assertEq(token.balanceOf(BOB), 50);
        assertEq(token.ownerOf(999_999), BOB);
    }

    function testMintDigestMatchesSharedFixture() public pure {
        TarotCards.MintQuote memory quote = TarotCards.MintQuote(bytes32(uint256(1)),
            0x1111111111111111111111111111111111111111, 2_000_000_600);
        assertEq(_mintDigest(_two(778, 999_999), quote, 0x3333333333333333333333333333333333333333, 11155111),
            0xd473708e2bbd82df5176afdac0b559eb722fb3d3873d6d77eff482fc3e497312);
    }

    function testFuzzDirectMintUsesOnlyTheCardNamespace(uint256 seed) public {
        uint256 id = seed % 999_999 + 1;
        token.mintTo(ALICE, _one(id));
        assertEq(token.ownerOf(id), ALICE);
        assertEq(token.balanceOf(ALICE), id <= 777 ? 2 : 1);
        assertTrue(token.issued(id));
        vm.expectRevert();
        token.mintTo(BOB, _one(id));
    }
}
