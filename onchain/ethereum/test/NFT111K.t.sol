pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract RejectingDeliveryReceiver {
    fallback() external payable {
        revert();
    }
}

contract ContractBuyer {
    NFT111K public immutable token;
    bool public attack;
    bool public rejectReceipt;
    bool public reentryBlocked;
    uint256 public lastDisplayId;
    uint256 public transferOnReceipt;
    address public transferRecipient;

    constructor(NFT111K token_) {
        token = token_;
    }

    function mint(uint256 quantity) external payable {
        token.mintCrates{value: msg.value}(quantity);
    }

    function open(uint256 id, bool attack_) external {
        attack = attack_;
        token.unboxCrate(id);
    }

    function setRejectReceipt(bool reject_) external {
        rejectReceipt = reject_;
    }

    function setTransferOnReceipt(uint256 id, address recipient) external {
        transferOnReceipt = id;
        transferRecipient = recipient;
    }

    function redeem(uint256[] calldata ids, NFT111K.DeliveryQuote calldata quote, bytes calldata signature)
        external
        payable
    {
        token.redeemForDelivery{value: msg.value}(ids, quote, signature);
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(token));
        (uint8 kind, uint256 displayId, address holder) = token.getTokenInfo(id);
        require(holder == address(this));
        lastDisplayId = displayId;
        require(bytes(token.tokenURI(id)).length > 40);
        if (rejectReceipt && (kind == 4 || kind == 5)) revert();
        if (transferOnReceipt != 0 && (kind == 4 || kind == 5)) {
            uint256 transferId = transferOnReceipt;
            transferOnReceipt = 0;
            token.transferFrom(address(this), transferRecipient, transferId);
        }
        if (attack) {
            (bool success,) = address(token).call(abi.encodeCall(token.unboxCrate, (111_113)));
            reentryBlocked = !success;
            require(!success);
        }
        return this.onERC721Received.selector;
    }
}

