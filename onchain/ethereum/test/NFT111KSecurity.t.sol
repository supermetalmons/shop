pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport} from "./TestSupport.sol";

interface SecurityVm {
    function expectEmit(bool, bool, bool, bool, address) external;
    function expectRevert(bytes calldata reason) external;
}

struct SecurityCall {
    bytes data;
    uint256 value;
}

contract SecurityCollection is NFT111K {
    constructor(
        address owner_,
        address signer_,
        address payable deliveryReceiver_,
        string memory baseURI_,
        address[] memory recipients_,
        uint256[] memory shares_
    ) NFT111K(owner_, signer_, deliveryReceiver_, baseURI_, bytes32(0), recipients_, shares_) {}

    function transientStateClean() external view returns (bool) {
        return _extraData(address(0), address(0), 0) == 0 && !_reentrancyGuardEntered();
    }
}

contract SecurityReceiver {
    NFT111K public immutable token;
    uint256 public callbacks;
    uint256 public blockedCalls;
    uint256 public caughtFailures;
    uint256 public rejectAt;
    bool public wrongSelector;
    address public transferNewTo;
    uint256 public transferOtherId;
    address public transferOtherTo;
    uint256 public sourceTransferFailures;
    bool private checkPurchaseTotals;
    uint256[3] private expectedPurchaseTotals;
    uint256 private expectedMonuments;
    bool private checkMonuments;
    bool private checkProceeds;
    uint256[2] private expectedProceeds;
    uint256[] private deliverySources;
    uint256[] private deliveryReceipts;
    uint256[] private unboxSources;
    uint256 private deliveryStartingBalance;
    uint256 private deliveryStartingSupply;
    uint256 private deliveryOrderId;
    bool private catchSourceTransfers;
    SecurityCall[] private attacks;

    error ReceiverRejected(uint256 callback);

    constructor(NFT111K token_) {
        token = token_;
    }

    function configure(uint256 rejectAt_, bool wrongSelector_, address transferNewTo_) external {
        callbacks = 0;
        blockedCalls = 0;
        rejectAt = rejectAt_;
        wrongSelector = wrongSelector_;
        transferNewTo = transferNewTo_;
        transferOtherId = 0;
        sourceTransferFailures = 0;
        checkPurchaseTotals = false;
        checkMonuments = false;
        checkProceeds = false;
        delete deliverySources;
        delete deliveryReceipts;
        delete unboxSources;
        delete attacks;
    }

    function expectPurchaseTotals(uint256 allocated, uint256 warehouses, uint256 artworks) external {
        checkPurchaseTotals = true;
        expectedPurchaseTotals = [allocated, warehouses, artworks];
    }

    function expectMonumentCount(uint256 count) external {
        checkMonuments = true;
        expectedMonuments = count;
    }

    function expectProceeds(uint256 mintReceived, uint256 deliveryReceived) external {
        checkProceeds = true;
        expectedProceeds = [mintReceived, deliveryReceived];
    }

    function configureAttacks(SecurityCall[] calldata calls) external {
        callbacks = 0;
        blockedCalls = 0;
        delete attacks;
        for (uint256 i; i < calls.length; ++i) {
            attacks.push(calls[i]);
        }
    }

    function configureOtherTransfer(uint256 id, address recipient) external {
        transferOtherId = id;
        transferOtherTo = recipient;
    }

    function expectDeliveryState(
        uint256[] calldata sources,
        uint256[] calldata receipts,
        uint256 orderId,
        bool catchTransfers
    ) external {
        require(sources.length != 0 && sources.length == receipts.length, "invalid delivery expectation");
        deliverySources = sources;
        deliveryReceipts = receipts;
        deliveryStartingBalance = token.balanceOf(address(this));
        deliveryStartingSupply = token.totalSupply();
        deliveryOrderId = orderId;
        catchSourceTransfers = catchTransfers;
    }

    function expectUnboxSources(uint256[] calldata sources) external {
        unboxSources = sources;
    }

    function execute(bytes calldata data, uint256 value) external {
        _execute(data, value);
    }

    function executeSequence(SecurityCall[] calldata calls) external {
        for (uint256 i; i < calls.length; ++i) {
            _execute(calls[i].data, calls[i].value);
        }
    }

    function executeAfterCaughtRevert(bytes calldata data, uint256 value, SecurityCall[] calldata afterCalls) external {
        (bool success, bytes memory reason) = address(token).call{value: value}(data);
        require(!success && bytes4(reason) == ReceiverRejected.selector, "expected receiver rejection");
        require(SecurityCollection(address(token)).transientStateClean(), "failed call retained transient state");
        caughtFailures++;
        rejectAt = 0;
        for (uint256 i; i < afterCalls.length; ++i) {
            _execute(afterCalls[i].data, afterCalls[i].value);
        }
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(token), "unexpected collection");
        callbacks++;
        (uint8 kind, uint256 displayId, address holder) = token.getTokenInfo(id);
        require(holder == address(this), "callback owner mismatch");
        bytes32 metadata = keccak256(bytes(token.tokenURI(id)));
        require(metadata == keccak256(bytes(token.previewTokenURI(kind, displayId))), "callback metadata mismatch");
        if (deliverySources.length != 0) _checkDeliveryState(id);
        for (uint256 i; i < unboxSources.length; ++i) {
            (uint8 sourceKind, uint256 sourceNumber, address sourceHolder) = token.getTokenInfo(unboxSources[i]);
            require(sourceKind == 0 && sourceNumber == 0 && sourceHolder == address(0), "unbox source remains live");
            (bool transferred, bytes memory reason) = address(token)
                .call(abi.encodeCall(token.transferFrom, (address(this), address(0xB0B), unboxSources[i])));
            require(
                !transferred && bytes4(reason) == bytes4(keccak256("OwnerQueryForNonexistentToken()")),
                "unbox source transfer did not fail"
            );
            sourceTransferFailures++;
        }
        if (checkProceeds) {
            require(token.totalMintReceived() == expectedProceeds[0], "callback mint proceeds mismatch");
            require(token.totalDeliveryReceived() == expectedProceeds[1], "callback delivery proceeds mismatch");
        }
        if (checkMonuments) {
            (,,,,,,,,,, uint256 monuments,) = token.stats(address(0));
            require(
                monuments == expectedMonuments && token.monumentsMinted() == expectedMonuments,
                "callback monument count mismatch"
            );
        }
        if (checkPurchaseTotals) {
            (uint256 allocated, uint256 warehouses, uint256 artworks,,,,,,,,,) = token.stats(address(0));
            require(token.allocatedCrates() == expectedPurchaseTotals[0], "callback allocation mismatch");
            require(token.warehousesMinted() == expectedPurchaseTotals[1], "callback warehouse count mismatch");
            require(allocated == expectedPurchaseTotals[0], "callback stats allocation mismatch");
            require(warehouses == expectedPurchaseTotals[1], "callback stats warehouse count mismatch");
            require(artworks == expectedPurchaseTotals[2], "callback stats artwork count mismatch");
        }
        if (callbacks == rejectAt) {
            if (wrongSelector) return bytes4(0);
            revert ReceiverRejected(callbacks);
        }
        for (uint256 i; i < attacks.length; ++i) {
            (bool success, bytes memory reason) = address(token).call{value: attacks[i].value}(attacks[i].data);
            require(
                !success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "reentry not guarded"
            );
            blockedCalls++;
        }
        if (transferOtherId != 0) {
            uint256 other = transferOtherId;
            transferOtherId = 0;
            token.transferFrom(address(this), transferOtherTo, other);
        }
        if (transferNewTo != address(0)) {
            token.transferFrom(address(this), transferNewTo, id);
            require(token.ownerOf(id) == transferNewTo, "callback transfer failed");
            require(keccak256(bytes(token.tokenURI(id))) == metadata, "transfer changed metadata");
        }
        return this.onERC721Received.selector;
    }

    function _checkDeliveryState(uint256 id) private {
        require(token.usedDeliveryOrders(deliveryOrderId), "delivery authorization not consumed");
        require(id == deliveryReceipts[callbacks - 1], "callback receipt order mismatch");
        require(
            token.balanceOf(address(this)) == deliveryStartingBalance - deliverySources.length + callbacks,
            "callback delivery balance mismatch"
        );
        require(
            token.totalSupply() == deliveryStartingSupply - deliverySources.length + callbacks,
            "callback delivery supply mismatch"
        );
        for (uint256 i; i < deliverySources.length; ++i) {
            (uint8 kind, uint256 displayId, address holder) = token.getTokenInfo(deliverySources[i]);
            require(kind == 0 && displayId == 0 && holder == address(0), "delivery source remains live");
            (bool exists, bytes memory reason) =
                address(token).staticcall(abi.encodeCall(token.ownerOf, (deliverySources[i])));
            require(
                !exists && bytes4(reason) == bytes4(keccak256("OwnerQueryForNonexistentToken()")),
                "delivery source owner remains queryable"
            );
            (kind, displayId, holder) = token.getTokenInfo(deliveryReceipts[i]);
            if (i < callbacks) {
                uint256 offset =
                    deliveryReceipts[i] < 2000000 ? 1000000 : deliveryReceipts[i] < 3000000 ? 2000000 : 3000000;
                require(
                    kind == (offset == 1000000 ? 4 : offset == 2000000 ? 5 : 7)
                        && displayId == deliveryReceipts[i] - offset && holder == address(this),
                    "minted receipt prefix mismatch"
                );
            } else {
                require(kind == 0 && displayId == 0 && holder == address(0), "future receipt already minted");
            }
            if (catchSourceTransfers) {
                (bool success, bytes memory failure) = address(token)
                    .call(abi.encodeCall(token.transferFrom, (address(this), address(0xB0B), deliverySources[i])));
                require(
                    !success && bytes4(failure) == bytes4(keccak256("OwnerQueryForNonexistentToken()")),
                    "burned source transfer did not fail"
                );
                sourceTransferFailures++;
            }
        }
    }

    function _execute(bytes memory data, uint256 value) private {
        (bool success, bytes memory reason) = address(token).call{value: value}(data);
        if (!success) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
        require(SecurityCollection(address(token)).transientStateClean(), "successful call retained transient state");
    }
}

contract NFT111KSecurityTest is TestSupport {
    NFT111K internal token;
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant ROTATED_KEY = 0xB0B;
    address internal constant ALICE = address(0xA110);
    address internal constant BOB = address(0xB0B);
    address payable internal constant DELIVERY_RECEIVER = payable(address(0xBEEF));
    bytes32 internal constant OUTER_CLAIM = keccak256("outer physical claim");
    bytes32 internal constant INNER_CLAIM = keccak256("inner physical claim");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant DELIVERY_TYPEHASH = keccak256(
        "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)"
    );
    bytes32 internal constant CLAIM_TYPEHASH =
        keccak256("CrateClaim(address wallet,uint256 receiptId,bytes32 claimId,uint256 deadline)");

    event RedemptionsPauseUpdated(bool paused);

    function setUp() public {
        vm.chainId(31337);
        vm.warp(2_000_000_000);
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
        token = new SecurityCollection(
            address(this),
            vm.addr(SIGNER_KEY),
            DELIVERY_RECEIVER,
            "https://cdn.mons.shop/111k-sepolia/",
            _proceedsRecipients(),
            _proceedsSharesBps()
        );
        token.setSaleActive(true);
    }

    function testRenunciationPreservesOwnershipBeforeDuringAndAfterTransfer() public {
        vm.expectRevert(NFT111K.OwnershipRenunciationDisabled.selector);
        token.renounceOwnership();
        assertEq(token.owner(), address(this));
        assertEq(token.pendingOwner(), address(0));
        vm.prank(BOB);
        SecurityVm(address(vm)).expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", BOB));
        token.renounceOwnership();

        token.transferOwnership(ALICE);
        vm.expectRevert(NFT111K.OwnershipRenunciationDisabled.selector);
        token.renounceOwnership();
        assertEq(token.owner(), address(this));
        assertEq(token.pendingOwner(), ALICE);
        vm.prank(ALICE);
        SecurityVm(address(vm)).expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", ALICE));
        token.renounceOwnership();
        assertEq(token.owner(), address(this));
        assertEq(token.pendingOwner(), ALICE);

        token.transferOwnership(address(0));
        assertEq(token.owner(), address(this));
        assertEq(token.pendingOwner(), address(0));
        vm.prank(ALICE);
        SecurityVm(address(vm)).expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", ALICE));
        token.acceptOwnership();
        token.transferOwnership(ALICE);
        vm.prank(ALICE);
        token.acceptOwnership();
        SecurityVm(address(vm))
            .expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", address(this)));
        token.renounceOwnership();
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.OwnershipRenunciationDisabled.selector);
        token.renounceOwnership();
        assertEq(token.owner(), ALICE);
        assertEq(token.pendingOwner(), address(0));
    }

    function testRejectedRenunciationLeavesPayoutsPauseAndSignerRotationUsable() public {
        _buyCrates(ALICE, 1);
        token.transferOwnership(ALICE);
        vm.prank(ALICE);
        token.acceptOwnership();
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.OwnershipRenunciationDisabled.selector);
        token.renounceOwnership();
        address signer = vm.addr(ROTATED_KEY);
        uint256 balance = address(token).balance;
        vm.startPrank(ALICE);
        token.setRedemptionsPaused(true);
        token.setQuoteSigner(signer);
        _releaseAllMint();
        vm.stopPrank();
        assertTrue(token.redemptionsPaused());
        assertEq(token.quoteSigner(), signer);
        assertEq(token.totalMintReleased(), balance);
        assertEq(DELIVERY_RECEIVER.balance, 0);
        assertEq(address(token).balance, 0);
        vm.prank(ALICE);
        token.setRedemptionsPaused(false);
        uint256[] memory ids = _one(111112);
        NFT111K.DeliveryQuote memory quote = _quote(ALICE, 2, ids);
        bytes memory signature = _deliverySignature(ids, quote, ROTATED_KEY);
        vm.prank(ALICE);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        assertFalse(token.redemptionsPaused());
        assertTrue(token.usedDeliveryOrders(2));
        _info(2000001, 5, 1, ALICE);
    }

    function testDeliveryRejectsMalformedSignaturesAtomicallyAndAcceptsValidRetry() public {
        _malformedAuthorization(false);
    }

    function testCrateClaimRejectsMalformedSignaturesAtomicallyAndAcceptsValidRetry() public {
        _malformedAuthorization(true);
    }

    function testRedemptionsStartUnpausedAndOnlyOwnerCanEmitPauseTransitions() public {
        assertFalse(token.redemptionsPaused());
        vm.prank(ALICE);
        SecurityVm(address(vm)).expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", ALICE));
        token.setRedemptionsPaused(true);
        assertFalse(token.redemptionsPaused());
        SecurityVm(address(vm)).expectEmit(false, false, false, true, address(token));
        emit RedemptionsPauseUpdated(true);
        token.setRedemptionsPaused(true);
        assertTrue(token.redemptionsPaused());
        vm.prank(ALICE);
        SecurityVm(address(vm)).expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", ALICE));
        token.setRedemptionsPaused(false);
        assertTrue(token.redemptionsPaused());
        SecurityVm(address(vm)).expectEmit(false, false, false, true, address(token));
        emit RedemptionsPauseUpdated(false);
        token.setRedemptionsPaused(false);
        assertFalse(token.redemptionsPaused());
    }

    function testPauseRejectsBothFlowsAtomicallyAndUnpauseAcceptsTheirOriginalSignatures() public {
        _buyCrates(ALICE, 3);
        _redeem(ALICE, _one(111114), 1);
        uint256[] memory ids = _range(111112, 2);
        NFT111K.DeliveryQuote memory quote = _quote(ALICE, 2, ids);
        bytes memory deliverySignature = _deliverySignature(ids, quote, SIGNER_KEY);
        bytes memory claimSignature = _claimSignature(ALICE, 2000003, OUTER_CLAIM, quote.deadline, SIGNER_KEY);
        token.setRedemptionsPaused(true);
        bytes32 beforeState = _state(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.RedemptionsPaused.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, deliverySignature);
        assertEq(_state(ALICE), beforeState);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.RedemptionsPaused.selector);
        token.claimCrateReceipt(2000003, OUTER_CLAIM, quote.deadline, claimSignature);
        assertEq(_state(ALICE), beforeState);
        _info(111112, 2, 1, ALICE);
        _info(111113, 2, 2, ALICE);
        _info(2000003, 5, 3, ALICE);
        _absent(2000001, 2);
        _absent(1111152, 20);
        assertFalse(token.usedDeliveryOrders(2));
        assertFalse(token.usedClaims(OUTER_CLAIM));
        token.setRedemptionsPaused(false);
        vm.prank(ALICE);
        token.redeemForDelivery{value: quote.fee}(ids, quote, deliverySignature);
        vm.prank(ALICE);
        token.claimCrateReceipt(2000003, OUTER_CLAIM, quote.deadline, claimSignature);
        assertTrue(token.usedDeliveryOrders(2));
        assertTrue(token.usedClaims(OUTER_CLAIM));
        _info(2000001, 5, 1, ALICE);
        _info(2000002, 5, 2, ALICE);
        _outputs(1111152, 20, 4, 111152, ALICE);
    }

    function testPauseDoesNotExtendDeliveryOrClaimExpiration() public {
        _buyCrates(ALICE, 2);
        _redeem(ALICE, _one(111113), 1);
        uint256[] memory ids = _one(111112);
        NFT111K.DeliveryQuote memory quote = _quote(ALICE, 2, ids);
        bytes memory deliverySignature = _deliverySignature(ids, quote, SIGNER_KEY);
        bytes memory claimSignature = _claimSignature(ALICE, 2000002, OUTER_CLAIM, quote.deadline, SIGNER_KEY);
        token.setRedemptionsPaused(true);
        vm.warp(quote.deadline + 1);
        token.setRedemptionsPaused(false);
        bytes32 beforeState = _state(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.AuthorizationExpired.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, deliverySignature);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.AuthorizationExpired.selector);
        token.claimCrateReceipt(2000002, OUTER_CLAIM, quote.deadline, claimSignature);
        assertEq(_state(ALICE), beforeState);
        _info(111112, 2, 1, ALICE);
        _info(2000002, 5, 2, ALICE);
    }

    function testSignerRotationDuringPauseInvalidatesBothOldAuthorizations() public {
        _buyCrates(ALICE, 2);
        _redeem(ALICE, _one(111113), 1);
        uint256[] memory ids = _one(111112);
        NFT111K.DeliveryQuote memory quote = _quote(ALICE, 2, ids);
        bytes memory deliverySignature = _deliverySignature(ids, quote, SIGNER_KEY);
        bytes memory claimSignature = _claimSignature(ALICE, 2000002, OUTER_CLAIM, quote.deadline, SIGNER_KEY);
        token.setRedemptionsPaused(true);
        token.setQuoteSigner(vm.addr(ROTATED_KEY));
        token.setRedemptionsPaused(false);
        bytes32 beforeState = _state(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, deliverySignature);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.claimCrateReceipt(2000002, OUTER_CLAIM, quote.deadline, claimSignature);
        assertEq(_state(ALICE), beforeState);
        deliverySignature = _deliverySignature(ids, quote, ROTATED_KEY);
        claimSignature = _claimSignature(ALICE, 2000002, OUTER_CLAIM, quote.deadline, ROTATED_KEY);
        vm.prank(ALICE);
        token.redeemForDelivery{value: quote.fee}(ids, quote, deliverySignature);
        vm.prank(ALICE);
        token.claimCrateReceipt(2000002, OUTER_CLAIM, quote.deadline, claimSignature);
        assertTrue(token.usedDeliveryOrders(2));
        assertTrue(token.usedClaims(OUTER_CLAIM));
    }

    function testRedemptionPauseLeavesMintOpeningTransfersPayoutsAndSaleControlIndependent() public {
        _buyCrates(ALICE, 2);
        _redeem(ALICE, _one(111113), 1);
        token.setRedemptionsPaused(true);
        _buyCrates(ALICE, 1);
        vm.startPrank(ALICE);
        token.mintWarehouses{value: 0.0011 ether}(1);
        token.transferFrom(ALICE, BOB, 111112);
        token.safeTransferFrom(ALICE, BOB, 2000002);
        token.unboxWarehouse(116667);
        vm.stopPrank();
        vm.prank(BOB);
        token.unboxCrate(111112);
        token.setSaleActive(false);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintCrates{value: 0.0001 ether}(1);
        vm.prank(ALICE);
        token.unboxCrate(111114);
        _info(1, 1, 1, BOB);
        _info(21, 1, 21, ALICE);
        _info(2000002, 5, 2, BOB);
        _outputs(111115, 11, 2, 4, ALICE);
        uint256 balance = address(token).balance;
        _releaseAllMint();
        token.releaseDelivery();
        assertEq(DELIVERY_RECEIVER.balance, token.totalDeliveryReceived());
        assertEq(token.totalMintReleased() + token.totalDeliveryReleased(), balance);
        assertEq(address(token).balance, 0);
        assertTrue(token.redemptionsPaused());
        token.setRedemptionsPaused(false);
        _redeem(BOB, _one(1), 2);
        bytes memory signature = _claimSignature(BOB, 2000002, OUTER_CLAIM, block.timestamp + 300, SIGNER_KEY);
        vm.prank(BOB);
        token.claimCrateReceipt(2000002, OUTER_CLAIM, block.timestamp + 300, signature);
        assertFalse(token.saleActive());
        _info(1000001, 4, 1, BOB);
        _outputs(1111132, 20, 4, 111132, BOB);
    }

    function testCrateMintCallbacksRejectEveryProtectedReentry() public {
        _reentry(0);
    }

    function testWarehouseMintCallbacksRejectEveryProtectedReentry() public {
        _reentry(1);
    }

    function testCrateMintCallbacksObserveFinalPurchaseTotalsBeforeAndAfterMixedHistory() public {
        SecurityReceiver buyer = new SecurityReceiver(token);
        vm.deal(address(buyer), 100 ether);
        _purchaseWithTotals(buyer, false, 3, 3, 0, 0);
        _purchaseWithTotals(buyer, true, 2, 25, 2, 0);
        buyer.configure(0, false, address(0));
        buyer.execute(abi.encodeCall(token.unboxCrate, (111112)), 0);
        _purchaseWithTotals(buyer, false, 15, 40, 2, 20);
    }

    function testWarehouseMintCallbacksObserveFinalPurchaseTotalsBeforeAndAfterMixedHistory() public {
        SecurityReceiver buyer = new SecurityReceiver(token);
        vm.deal(address(buyer), 100 ether);
        _purchaseWithTotals(buyer, true, 3, 33, 3, 0);
        _purchaseWithTotals(buyer, false, 2, 35, 3, 0);
        buyer.configure(0, false, address(0));
        buyer.execute(abi.encodeCall(token.unboxCrate, (111145)), 0);
        _purchaseWithTotals(buyer, true, 15, 200, 18, 20);
    }

    function testWarehouseOpeningCallbacksRejectEveryProtectedReentry() public {
        _reentry(2);
    }

    function testCrateOpeningCallbacksRejectEveryProtectedReentry() public {
        _reentry(3);
    }

    function testDeliveryCallbacksRejectEveryProtectedReentry() public {
        _reentry(4);
    }

    function testPhysicalClaimCallbacksRejectEveryProtectedReentry() public {
        _reentry(5);
    }

    function testBatchOpeningCallbacksRejectEveryProtectedReentry() public {
        _reentry(6);
    }

    function testCrateMintRejectionAtFirstMiddleAndLastRollsBackAndRetries() public {
        _rejections(0);
    }

    function testWarehouseMintRejectionAtFirstMiddleAndLastRollsBackAndRetries() public {
        _rejections(1);
    }

    function testWarehouseOpeningRejectionAtFirstMiddleAndLastRollsBackAndRetries() public {
        _rejections(2);
    }

    function testCrateOpeningRejectionAtFirstMiddleAndLastRollsBackAndRetries() public {
        _rejections(3);
    }

    function testDeliveryRejectionAtFirstMiddleAndLastRollsBackAndRetries() public {
        _rejections(4);
    }

    function testPhysicalClaimRejectionAtFirstMiddleAndLastRollsBackAndRetries() public {
        _rejections(5);
    }

    function testBatchOpeningRejectionAtFirstMiddleAndLastRollsBackAndRetries() public {
        _rejections(6);
    }

    function testFreshCrateTransfersInsideCallbacksPreserveOwnershipAndMetadata() public {
        _callbackTransfers(0);
    }

    function testFreshWarehouseTransfersInsideCallbacksPreserveOwnershipAndMetadata() public {
        _callbackTransfers(1);
    }

    function testUnpackedCrateTransfersInsideCallbacksPreserveOwnershipAndMetadata() public {
        _callbackTransfers(2);
    }

    function testFreshArtworkTransfersInsideCallbacksPreserveOwnershipAndMetadata() public {
        _callbackTransfers(3);
    }

    function testFreshDeliveryReceiptTransfersInsideCallbacksPreserveOwnershipAndMetadata() public {
        _callbackTransfers(4);
    }

    function testFreshClaimReceiptTransfersInsideCallbacksPreserveOwnershipAndMetadata() public {
        _callbackTransfers(5);
    }

    function testBatchArtworkTransfersInsideCallbacksPreserveOwnershipAndMetadata() public {
        _callbackTransfers(6);
    }

    function testBatchCallbacksObserveEverySelectedCrateAlreadyBurned() public {
        SecurityReceiver buyer = _receiver();
        buyer.expectUnboxSources(_range(111112, 3));
        SecurityCall memory call_ = _route(buyer, 6);
        buyer.execute(call_.data, 0);
        assertEq(buyer.callbacks(), 60);
        assertEq(buyer.sourceTransferFailures(), 180);
        _assertOutputs(6, address(buyer));
    }

    function testBatchUncaughtSourceTransferRollsBackAndCanRetry() public {
        SecurityReceiver buyer = _receiver();
        buyer.configureOtherTransfer(111114, BOB);
        SecurityCall memory call_ = _route(buyer, 6);
        bytes32 beforeState = _state(address(buyer));
        vm.expectRevert(bytes4(keccak256("OwnerQueryForNonexistentToken()")));
        buyer.execute(call_.data, 0);
        assertEq(_state(address(buyer)), beforeState);
        _seedStillOwned(buyer);
        buyer.configure(0, false, address(0));
        buyer.execute(call_.data, 0);
        _assertOutputs(6, address(buyer));
    }

    function testBatchCanTransferUnrelatedAndNewArtworksDuringCallbacks() public {
        SecurityReceiver buyer = _receiver();
        buyer.execute(abi.encodeCall(token.unboxCrate, (111112)), 0);
        buyer.configure(0, false, BOB);
        buyer.configureOtherTransfer(2, BOB);
        uint256[] memory ids = _range(111113, 2);
        buyer.execute(abi.encodeCall(token.unboxCrates, (ids)), 0);
        _outputs(21, 40, 1, 21, BOB);
        _info(2, 1, 2, BOB);
        assertEq(buyer.callbacks(), 40);
    }

    function testBatchThenSingleOpeningClearsTransientState() public {
        SecurityReceiver buyer = _receiver();
        SecurityCall[] memory calls = new SecurityCall[](2);
        calls[0] = SecurityCall(abi.encodeCall(token.unboxCrates, (_range(111112, 2))), 0);
        calls[1] = SecurityCall(abi.encodeCall(token.unboxCrate, (111114)), 0);
        buyer.executeSequence(calls);
        _outputs(1, 60, 1, 1, address(buyer));
    }

    function testSingleThenBatchOpeningKeepsSequentialArtworkIds() public {
        SecurityReceiver buyer = _receiver();
        SecurityCall[] memory calls = new SecurityCall[](2);
        calls[0] = SecurityCall(abi.encodeCall(token.unboxCrate, (111114)), 0);
        calls[1] = SecurityCall(abi.encodeCall(token.unboxCrates, (_range(111112, 2))), 0);
        buyer.executeSequence(calls);
        _outputs(1, 20, 1, 1, address(buyer));
        _outputs(21, 40, 1, 21, address(buyer));
    }

    function testCaughtBatchRejectionThenDifferentOpeningAndBatchRetryClearTransientState() public {
        SecurityReceiver buyer = _receiver();
        SecurityCall memory batch = SecurityCall(abi.encodeCall(token.unboxCrates, (_range(111112, 2))), 0);
        buyer.configure(25, false, address(0));
        SecurityCall[] memory calls = new SecurityCall[](2);
        calls[0] = SecurityCall(abi.encodeCall(token.unboxCrate, (111114)), 0);
        calls[1] = batch;
        buyer.executeAfterCaughtRevert(batch.data, 0, calls);
        assertEq(buyer.caughtFailures(), 1);
        _outputs(1, 20, 1, 1, address(buyer));
        _outputs(21, 40, 1, 21, address(buyer));
    }

    function testCallbackTransferOfLaterDeliveryItemRollsBackTheWholeSelection() public {
        SecurityReceiver buyer = _receiver();
        SecurityCall memory call_ = _route(buyer, 4);
        buyer.configureOtherTransfer(111114, BOB);
        bytes32 beforeState = _state(address(buyer));
        vm.expectRevert(bytes4(keccak256("OwnerQueryForNonexistentToken()")));
        buyer.execute(call_.data, call_.value);
        assertEq(_state(address(buyer)), beforeState);
        _seedStillOwned(buyer);
        _absent(2000001, 3);
        assertEq(token.balanceOf(BOB), 0);
        buyer.configure(0, false, address(0));
        buyer.execute(call_.data, call_.value);
        _outputs(2000001, 3, 5, 1, address(buyer));
        assertTrue(token.usedDeliveryOrders(2));
    }

    function testArtworkDeliveryCallbacksObserveAllBurnsAndOnlyMintedReceiptPrefix() public {
        _deliveryCallbacks(false, false);
    }

    function testMixedDeliveryCallbacksObserveAllBurnsAndOnlyMintedReceiptPrefix() public {
        _deliveryCallbacks(true, false);
    }

    function testArtworkDeliveryCallbacksCanCatchTransfersOfEveryBurnedSource() public {
        _deliveryCallbacks(false, true);
    }

    function testMixedDeliveryCallbacksCanCatchTransfersOfEveryBurnedSource() public {
        _deliveryCallbacks(true, true);
    }

    function testUncaughtArtworkSourceTransferRollsBackDeliveryAndCanRetry() public {
        _uncaughtDeliverySourceTransfer(false);
    }

    function testUncaughtMixedSourceTransferRollsBackDeliveryAndCanRetry() public {
        _uncaughtDeliverySourceTransfer(true);
    }

    function testMixedDeliveryCallbacksCanTransferNewReceiptsAndUnrelatedArtwork() public {
        SecurityReceiver buyer = _artworkReceiver();
        (uint256[] memory ids, uint256[] memory receipts) = _deliverySelection(true);
        SecurityCall memory call_ = _deliveryCall(buyer, ids);
        uint256 balance = token.balanceOf(address(buyer));
        uint256 supply = token.totalSupply();
        buyer.configure(0, false, BOB);
        buyer.configureOtherTransfer(2, BOB);
        buyer.execute(call_.data, call_.value);
        assertEq(buyer.callbacks(), ids.length);
        assertEq(token.balanceOf(address(buyer)), balance - ids.length - 1);
        assertEq(token.balanceOf(BOB), ids.length + 1);
        assertEq(token.totalSupply(), supply);
        _deliveryOutputs(ids, receipts, BOB);
        _info(2, 1, 2, BOB);
        _info(3, 1, 3, address(buyer));
    }

    function testMonumentMixedDeliveryCallbacksSeeAllBurnsAndRejectWholeBatchAtomically() public {
        SecurityReceiver buyer = _artworkReceiver();
        buyer.execute(abi.encodeCall(token.mintMonuments, (1)), 0.0088 ether);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 117172;
        ids[1] = 111114;
        ids[2] = 1;
        uint256[] memory receipts = new uint256[](3);
        receipts[0] = 3000001;
        receipts[1] = 2000003;
        receipts[2] = 1000001;
        SecurityCall memory call_ = _deliveryCall(buyer, ids);
        uint256 allocations = token.allocatedCrates();
        uint256 balance = token.balanceOf(address(buyer));
        for (uint256 rejectAt = 1; rejectAt <= ids.length; ++rejectAt) {
            buyer.configure(rejectAt, false, address(0));
            buyer.expectDeliveryState(ids, receipts, 2, true);
            SecurityVm(address(vm))
                .expectRevert(abi.encodeWithSelector(SecurityReceiver.ReceiverRejected.selector, rejectAt));
            buyer.execute(call_.data, call_.value);
            _info(117172, 6, 1, address(buyer));
            _info(111114, 2, 3, address(buyer));
            _info(1, 1, 1, address(buyer));
            for (uint256 i; i < receipts.length; ++i) {
                _info(receipts[i], 0, 0, address(0));
            }
            assertFalse(token.usedDeliveryOrders(2));
            assertEq(token.allocatedCrates(), allocations);
            assertEq(token.balanceOf(address(buyer)), balance);
        }
        buyer.configure(0, false, address(0));
        buyer.expectDeliveryState(ids, receipts, 2, true);
        buyer.execute(call_.data, call_.value);
        assertEq(buyer.callbacks(), 3);
        assertEq(buyer.sourceTransferFailures(), 9);
        assertEq(token.allocatedCrates(), allocations);
        assertEq(token.balanceOf(address(buyer)), balance);
        for (uint256 i; i < ids.length; ++i) {
            _info(ids[i], 0, 0, address(0));
        }
        _info(3000001, 7, 1, address(buyer));
        _info(2000003, 5, 3, address(buyer));
        _info(1000001, 4, 1, address(buyer));
        assertTrue(token.usedDeliveryOrders(2));
    }

    function testTwoOpeningsInOneWrapperCallHaveSequentialArtworkIds() public {
        SecurityReceiver buyer = _receiver();
        SecurityCall[] memory calls = new SecurityCall[](2);
        calls[0] = SecurityCall(abi.encodeCall(token.unboxCrate, (111114)), 0);
        calls[1] = SecurityCall(abi.encodeCall(token.unboxCrate, (111112)), 0);
        buyer.executeSequence(calls);
        _outputs(1, 20, 1, 1, address(buyer));
        _outputs(21, 20, 1, 21, address(buyer));
        assertEq(_artworksMinted(), 40);
    }

    function testOpeningThenCrateMintInOneWrapperCallClearsTransientState() public {
        _openingThenMint(false);
    }

    function testOpeningThenWarehouseMintInOneWrapperCallClearsTransientState() public {
        _openingThenMint(true);
    }

    function testOpeningThenDeliveryInOneWrapperCallPreservesArtworkIdentities() public {
        SecurityReceiver buyer = _receiver();
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 20;
        uint256[] memory receipts = new uint256[](2);
        receipts[0] = 1000001;
        receipts[1] = 1000020;
        NFT111K.DeliveryQuote memory quote = NFT111K.DeliveryQuote(
            2, address(buyer), 0.0001 ether, block.timestamp + 300, keccak256(abi.encode(receipts))
        );
        bytes memory signature = _deliverySignature(ids, quote, SIGNER_KEY);
        SecurityCall[] memory calls = new SecurityCall[](2);
        calls[0] = SecurityCall(abi.encodeCall(token.unboxCrate, (111113)), 0);
        calls[1] = SecurityCall(abi.encodeCall(token.redeemForDelivery, (ids, quote, signature)), quote.fee);
        buyer.executeSequence(calls);
        _info(1, 0, 0, address(0));
        _info(20, 0, 0, address(0));
        _outputs(2, 18, 1, 2, address(buyer));
        _info(1000001, 4, 1, address(buyer));
        _info(1000020, 4, 20, address(buyer));
        assertTrue(token.usedDeliveryOrders(2));
    }

    function testOpeningThenPhysicalClaimInOneWrapperCallClearsTransientState() public {
        SecurityReceiver buyer = _receiver();
        SecurityCall[] memory calls = new SecurityCall[](2);
        calls[0] = SecurityCall(abi.encodeCall(token.unboxCrate, (111113)), 0);
        calls[1] = _route(buyer, 5);
        buyer.executeSequence(calls);
        _outputs(1, 20, 1, 1, address(buyer));
        _outputs(1111172, 20, 4, 111172, address(buyer));
        assertTrue(token.usedClaims(OUTER_CLAIM));
        assertEq(_artworksMinted(), 20);
    }

    function testCaughtOpeningRevertThenDifferentOpeningAndRetryClearLockAndPreserveSequentialIds() public {
        SecurityReceiver buyer = _receiver();
        buyer.configure(10, false, address(0));
        SecurityCall[] memory calls = new SecurityCall[](3);
        calls[0] = SecurityCall(abi.encodeCall(token.unboxCrate, (111114)), 0);
        calls[1] = SecurityCall(abi.encodeCall(token.unboxCrate, (111113)), 0);
        calls[2] = SecurityCall(abi.encodeCall(token.mintCrates, (1)), token.cratePrice());
        buyer.executeAfterCaughtRevert(abi.encodeCall(token.unboxCrate, (111113)), 0, calls);
        assertEq(buyer.caughtFailures(), 1);
        assertEq(buyer.callbacks(), 41);
        _outputs(1, 20, 1, 1, address(buyer));
        _outputs(21, 20, 1, 21, address(buyer));
        _info(111127, 2, 16, address(buyer));
        assertEq(_artworksMinted(), 40);
    }

    function testCaughtDeliveryRevertCanRetrySameAuthorizationInOneWrapperCall() public {
        _caughtAuthorizedRetry(4);
    }

    function testCaughtClaimRevertCanRetrySameAuthorizationInOneWrapperCall() public {
        _caughtAuthorizedRetry(5);
    }

    function _malformedAuthorization(bool claim) internal {
        _buyCrates(ALICE, 2);
        _redeem(ALICE, _one(111113), 1);
        uint256[] memory ids = _one(111112);
        NFT111K.DeliveryQuote memory quote = _quote(ALICE, 2, ids);
        bytes memory signature = claim
            ? _claimSignature(ALICE, 2000002, OUTER_CLAIM, quote.deadline, SIGNER_KEY)
            : _deliverySignature(ids, quote, SIGNER_KEY);
        bytes32 beforeState = _state(ALICE);
        for (uint256 i; i < 5; ++i) {
            (bytes memory malformed, bytes memory reason) = _malformedSignature(signature, i);
            vm.prank(ALICE);
            SecurityVm(address(vm)).expectRevert(reason);
            if (claim) token.claimCrateReceipt(2000002, OUTER_CLAIM, quote.deadline, malformed);
            else token.redeemForDelivery{value: quote.fee}(ids, quote, malformed);
            assertEq(_state(ALICE), beforeState);
            _info(111112, 2, 1, ALICE);
            _info(2000002, 5, 2, ALICE);
            _absent(2000001, 1);
            _absent(1111132, 20);
        }
        vm.prank(ALICE);
        if (claim) token.claimCrateReceipt(2000002, OUTER_CLAIM, quote.deadline, signature);
        else token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        if (claim) {
            assertTrue(token.usedClaims(OUTER_CLAIM));
            _info(2000002, 0, 0, address(0));
            _outputs(1111132, 20, 4, 111132, ALICE);
        } else {
            assertTrue(token.usedDeliveryOrders(2));
            _info(111112, 0, 0, address(0));
            _info(2000001, 5, 1, ALICE);
        }
    }

    function _malformedSignature(bytes memory signature, uint256 variant)
        internal
        pure
        returns (bytes memory malformed, bytes memory reason)
    {
        if (variant < 3) {
            uint256 length = variant == 0 ? 0 : variant == 1 ? 64 : 66;
            return (new bytes(length), abi.encodeWithSignature("ECDSAInvalidSignatureLength(uint256)", length));
        }
        (bytes32 r, bytes32 s) = abi.decode(signature, (bytes32, bytes32));
        if (variant == 3) {
            return (abi.encodePacked(r, s, uint8(0)), abi.encodeWithSignature("ECDSAInvalidSignature()"));
        }
        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        uint8 v = uint8(signature[64]) == 27 ? 28 : 27;
        return (abi.encodePacked(r, highS, v), abi.encodeWithSignature("ECDSAInvalidSignatureS(bytes32)", highS));
    }

    function _receiver() internal returns (SecurityReceiver buyer) {
        buyer = new SecurityReceiver(token);
        vm.deal(address(buyer), 100 ether);
        buyer.execute(abi.encodeCall(token.mintCrates, (4)), 0.0004 ether);
        buyer.execute(abi.encodeCall(token.mintWarehouses, (1)), 0.0011 ether);
        uint256[] memory ids = _one(111115);
        NFT111K.DeliveryQuote memory quote = _quote(address(buyer), 1, ids);
        bytes memory signature = _deliverySignature(ids, quote, SIGNER_KEY);
        buyer.execute(abi.encodeCall(token.redeemForDelivery, (ids, quote, signature)), quote.fee);
        buyer.configure(0, false, address(0));
    }

    function _artworkReceiver() internal returns (SecurityReceiver buyer) {
        buyer = _receiver();
        buyer.execute(abi.encodeCall(token.unboxCrate, (111113)), 0);
        buyer.execute(abi.encodeCall(token.unboxCrate, (111112)), 0);
        buyer.configure(0, false, address(0));
    }

    function _deliverySelection(bool mixed) internal pure returns (uint256[] memory ids, uint256[] memory receipts) {
        ids = new uint256[](4);
        ids[0] = mixed ? 111114 : 40;
        ids[1] = 20;
        ids[2] = 1;
        ids[3] = 21;
        receipts = new uint256[](4);
        receipts[0] = mixed ? 2000003 : 1000040;
        receipts[1] = 1000020;
        receipts[2] = 1000001;
        receipts[3] = 1000021;
    }

    function _deliveryCall(SecurityReceiver buyer, uint256[] memory ids) internal returns (SecurityCall memory) {
        NFT111K.DeliveryQuote memory quote = _quote(address(buyer), 2, ids);
        return SecurityCall(
            abi.encodeCall(token.redeemForDelivery, (ids, quote, _deliverySignature(ids, quote, SIGNER_KEY))), quote.fee
        );
    }

    function _deliveryCallbacks(bool mixed, bool catchTransfers) internal {
        SecurityReceiver buyer = _artworkReceiver();
        (uint256[] memory ids, uint256[] memory receipts) = _deliverySelection(mixed);
        SecurityCall memory call_ = _deliveryCall(buyer, ids);
        uint256 balance = token.balanceOf(address(buyer));
        uint256 supply = token.totalSupply();
        buyer.expectDeliveryState(ids, receipts, 2, catchTransfers);
        buyer.execute(call_.data, call_.value);
        assertEq(buyer.callbacks(), ids.length);
        assertEq(buyer.sourceTransferFailures(), catchTransfers ? ids.length * ids.length : 0);
        assertEq(token.balanceOf(address(buyer)), balance);
        assertEq(token.balanceOf(BOB), 0);
        assertEq(token.totalSupply(), supply);
        _deliveryOutputs(ids, receipts, address(buyer));
        _info(2, 1, 2, address(buyer));
        _info(19, 1, 19, address(buyer));
        _info(22, 1, 22, address(buyer));
        _info(39, 1, 39, address(buyer));
    }

    function _uncaughtDeliverySourceTransfer(bool mixed) internal {
        SecurityReceiver buyer = _artworkReceiver();
        (uint256[] memory ids, uint256[] memory receipts) = _deliverySelection(mixed);
        SecurityCall memory call_ = _deliveryCall(buyer, ids);
        buyer.configureOtherTransfer(ids[ids.length - 1], BOB);
        bytes32 beforeState = _state(address(buyer));
        vm.expectRevert(bytes4(keccak256("OwnerQueryForNonexistentToken()")));
        buyer.execute(call_.data, call_.value);
        assertEq(_state(address(buyer)), beforeState);
        assertFalse(token.usedDeliveryOrders(2));
        assertEq(buyer.callbacks(), 0);
        assertEq(token.balanceOf(BOB), 0);
        for (uint256 i; i < ids.length; ++i) {
            uint256 offset = receipts[i] < 2000000 ? 1000000 : 2000000;
            _info(ids[i], offset == 1000000 ? 1 : 2, receipts[i] - offset, address(buyer));
            _info(receipts[i], 0, 0, address(0));
        }
        buyer.configure(0, false, address(0));
        buyer.expectDeliveryState(ids, receipts, 2, false);
        buyer.execute(call_.data, call_.value);
        assertEq(buyer.callbacks(), ids.length);
        _deliveryOutputs(ids, receipts, address(buyer));
    }

    function _deliveryOutputs(uint256[] memory ids, uint256[] memory receipts, address holder) internal view {
        assertTrue(token.usedDeliveryOrders(2));
        for (uint256 i; i < ids.length; ++i) {
            _info(ids[i], 0, 0, address(0));
            uint256 offset = receipts[i] < 2000000 ? 1000000 : 2000000;
            _info(receipts[i], offset == 1000000 ? 4 : 5, receipts[i] - offset, holder);
        }
    }

    function _route(SecurityReceiver buyer, uint256 route) internal returns (SecurityCall memory) {
        if (route == 0) return SecurityCall(abi.encodeCall(token.mintCrates, (3)), 0.0003 ether);
        if (route == 1) return SecurityCall(abi.encodeCall(token.mintWarehouses, (3)), 0.0033 ether);
        if (route == 2) return SecurityCall(abi.encodeCall(token.unboxWarehouse, (116667)), 0);
        if (route == 3) return SecurityCall(abi.encodeCall(token.unboxCrate, (111113)), 0);
        if (route == 4) {
            uint256[] memory ids = _range(111112, 3);
            NFT111K.DeliveryQuote memory quote = _quote(address(buyer), 2, ids);
            return SecurityCall(
                abi.encodeCall(token.redeemForDelivery, (ids, quote, _deliverySignature(ids, quote, SIGNER_KEY))),
                quote.fee
            );
        }
        if (route == 6) {
            uint256[] memory ids = _range(111112, 3);
            ids[0] = 111114;
            ids[2] = 111112;
            return SecurityCall(abi.encodeCall(token.unboxCrates, (ids)), 0);
        }
        uint256 deadline = block.timestamp + 300;
        return SecurityCall(
            abi.encodeCall(
                token.claimCrateReceipt,
                (
                    2000004,
                    OUTER_CLAIM,
                    deadline,
                    _claimSignature(address(buyer), 2000004, OUTER_CLAIM, deadline, SIGNER_KEY)
                )
            ),
            0
        );
    }

    function _reentry(uint256 route) internal {
        SecurityReceiver buyer = _receiver();
        SecurityCall memory call_ = _route(buyer, route);
        SecurityCall[] memory attacks = new SecurityCall[](13);
        attacks[0] = SecurityCall(abi.encodeCall(token.mintCrates, (1)), token.cratePrice());
        attacks[1] = SecurityCall(abi.encodeCall(token.mintWarehouses, (1)), token.warehousePrice());
        attacks[2] = SecurityCall(abi.encodeCall(token.unboxWarehouse, (116667)), 0);
        attacks[3] = SecurityCall(abi.encodeCall(token.unboxCrate, (111113)), 0);
        uint256[] memory ids = _one(111112);
        NFT111K.DeliveryQuote memory quote = _quote(address(buyer), 99, ids);
        attacks[4] = SecurityCall(
            abi.encodeCall(token.redeemForDelivery, (ids, quote, _deliverySignature(ids, quote, SIGNER_KEY))), quote.fee
        );
        uint256 deadline = block.timestamp + 300;
        attacks[5] = SecurityCall(
            abi.encodeCall(
                token.claimCrateReceipt,
                (
                    2000004,
                    INNER_CLAIM,
                    deadline,
                    _claimSignature(address(buyer), 2000004, INNER_CLAIM, deadline, SIGNER_KEY)
                )
            ),
            0
        );
        attacks[6] = SecurityCall(abi.encodeCall(token.unboxCrates, (_range(111112, 2))), 0);
        attacks[7] = SecurityCall(abi.encodeCall(token.releaseMint, (token.mintRecipients(0))), 0);
        attacks[8] = SecurityCall(abi.encodeCall(token.releaseDelivery, ()), 0);
        attacks[9] =
            SecurityCall(abi.encodeCall(token.mintCratesDiscounted, (1, new bytes32[](0))), token.discountCratePrice());
        attacks[10] = SecurityCall(abi.encodeCall(token.mintMonuments, (1)), 0.0088 ether);
        attacks[11] = SecurityCall(abi.encodeCall(token.unboxMonument, (117172)), 0);
        attacks[12] = SecurityCall(abi.encodeCall(token.releaseAllMint, ()), 0);
        buyer.configureAttacks(attacks);
        _expectRoutePurchaseTotals(buyer, route);
        buyer.execute(call_.data, call_.value);
        assertEq(buyer.callbacks(), _count(route));
        assertEq(buyer.blockedCalls(), attacks.length * _count(route));
        assertFalse(token.usedDeliveryOrders(99));
        assertFalse(token.usedClaims(INNER_CLAIM));
        _assertOutputs(route, address(buyer));
        assertEq(token.allocatedCrates(), route == 0 ? 18 : route == 1 ? 48 : 15);
        assertEq(token.warehousesMinted(), route == 1 ? 4 : 1);
        assertEq(_artworksMinted(), route == 3 ? 20 : route == 6 ? 60 : 0);
    }

    function _rejections(uint256 route) internal {
        SecurityReceiver buyer = _receiver();
        SecurityCall memory call_ = _route(buyer, route);
        uint256 count = _count(route);
        uint256[3] memory positions = [uint256(1), count / 2 + 1, count];
        for (uint256 i; i < positions.length; ++i) {
            buyer.configure(positions[i], false, address(0));
            _expectRoutePurchaseTotals(buyer, route);
            bytes32 beforeState = _state(address(buyer));
            SecurityVm(address(vm))
                .expectRevert(abi.encodeWithSelector(SecurityReceiver.ReceiverRejected.selector, positions[i]));
            buyer.execute(call_.data, call_.value);
            assertEq(_state(address(buyer)), beforeState);
            if (route < 2) _assertPurchaseTotals(15, 1, 0);
            assertEq(buyer.callbacks(), 0);
            _seedStillOwned(buyer);
            _assertOutputs(route, address(0));
        }
        buyer.configure(count / 2 + 1, true, address(0));
        _expectRoutePurchaseTotals(buyer, route);
        bytes32 beforeWrongSelector = _state(address(buyer));
        vm.expectRevert(bytes4(keccak256("TransferToNonERC721ReceiverImplementer()")));
        buyer.execute(call_.data, call_.value);
        assertEq(_state(address(buyer)), beforeWrongSelector);
        if (route < 2) _assertPurchaseTotals(15, 1, 0);
        _seedStillOwned(buyer);
        _assertOutputs(route, address(0));
        buyer.configure(0, false, address(0));
        _expectRoutePurchaseTotals(buyer, route);
        buyer.execute(call_.data, call_.value);
        _assertOutputs(route, address(buyer));
        if (route < 2) _assertPurchaseTotals(route == 0 ? 18 : 48, route == 0 ? 1 : 4, 0);
    }

    function _expectRoutePurchaseTotals(SecurityReceiver buyer, uint256 route) internal {
        buyer.expectProceeds(
            token.totalMintReceived() + (route == 0 ? 0.0003 ether : route == 1 ? 0.0033 ether : 0),
            token.totalDeliveryReceived() + (route == 4 ? 0.0001 ether : 0)
        );
        if (route < 2) buyer.expectPurchaseTotals(route == 0 ? 18 : 48, route == 0 ? 1 : 4, 0);
    }

    function _purchaseWithTotals(
        SecurityReceiver buyer,
        bool warehouse,
        uint256 quantity,
        uint256 allocated,
        uint256 warehouses,
        uint256 artworks
    ) internal {
        buyer.configure(0, false, address(0));
        buyer.expectPurchaseTotals(allocated, warehouses, artworks);
        if (warehouse) {
            buyer.execute(abi.encodeCall(token.mintWarehouses, (quantity)), quantity * token.warehousePrice());
        } else {
            buyer.execute(abi.encodeCall(token.mintCrates, (quantity)), quantity * token.cratePrice());
        }
        assertEq(buyer.callbacks(), quantity);
        _assertPurchaseTotals(allocated, warehouses, artworks);
    }

    function _assertPurchaseTotals(uint256 allocated, uint256 warehouses, uint256 artworks) internal view {
        (uint256 actualAllocated, uint256 actualWarehouses, uint256 actualArtworks,,,,,,,,,) = token.stats(address(0));
        assertEq(token.allocatedCrates(), allocated);
        assertEq(token.warehousesMinted(), warehouses);
        assertEq(actualAllocated, allocated);
        assertEq(actualWarehouses, warehouses);
        assertEq(actualArtworks, artworks);
    }

    function _callbackTransfers(uint256 route) internal {
        SecurityReceiver buyer = _receiver();
        SecurityCall memory call_ = _route(buyer, route);
        buyer.configure(0, false, BOB);
        buyer.execute(call_.data, call_.value);
        assertEq(buyer.callbacks(), _count(route));
        assertEq(token.balanceOf(BOB), _count(route));
        _assertOutputs(route, BOB);
    }

    function _openingThenMint(bool warehouse) internal {
        SecurityReceiver buyer = _receiver();
        SecurityCall[] memory calls = new SecurityCall[](2);
        calls[0] = SecurityCall(abi.encodeCall(token.unboxCrate, (111113)), 0);
        calls[1] = warehouse
            ? SecurityCall(abi.encodeCall(token.mintWarehouses, (1)), token.warehousePrice())
            : SecurityCall(abi.encodeCall(token.mintCrates, (1)), token.cratePrice());
        buyer.executeSequence(calls);
        _outputs(1, 20, 1, 1, address(buyer));
        if (warehouse) {
            _info(116668, 3, 2, address(buyer));
            assertEq(token.warehouseFirstCrate(2), 16);
            assertEq(token.allocatedCrates(), 26);
        } else {
            _info(111127, 2, 16, address(buyer));
            assertEq(token.allocatedCrates(), 16);
        }
    }

    function _caughtAuthorizedRetry(uint256 route) internal {
        SecurityReceiver buyer = _receiver();
        SecurityCall memory call_ = _route(buyer, route);
        buyer.configure(_count(route) / 2 + 1, false, address(0));
        SecurityCall[] memory calls = new SecurityCall[](1);
        calls[0] = call_;
        buyer.executeAfterCaughtRevert(call_.data, call_.value, calls);
        assertEq(buyer.caughtFailures(), 1);
        assertEq(buyer.callbacks(), _count(route));
        _assertOutputs(route, address(buyer));
        if (route == 4) assertTrue(token.usedDeliveryOrders(2));
        else assertTrue(token.usedClaims(OUTER_CLAIM));
    }

    function _count(uint256 route) internal pure returns (uint256) {
        return route == 0 || route == 1 || route == 4 ? 3 : route == 2 ? 11 : route == 6 ? 60 : 20;
    }

    function _assertOutputs(uint256 route, address holder) internal view {
        if (route == 0) {
            _outputs(111127, 3, 2, 16, holder);
        } else if (route == 1) {
            _outputs(116668, 3, 3, 2, holder);
        } else if (route == 2) {
            _outputs(111116, 11, 2, 5, holder);
        } else if (route == 3) {
            _outputs(1, 20, 1, 1, holder);
        } else if (route == 4) {
            _outputs(2000001, 3, 5, 1, holder);
        } else if (route == 5) {
            _outputs(1111172, 20, 4, 111172, holder);
        } else {
            _outputs(1, 20, 1, 1, holder);
            _outputs(21, 20, 1, 21, holder);
            _outputs(41, 20, 1, 41, holder);
        }
    }

    function _seedStillOwned(SecurityReceiver buyer) internal view {
        _outputs(111112, 3, 2, 1, address(buyer));
        _info(116667, 3, 1, address(buyer));
        _info(2000004, 5, 4, address(buyer));
        assertFalse(token.usedDeliveryOrders(2));
        assertFalse(token.usedClaims(OUTER_CLAIM));
    }

    function _releaseAllMint() internal {
        address[] memory recipients = _proceedsRecipients();
        for (uint256 i; i < recipients.length; ++i) {
            token.releaseMint(recipients[i]);
        }
    }

    function _state(address holder) internal view returns (bytes32) {
        bytes32 proceeds = keccak256(
            abi.encode(
                token.totalMintReceived(),
                token.totalMintReleased(),
                token.totalDeliveryReceived(),
                token.totalDeliveryReleased()
            )
        );
        return keccak256(
            abi.encode(
                token.allocatedCrates(),
                token.warehousesMinted(),
                _artworksMinted(),
                token.totalSupply(),
                token.balanceOf(holder),
                address(token).balance,
                holder.balance,
                token.warehouseFirstCrate(2),
                token.warehouseFirstCrate(3),
                token.warehouseFirstCrate(4),
                token.usedDeliveryOrders(2),
                token.usedClaims(OUTER_CLAIM),
                proceeds
            )
        );
    }

    function _artworksMinted() internal view returns (uint256 value) {
        (,, value,,,,,,,,,) = token.stats(address(0));
    }

    function _info(uint256 tokenId, uint8 kind, uint256 displayId, address holder) internal view {
        (uint8 actualKind, uint256 actualDisplayId, address actualHolder) = token.getTokenInfo(tokenId);
        assertEq(actualKind, kind);
        assertEq(actualDisplayId, displayId);
        assertEq(actualHolder, holder);
        if (holder != address(0)) assertEq(token.tokenURI(tokenId), token.previewTokenURI(kind, displayId));
    }

    function _outputs(uint256 firstId, uint256 count, uint8 kind, uint256 firstDisplayId, address holder)
        internal
        view
    {
        for (uint256 i; i < count; ++i) {
            if (holder == address(0)) _info(firstId + i, 0, 0, address(0));
            else _info(firstId + i, kind, firstDisplayId + i, holder);
        }
    }

    function _absent(uint256 firstId, uint256 count) internal view {
        _outputs(firstId, count, 0, 0, address(0));
    }

    function _buyCrates(address wallet, uint256 quantity) internal {
        uint256 value = quantity * token.cratePrice();
        vm.prank(wallet);
        token.mintCrates{value: value}(quantity);
    }

    function _quote(address wallet, uint256 orderId, uint256[] memory ids)
        internal
        view
        returns (NFT111K.DeliveryQuote memory)
    {
        uint256[] memory receipts = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint256 displayId,) = token.getTokenInfo(ids[i]);
            receipts[i] = (kind == 1 ? 1000000 : kind == 2 ? 2000000 : 3000000) + displayId;
        }
        return
            NFT111K.DeliveryQuote(orderId, wallet, 0.0001 ether, block.timestamp + 300, keccak256(abi.encode(receipts)));
    }

    function _redeem(address wallet, uint256[] memory ids, uint256 orderId) internal {
        NFT111K.DeliveryQuote memory quote = _quote(wallet, orderId, ids);
        bytes memory signature = _deliverySignature(ids, quote, SIGNER_KEY);
        vm.prank(wallet);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
    }

    function _deliverySignature(uint256[] memory ids, NFT111K.DeliveryQuote memory quote, uint256 key)
        internal
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                DELIVERY_TYPEHASH,
                quote.wallet,
                keccak256(abi.encode(ids)),
                quote.receiptIdsHash,
                quote.orderId,
                quote.fee,
                quote.deadline
            )
        );
        return _sign(structHash, key);
    }

    function _claimSignature(address wallet, uint256 receipt, bytes32 claimId, uint256 deadline, uint256 key)
        internal
        returns (bytes memory)
    {
        return _sign(keccak256(abi.encode(CLAIM_TYPEHASH, wallet, receipt, claimId, deadline)), key);
    }

    function _sign(bytes32 structHash, uint256 key) internal returns (bytes memory) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("111K"), keccak256("2"), block.chainid, address(token)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory) {
        return _range(id, 1);
    }

    function _range(uint256 firstId, uint256 count) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = firstId + i;
        }
    }
}