contract NFT111KTest is TestSupport {
    NFT111K internal token;
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal alice = address(0xA110);
    address internal bob = address(0xB0B);
    address payable internal deliveryReceiver = payable(address(0xBEEF));
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant DELIVERY_TYPEHASH = keccak256(
        "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)"
    );
    bytes32 internal constant CLAIM_TYPEHASH =
        keccak256("CrateClaim(address wallet,uint256 receiptId,bytes32 claimId,uint256 deadline)");

    function setUp() public {
        vm.chainId(31337);
        vm.warp(2_000_000_000);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(address(this), 100 ether);
        token = new NFT111K(
            address(this),
            vm.addr(SIGNER_KEY),
            deliveryReceiver,
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            _proceedsRecipients(),
            _proceedsSharesBps()
        );
        token.setSaleActive(true);
    }

    function testCollectionNameSymbolAndSigningDomain() public view {
        assertEq(token.name(), "111K");
        assertEq(token.symbol(), "111K");
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,,
            uint256[] memory extensions
        ) = token.eip712Domain();
        assertEq(uint8(fields), 15);
        assertEq(name, "111K");
        assertEq(version, "2");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(token));
        assertEq(extensions.length, 0);
    }

    function testPricesPaymentReleasesAndOwnership() public {
        _buyCrates(alice, 2);
        _info(111112, 2, 1, alice);
        _info(111113, 2, 2, alice);
        assertEq(address(token).balance, 0.0002 ether);
        assertEq(deliveryReceiver.balance, 0);
        address[] memory recipients = _proceedsRecipients();
        uint256[] memory shares = _proceedsSharesBps();
        for (uint256 i; i < recipients.length; ++i) {
            vm.prank(alice);
            token.releaseMint(recipients[i]);
            assertEq(recipients[i].balance, 0.0002 ether * shares[i] / 10000);
        }
        assertEq(deliveryReceiver.balance, 0);
        assertEq(address(token).balance, 0);
        token.transferOwnership(bob);
        assertEq(token.owner(), address(this));
        vm.prank(bob);
        token.acceptOwnership();
        assertEq(token.owner(), bob);
    }

    function testPurchaseValidationAndPauseOnlyAffectsSales() public {
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.mintCrates(0);
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.mintCrates(16);
        vm.expectRevert(NFT111K.WrongPayment.selector);
        token.mintCrates(1);
        _buyCrates(alice, 1);
        token.setSaleActive(false);
        vm.prank(alice);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintCrates{value: 0.0001 ether}(1);
        vm.prank(alice);
        token.unboxCrate(111112);
        assertEq(token.balanceOf(alice), 20);
        token.setPrices(1 wei, 11 wei, 0, 0.0088 ether);
        token.setSaleActive(true);
        vm.prank(bob);
        token.mintWarehouses{value: 11 wei}(1);
        assertEq(token.allocatedCrates(), 12);
    }

    function testMissingTokenInfoAndMetadataAcrossRangesBeforeAndAfterMinting() public {
        _missingTokenMatrix(1);
        _missingToken(111112);
        _missingToken(116667);
        _missingToken(1_000_001);
        _missingToken(2_000_001);

        _buyCrates(alice, 3);
        _buyWarehouses(alice, 1);
        vm.prank(alice);
        token.unboxCrate(111112);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 111113;
        _redeem(alice, ids, 1);

        _missingTokenMatrix(21);
        _info(20, 1, 20, alice);
        _info(111114, 2, 3, alice);
        _info(116667, 3, 1, alice);
        _info(1_000_001, 4, 1, alice);
        _info(2_000_002, 5, 2, alice);
    }

    function testArtworkBurnsPreserveNeighborsAtBatchBoundariesAndTail() public {
        _buyCrates(alice, 2);
        vm.startPrank(alice);
        token.unboxCrate(111113);
        token.unboxCrate(111112);
        vm.stopPrank();
        uint256[] memory ids = new uint256[](4);
        ids[0] = 1;
        ids[1] = 10;
        ids[2] = 20;
        ids[3] = 40;
        _redeem(alice, ids, 1);

        for (uint256 i; i < ids.length; ++i) {
            _missingToken(ids[i]);
        }
        _info(2, 1, 2, alice);
        _info(9, 1, 9, alice);
        _info(11, 1, 11, alice);
        _info(19, 1, 19, alice);
        _info(21, 1, 21, alice);
        _info(39, 1, 39, alice);
        _missingToken(41);
        _info(1_000_001, 4, 1, alice);
        _info(1_000_010, 4, 10, alice);
        _info(1_000_040, 4, 40, alice);
        _info(1_000_020, 4, 20, alice);
    }

    function testWarehouseReservationsStayDistinctAndUnpackingDoesNotChangeSupply() public {
        _buyCrates(alice, 2);
        vm.prank(bob);
        token.mintWarehouses{value: 0.0022 ether}(2);
        _buyCrates(alice, 1);
        assertEq(token.allocatedCrates(), 25);
        assertEq(token.warehouseFirstCrate(1), 3);
        assertEq(token.warehouseFirstCrate(2), 14);
        _info(111136, 2, 25, alice);
        _info(111114, 0, 0, address(0));
        vm.prank(bob);
        token.unboxWarehouse(116668);
        assertEq(token.allocatedCrates(), 25);
        _missingToken(116668);
        for (uint256 number = 14; number <= 24; ++number) {
            _info(111111 + number, 2, number, bob);
        }
        vm.prank(bob);
        vm.expectRevert();
        token.unboxWarehouse(116668);
        vm.prank(alice);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxWarehouse(116667);
    }

    function testSequentialArtworkIdsSurviveArbitraryOpenOrderTransferAndBurn() public {
        _buyCrates(alice, 3);
        vm.startPrank(alice);
        token.unboxCrate(111114);
        token.unboxCrate(111112);
        token.transferFrom(alice, bob, 10);
        vm.stopPrank();
        _info(1, 1, 1, alice);
        _info(20, 1, 20, alice);
        _info(21, 1, 21, alice);
        _info(40, 1, 40, alice);
        _info(10, 1, 10, bob);
        _info(9, 1, 9, alice);
        _info(11, 1, 11, alice);
        uint256[] memory ids = _one(9);
        _redeem(alice, ids, 1);
        _info(9, 0, 0, address(0));
        _info(1_000_009, 4, 9, alice);
        _info(8, 1, 8, alice);
        _info(11, 1, 11, alice);
        assertEq(token.tokenURI(21), token.previewTokenURI(1, 21));
        vm.expectRevert();
        token.tokenURI(9);
    }

    function testPhysicalReceiptClaimUsesSeparateArtworkIdsAndCanTransfer() public {
        _buyCrates(alice, 3);
        _redeem(alice, _one(111114), 1);
        _missingToken(111114);
        _info(2_000_003, 5, 3, alice);
        vm.prank(alice);
        token.transferFrom(alice, bob, 2_000_003);
        bytes32 claimId = keccak256("physical-crate-three");
        uint256 deadline = block.timestamp + 300;
        bytes memory signature = _claimSignature(bob, 2_000_003, claimId, deadline);
        vm.prank(alice);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.claimCrateReceipt(2_000_003, claimId, deadline, signature);
        vm.prank(bob);
        token.claimCrateReceipt(2_000_003, claimId, deadline, signature);
        for (uint256 id = 41; id <= 60; ++id) {
            _info(1_111_111 + id, 4, 111_111 + id, bob);
        }
        _missingToken(2_000_003);
        vm.prank(bob);
        vm.expectRevert();
        token.claimCrateReceipt(2_000_003, claimId, deadline, signature);
        vm.prank(alice);
        token.unboxCrate(111112);
        _info(1, 1, 1, alice);
        _info(20, 1, 20, alice);
    }

    function testStrictOwnerEvenIfOperatorApproved() public {
        _buyCrates(alice, 1);
        vm.prank(alice);
        token.setApprovalForAll(bob, true);
        vm.prank(bob);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxCrate(111112);
    }

    function testPhysicalClaimsAndDigitalReceiptsHaveSeparateIdsAndExactTokenUrls() public {
        _buyCrates(alice, 2);
        _redeem(alice, _one(111112), 1);
        bytes32 claimId = keccak256("separate-physical-artwork-range");
        uint256 deadline = block.timestamp + 300;
        bytes memory signature = _claimSignature(alice, 2000001, claimId, deadline);
        vm.prank(alice);
        token.claimCrateReceipt(2000001, claimId, deadline, signature);
        _info(1111112, 4, 111112, alice);
        _info(1111131, 4, 111131, alice);
        _missingToken(1);
        (,, uint256 artworksBefore,,,,,,,,,) = token.stats(address(0));
        assertEq(artworksBefore, 0);
        assertEq(token.tokenURI(1111112), "https://cdn.mons.shop/111k-sepolia/1111112.json");
        vm.prank(alice);
        token.unboxCrate(111113);
        _info(1, 1, 1, alice);
        _info(20, 1, 20, alice);
        assertEq(token.tokenURI(1), "https://cdn.mons.shop/111k-sepolia/1.json");
        _redeem(alice, _one(1), 2);
        _info(1000001, 4, 1, alice);
        _info(1111112, 4, 111112, alice);
        assertEq(token.tokenURI(1000001), "https://cdn.mons.shop/111k-sepolia/1000001.json");
        assertEq(token.totalSupply(), 40);
        (,, uint256 artworksAfter,,,,,,,,,) = token.stats(address(0));
        assertEq(artworksAfter, 20);
    }

    function testDuplicateItemsRevertAtomicallyWithoutConsumingAuthorization() public {
        _buyCrates(alice, 1);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 111112;
        ids[1] = 111112;
        NFT111K.DeliveryQuote memory quote = _quote(alice, 9, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(alice);
        vm.expectRevert();
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        assertFalse(token.usedDeliveryOrders(9));
        _info(111112, 2, 1, alice);
        _info(2_000_001, 0, 0, address(0));
    }

    function testWarehouseAndReceiptsCannotBeDeliveredAgain() public {
        _buyCrates(alice, 1);
        vm.prank(alice);
        token.mintWarehouses{value: 0.0011 ether}(1);
        uint256[] memory warehouse = _one(116667);
        NFT111K.DeliveryQuote memory quote = _quote(alice, 1, warehouse);
        bytes memory signature = _deliverySignature(warehouse, quote);
        vm.prank(alice);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.redeemForDelivery{value: quote.fee}(warehouse, quote, signature);
        _redeem(alice, _one(111112), 2);
        uint256[] memory receipt = _one(2_000_001);
        quote = _quote(alice, 3, receipt);
        signature = _deliverySignature(receipt, quote);
        vm.prank(alice);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.redeemForDelivery{value: quote.fee}(receipt, quote, signature);
    }

    function testReliquaryCannotBeDelivered() public {
        vm.prank(alice);
        token.mintReliquaries{value: 0.0088 ether}(1);
        uint256[] memory ids = _one(117172);
        NFT111K.DeliveryQuote memory quote = _quote(alice, 1, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(alice);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        _info(117172, 6, 1, alice);
        assertFalse(token.usedDeliveryOrders(1));
    }

    function testSignaturesBindWalletItemsFeeOrderAndDomain() public {
        _buyCrates(alice, 2);
        uint256[] memory ids = _one(111112);
        NFT111K.DeliveryQuote memory quote = _quote(alice, 1, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(bob);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        vm.prank(alice);
        vm.expectRevert(NFT111K.WrongPayment.selector);
        token.redeemForDelivery(ids, quote, signature);
        vm.prank(alice);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.redeemForDelivery{value: quote.fee}(_one(111113), quote, signature);
        quote.orderId = 2;
        vm.prank(alice);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        quote.orderId = 1;
        quote.fee += 1;
        vm.prank(alice);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        quote.fee -= 1;
        bytes32 receiptIdsHash = quote.receiptIdsHash;
        quote.receiptIdsHash = bytes32(0);
        vm.prank(alice);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        quote.receiptIdsHash = receiptIdsHash;
        vm.chainId(1);
        vm.prank(alice);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        vm.chainId(31337);
        vm.prank(alice);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        vm.prank(alice);
        vm.expectRevert(NFT111K.AuthorizationAlreadyUsed.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
    }

    function testDeliveryArtworkIdentityStaysStableAcrossOpeningOrderReorg() public {
        _buyCrates(alice, 3);
        uint256 snapshot = vm.snapshotState();
        vm.prank(alice);
        token.unboxCrate(111114);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 111113;
        ids[1] = 1;
        NFT111K.DeliveryQuote memory quote = _quote(alice, 17, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        string memory originalURI = token.tokenURI(1);
        _info(1, 1, 1, alice);

        assertTrue(vm.revertToState(snapshot));
        vm.prank(alice);
        token.unboxCrate(111112);
        _info(1, 1, 1, alice);
        assertEq(token.tokenURI(1), originalURI);
        assertEq(_quote(alice, 17, ids).receiptIdsHash, quote.receiptIdsHash);
        vm.prank(alice);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        assertTrue(token.usedDeliveryOrders(17));
        _info(111113, 0, 0, address(0));
        _info(1, 0, 0, address(0));
        _info(2_000_002, 5, 2, alice);
        _info(1_000_001, 4, 1, alice);
    }

    function testDeliveryRejectsSignedMalformedOrMismatchedReceiptHashesAtomically() public {
        _buyCrates(alice, 2);
        vm.prank(alice);
        token.unboxCrate(111113);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 111112;
        ids[1] = 1;
        uint256[] memory receipts = new uint256[](2);
        receipts[0] = 2_000_001;
        receipts[1] = 1_000_001;
        bytes32[] memory invalidHashes = new bytes32[](6);
        invalidHashes[0] = bytes32(0);
        invalidHashes[1] = keccak256("invalid receipt commitment");
        invalidHashes[2] = keccak256(abi.encodePacked(receipts));
        invalidHashes[3] = keccak256(abi.encode(_one(receipts[0])));
        receipts[1] = 1_000_002;
        invalidHashes[4] = keccak256(abi.encode(receipts));
        receipts[0] = 1_000_001;
        receipts[1] = 2_000_001;
        invalidHashes[5] = keccak256(abi.encode(receipts));
        NFT111K.DeliveryQuote memory quote = _quote(alice, 18, ids);
        uint256 balanceBefore = address(token).balance;
        for (uint256 i; i < invalidHashes.length; ++i) {
            quote.receiptIdsHash = invalidHashes[i];
            bytes memory signature = _deliverySignature(ids, quote);
            vm.prank(alice);
            vm.expectRevert(NFT111K.InvalidAuthorization.selector);
            token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
            assertFalse(token.usedDeliveryOrders(18));
            assertEq(address(token).balance, balanceBefore);
            _info(111112, 2, 1, alice);
            _info(1, 1, 1, alice);
            _info(2_000_001, 0, 0, address(0));
            _info(1_000_001, 0, 0, address(0));
        }
        _redeem(alice, ids, 18);
        _info(2_000_001, 5, 1, alice);
        _info(1_000_001, 4, 1, alice);
    }

    function testVersionOneDeliveryAndClaimSignaturesAreRejected() public {
        _assertRejectedDomain(
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("111K"), keccak256("1"), block.chainid, address(token)))
        );
    }

    function testPriorCollectionDomainSignaturesAreRejected() public {
        bytes32 priorNameHash = 0x57a43f4571efe7668bd97a09b52785e99b105217cc6634d5f78d7947912d9761;
        _assertRejectedDomain(
            keccak256(abi.encode(DOMAIN_TYPEHASH, priorNameHash, keccak256("2"), block.chainid, address(token)))
        );
    }

    function _assertRejectedDomain(bytes32 legacyDomain) private {
        _buyCrates(alice, 1);
        uint256[] memory ids = _one(111112);
        NFT111K.DeliveryQuote memory quote = _quote(alice, 20, ids);
        bytes32 deliveryHash = keccak256(
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
        bytes memory signature = _sign(keccak256(abi.encodePacked(hex"1901", legacyDomain, deliveryHash)));
        vm.prank(alice);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        assertFalse(token.usedDeliveryOrders(20));
        _redeem(alice, ids, 20);
        bytes32 claimId = keccak256("version-two-claim");
        bytes32 claimHash = keccak256(abi.encode(CLAIM_TYPEHASH, alice, uint256(2_000_001), claimId, quote.deadline));
        signature = _sign(keccak256(abi.encodePacked(hex"1901", legacyDomain, claimHash)));
        vm.prank(alice);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.claimCrateReceipt(2_000_001, claimId, quote.deadline, signature);
        assertFalse(token.usedClaims(claimId));
        _info(2_000_001, 5, 1, alice);
        signature = _claimSignature(alice, 2_000_001, claimId, quote.deadline);
        vm.prank(alice);
        token.claimCrateReceipt(2_000_001, claimId, quote.deadline, signature);
        assertTrue(token.usedClaims(claimId));
    }

    function testQuoteDeadlineAndSignerRotation() public {
        _buyCrates(alice, 1);
        uint256[] memory ids = _one(111112);
        NFT111K.DeliveryQuote memory quote = _quote(alice, 1, ids);
        quote.deadline = block.timestamp - 1;
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(alice);
        vm.expectRevert(NFT111K.AuthorizationExpired.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        quote.deadline = block.timestamp + 601;
        signature = _deliverySignature(ids, quote);
        vm.prank(alice);
        vm.expectRevert(NFT111K.AuthorizationTooLong.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        quote.deadline = block.timestamp + 300;
        signature = _deliverySignature(ids, quote);
        token.setQuoteSigner(bob);
        vm.prank(alice);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        token.setQuoteSigner(vm.addr(SIGNER_KEY));
        vm.prank(alice);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
    }

    function testClaimAuthorizationCannotChangeCrateOrReplayClaimId() public {
        _buyCrates(alice, 2);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 111112;
        ids[1] = 111113;
        _redeem(alice, ids, 1);
        bytes32 claimId = keccak256("claim");
        uint256 deadline = block.timestamp + 300;
        bytes memory signature = _claimSignature(alice, 2_000_001, claimId, deadline);
        vm.prank(alice);
        vm.expectRevert(NFT111K.InvalidAuthorization.selector);
        token.claimCrateReceipt(2_000_002, claimId, deadline, signature);
        vm.prank(alice);
        token.claimCrateReceipt(2_000_001, claimId, deadline, signature);
        signature = _claimSignature(alice, 2_000_002, claimId, deadline);
        vm.prank(alice);
        vm.expectRevert(NFT111K.AuthorizationAlreadyUsed.selector);
        token.claimCrateReceipt(2_000_002, claimId, deadline, signature);
        _info(2_000_002, 5, 2, alice);
    }

    function testContractReceiverReadsCorrectMetadataAndCannotReenter() public {
        ContractBuyer buyer = new ContractBuyer(token);
        buyer.mint{value: 0.0002 ether}(2);
        buyer.open(111112, true);
        assertTrue(buyer.reentryBlocked());
        assertEq(buyer.lastDisplayId(), 20);
        _info(111113, 2, 2, address(buyer));
        _info(20, 1, 20, address(buyer));
    }

    function testReceiverRejectionRollsBackBurnAndDeliveryOrder() public {
        ContractBuyer buyer = new ContractBuyer(token);
        buyer.mint{value: 0.0001 ether}(1);
        buyer.setRejectReceipt(true);
        uint256[] memory ids = _one(111112);
        NFT111K.DeliveryQuote memory quote = _quote(address(buyer), 1, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.expectRevert();
        buyer.redeem{value: quote.fee}(ids, quote, signature);
        assertFalse(token.usedDeliveryOrders(1));
        _info(111112, 2, 1, address(buyer));
        _info(2_000_001, 0, 0, address(0));
        buyer.setRejectReceipt(false);
        buyer.redeem{value: quote.fee}(ids, quote, signature);
        _info(2_000_001, 5, 1, address(buyer));
    }

    function testReceiptCallbackCannotTransferAnAlreadyBurnedSelectedToken() public {
        ContractBuyer buyer = new ContractBuyer(token);
        buyer.mint{value: 0.0002 ether}(2);
        buyer.setTransferOnReceipt(111113, bob);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 111112;
        ids[1] = 111113;
        NFT111K.DeliveryQuote memory quote = _quote(address(buyer), 19, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.expectRevert(bytes4(keccak256("OwnerQueryForNonexistentToken()")));
        buyer.redeem{value: quote.fee}(ids, quote, signature);
        assertFalse(token.usedDeliveryOrders(19));
        _info(111112, 2, 1, address(buyer));
        _info(111113, 2, 2, address(buyer));
        _info(2_000_001, 0, 0, address(0));
        _info(2_000_002, 0, 0, address(0));
    }

    function testUnsortedDeliveryBurnLogsPrecedeReceiptMintsAndPreservePairedIdentities() public {
        _buyCrates(alice, 3);
        vm.startPrank(alice);
        token.unboxCrate(111113);
        token.unboxCrate(111112);
        vm.stopPrank();
        uint256[] memory ids = new uint256[](4);
        ids[0] = 111114;
        ids[1] = 20;
        ids[2] = 21;
        ids[3] = 1;
        uint256[] memory receipts = new uint256[](4);
        receipts[0] = 2_000_003;
        receipts[1] = 1_000_020;
        receipts[2] = 1_000_021;
        receipts[3] = 1_000_001;
        NFT111K.DeliveryQuote memory quote = _quote(alice, 21, ids);
        assertEq(quote.receiptIdsHash, keccak256(abi.encode(receipts)));
        bytes memory signature = _deliverySignature(ids, quote);
        uint256 supply = token.totalSupply();
        uint256 balance = token.balanceOf(alice);
        vm.recordLogs();
        vm.prank(alice);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, ids.length * 2 + 1);
        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        for (uint256 i; i < ids.length; ++i) {
            Vm.Log memory burned = logs[i];
            assertEq(burned.emitter, address(token));
            assertEq(burned.topics.length, 4);
            assertEq(burned.topics[0], transferTopic);
            assertEq(burned.topics[1], bytes32(uint256(uint160(alice))));
            assertEq(burned.topics[2], bytes32(0));
            assertEq(burned.topics[3], bytes32(ids[i]));
            assertEq(burned.data.length, 0);
            Vm.Log memory minted = logs[ids.length + i];
            assertEq(minted.emitter, address(token));
            assertEq(minted.topics.length, 4);
            assertEq(minted.topics[0], transferTopic);
            assertEq(minted.topics[1], bytes32(0));
            assertEq(minted.topics[2], bytes32(uint256(uint160(alice))));
            assertEq(minted.topics[3], bytes32(receipts[i]));
            assertEq(minted.data.length, 0);
            _missingToken(ids[i]);
        }
        Vm.Log memory delivered = logs[logs.length - 1];
        assertEq(delivered.emitter, address(token));
        assertEq(delivered.topics.length, 3);
        assertEq(delivered.topics[0], keccak256("DeliveryRedeemed(uint256,address,uint256,uint256[],uint256[])"));
        assertEq(delivered.topics[1], bytes32(quote.orderId));
        assertEq(delivered.topics[2], bytes32(uint256(uint160(alice))));
        (uint256 fee, uint256[] memory eventIds, uint256[] memory eventReceipts) =
            abi.decode(delivered.data, (uint256, uint256[], uint256[]));
        assertEq(fee, quote.fee);
        assertEq(keccak256(abi.encode(eventIds)), keccak256(abi.encode(ids)));
        assertEq(keccak256(abi.encode(eventReceipts)), quote.receiptIdsHash);
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(alice), balance);
        assertTrue(token.usedDeliveryOrders(quote.orderId));
        _info(2_000_003, 5, 3, alice);
        _info(1_000_020, 4, 20, alice);
        _info(1_000_001, 4, 1, alice);
        _info(1_000_021, 4, 21, alice);
        _info(2, 1, 2, alice);
        _info(22, 1, 22, alice);
    }

    function testRejectingDeliveryReceiverCannotBlockPurchasesOrDeliveryAndReleaseCanRetry() public {
        token.setDeliveryPaymentReceiver(payable(address(new RejectingDeliveryReceiver())));
        _buyCrates(alice, 1);
        _redeem(alice, _one(111112), 1);
        vm.expectRevert(NFT111K.ProceedsPaymentFailed.selector);
        token.releaseDelivery();
        assertEq(address(token).balance, 0.0002 ether);
        assertEq(token.totalDeliveryReleased(), 0);
        address[] memory recipients = _proceedsRecipients();
        for (uint256 i; i < recipients.length; ++i) {
            token.releaseMint(recipients[i]);
        }
        assertEq(address(token).balance, 0.0001 ether);
        token.setDeliveryPaymentReceiver(deliveryReceiver);
        token.releaseDelivery();
        assertEq(deliveryReceiver.balance, 0.0001 ether);
        assertEq(address(token).balance, 0);
    }

    function testBaseURIUpdatePreservesOwnershipAndValidatesPreviews() public {
        _buyCrates(alice, 1);
        vm.prank(alice);
        vm.expectRevert();
        token.setBaseURI("https://cdn.mons.shop/111k/");
        token.setBaseURI("https://cdn.mons.shop/111k/");
        _info(111112, 2, 1, alice);
        assertEq(token.tokenURI(111112), "https://cdn.mons.shop/111k/111112.json");
        assertTrue(token.supportsInterface(0x49064906));
        assertTrue(token.supportsInterface(0x80ac58cd));
        vm.expectRevert(NFT111K.InvalidMetadataItem.selector);
        token.previewTokenURI(2, 5556);
        vm.expectRevert(NFT111K.InvalidMetadataItem.selector);
        token.previewTokenURI(0, 1);
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        token.setBaseURI("");
    }

    function testFuzzDisplayNumbers(uint16 requestedCrate, uint8 itemOffset) public {
        uint256 crateNumber = uint256(requestedCrate) % 150 + 1;
        uint256 remainder = crateNumber;
        while (remainder > 0) {
            uint256 batch = remainder > 15 ? 15 : remainder;
            _buyCrates(alice, batch);
            remainder -= batch;
        }
        vm.prank(alice);
        token.unboxCrate(111111 + crateNumber);
        uint256 offset = uint256(itemOffset) % 20;
        _info(1 + offset, 1, 1 + offset, alice);
    }

    function testFullSupplyMixedDigitalAndPhysicalHasExactly111111ArtworkIdentities() public {
        _buyCrates(alice, 5);
        _buyWarehouses(alice, 504);
        _buyCrates(alice, 6);
        assertEq(token.allocatedCrates(), 5555);
        vm.prank(alice);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintCrates{value: 0.0001 ether}(1);
        vm.prank(alice);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintWarehouses{value: 0.0011 ether}(1);
        vm.startPrank(alice);
        for (uint256 warehouse = 1; warehouse <= 504; ++warehouse) {
            token.unboxWarehouse(116666 + warehouse);
        }
        for (uint256 crate = 1; crate < 5555; ++crate) {
            token.unboxCrate(111111 + crate);
        }
        vm.stopPrank();
        _redeem(alice, _one(116666), 7);
        bytes32 claimId = keccak256("final physical crate");
        uint256 deadline = block.timestamp + 300;
        bytes memory signature = _claimSignature(alice, 2_005_555, claimId, deadline);
        vm.prank(alice);
        token.claimCrateReceipt(2_005_555, claimId, deadline, signature);
        assertEq(token.balanceOf(alice), 111111);
        assertEq(token.totalSupply(), 111111);
        _info(111080, 1, 111080, alice);
        for (uint256 displayId = 222192; displayId <= 222222; ++displayId) {
            _info(1_000_000 + displayId, 4, displayId, alice);
        }
        (uint256 allocated, uint256 warehouses, uint256 artworks,,,,,,,,,) = token.stats(address(0));
        assertEq(allocated, 5555);
        assertEq(warehouses, 504);
        assertEq(artworks, 111080);
    }

    function testFinalCrateUnboxedFirstGets31AndDoesNotBreakLaterArtOwnership() public {
        _buyWarehouses(alice, 505);
        vm.startPrank(alice);
        token.unboxWarehouse(117171);
        token.unboxCrate(116666);
        token.unboxWarehouse(116667);
        token.unboxCrate(111112);
        token.transferFrom(alice, bob, 16);
        vm.stopPrank();
        for (uint256 id = 1; id <= 31; ++id) {
            _info(id, 1, id, id == 16 ? bob : alice);
        }
        _info(32, 1, 32, alice);
        _info(51, 1, 51, alice);
        _redeem(alice, _one(31), 1);
        _info(1_000_031, 4, 31, alice);
        _info(32, 1, 32, alice);
    }

    function testWarehouseUnavailableBelow11Remaining() public {
        _buyWarehouses(alice, 504);
        _buyCrates(alice, 1);
        assertEq(token.remainingCrates(), 10);
        vm.prank(alice);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintWarehouses{value: 0.0011 ether}(1);
        _buyCrates(alice, 10);
        assertEq(token.remainingCrates(), 0);
    }

    function _buyCrates(address wallet, uint256 count) internal {
        uint256 cost = token.cratePrice() * count;
        vm.prank(wallet);
        token.mintCrates{value: cost}(count);
    }

    function _buyWarehouses(address wallet, uint256 count) internal {
        while (count != 0) {
            uint256 batch = count > 15 ? 15 : count;
            uint256 cost = token.warehousePrice() * batch;
            vm.prank(wallet);
            token.mintWarehouses{value: cost}(batch);
            count -= batch;
        }
    }

    function _info(uint256 tokenId, uint8 expectedKind, uint256 expectedId, address expectedOwner) internal view {
        (uint8 kind, uint256 id, address holder) = token.getTokenInfo(tokenId);
        assertEq(kind, expectedKind);
        assertEq(id, expectedId);
        assertEq(holder, expectedOwner);
    }

    function _missingToken(uint256 tokenId) internal {
        _info(tokenId, 0, 0, address(0));
        vm.expectRevert(bytes4(keccak256("URIQueryForNonexistentToken()")));
        token.tokenURI(tokenId);
    }

    function _missingTokenMatrix(uint256 nextArtwork) internal {
        uint256[26] memory ids = [
            uint256(0),
            nextArtwork,
            nextArtwork + 1,
            111110,
            111111,
            111115,
            116665,
            116666,
            116668,
            117170,
            117171,
            117172,
            500000,
            999999,
            1_000_000,
            1_000_002,
            1_111_110,
            1_111_111,
            1_111_112,
            1_999_999,
            2_000_000,
            2_000_003,
            2_005_554,
            2_005_555,
            2_005_556,
            type(uint256).max
        ];
        for (uint256 i; i < ids.length; ++i) {
            _missingToken(ids[i]);
        }
    }

    function _quote(address wallet, uint256 orderId, uint256[] memory ids)
        internal
        view
        returns (NFT111K.DeliveryQuote memory)
    {
        uint256[] memory receipts = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint256 displayId,) = token.getTokenInfo(ids[i]);
            if (kind == 1) receipts[i] = 1_000_000 + displayId;
            else if (kind == 2) receipts[i] = 2_000_000 + displayId;
        }
        return
            NFT111K.DeliveryQuote(orderId, wallet, 0.0001 ether, block.timestamp + 300, keccak256(abi.encode(receipts)));
    }

    function _redeem(address wallet, uint256[] memory ids, uint256 orderId) internal {
        NFT111K.DeliveryQuote memory quote = _quote(wallet, orderId, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(wallet);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
    }

    function _domain() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("111K"), keccak256("2"), block.chainid, address(token)));
    }

    function _deliverySignature(uint256[] memory ids, NFT111K.DeliveryQuote memory quote)
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
        return _sign(keccak256(abi.encodePacked(hex"1901", _domain(), structHash)));
    }

    function _claimSignature(address wallet, uint256 receipt, bytes32 claimId, uint256 deadline)
        internal
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(CLAIM_TYPEHASH, wallet, receipt, claimId, deadline));
        return _sign(keccak256(abi.encodePacked(hex"1901", _domain(), structHash)));
    }

    function _sign(bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory result) {
        result = new uint256[](1);
        result[0] = id;
    }
}
