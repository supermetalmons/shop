pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract ProceedsReceiver {
    NFT111K public token;
    bool public rejecting;
    bool public attacking;
    address payable public rotateTo;
    uint256 public callbacks;
    uint256 public blockedCalls;

    function configure(NFT111K token_, bool rejecting_, bool attacking_, address payable rotateTo_) external {
        token = token_;
        rejecting = rejecting_;
        attacking = attacking_;
        rotateTo = rotateTo_;
    }

    function acceptOwnership() external {
        token.acceptOwnership();
    }

    receive() external payable {
        require(msg.sender == address(token));
        if (rejecting) revert();
        callbacks++;
        require(token.releasableMint(address(this)) == 0);
        if (token.deliveryPaymentReceiver() == address(this)) require(token.releasableDelivery() == 0);
        if (attacking) {
            _blocked(abi.encodeCall(token.releaseMint, (token.mintRecipients(0))));
            _blocked(abi.encodeCall(token.releaseDelivery, ()));
            _blocked(abi.encodeCall(token.mintCrates, (1)));
            _blocked(abi.encodeCall(token.mintWarehouses, (1)));
            uint256[] memory ids = new uint256[](0);
            NFT111K.DeliveryQuote memory quote;
            _blocked(abi.encodeCall(token.redeemForDelivery, (ids, quote, bytes(""))));
        }
        if (rotateTo != address(0)) token.setDeliveryPaymentReceiver(rotateTo);
    }

    function _blocked(bytes memory data) private {
        (bool success, bytes memory reason) = address(token).call(data);
        require(!success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        blockedCalls++;
    }
}

contract ProceedsBuyer {
    NFT111K public immutable token;
    uint256 public expectedMint;
    uint256 public expectedDelivery;
    bool public rejecting;

    constructor(NFT111K token_) {
        token = token_;
    }

    function configure(uint256 mint_, uint256 delivery_, bool rejecting_) external {
        expectedMint = mint_;
        expectedDelivery = delivery_;
        rejecting = rejecting_;
    }

    function execute(bytes calldata data, uint256 value) external {
        (bool success, bytes memory reason) = address(token).call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(msg.sender == address(token));
        require(token.totalMintReceived() == expectedMint);
        require(token.totalDeliveryReceived() == expectedDelivery);
        if (rejecting) revert();
        return this.onERC721Received.selector;
    }
}

contract ProceedsForwarder {
    NFT111K private immutable token;
    address private immutable recipient;

    constructor(NFT111K token_, address recipient_) {
        token = token_;
        recipient = recipient_;
    }

    function buy() external payable {
        token.mintCrates{value: msg.value}(1);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(token));
        token.approve(recipient, tokenId);
        require(token.getApproved(tokenId) == recipient);
        token.transferFrom(address(this), recipient, tokenId);
        return this.onERC721Received.selector;
    }
}

contract ForcedProceeds {
    constructor(address payable recipient) payable {
        selfdestruct(recipient);
    }
}

contract NFT111KProceedsTest is TestSupport {
    NFT111K private token;
    address private constant BUYER = address(0xB00001);
    address payable private constant DELIVERY = payable(address(0xD00001));
    address payable private constant NEXT_DELIVERY = payable(address(0xD00002));
    uint256 private constant SIGNER_KEY = 0x5151;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(2_000_000_000);
        vm.deal(address(this), 100 ether);
        vm.deal(BUYER, 100 ether);
        (address[] memory recipients, uint256[] memory shares) = _split(4);
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
    }

    function testEverySupportedRecipientCount() public {
        for (uint256 count = 2; count <= 8; ++count) {
            (address[] memory recipients, uint256[] memory shares) = _split(count);
            NFT111K configured = _deploy(recipients, shares, DELIVERY);
            assertEq(configured.mintRecipientCount(), count);
            for (uint256 i; i < count; ++i) {
                assertEq(configured.mintRecipients(i), recipients[i]);
                assertEq(configured.mintSharesBps(recipients[i]), shares[i]);
            }
            assertEq(configured.deliveryPaymentReceiver(), DELIVERY);
        }
    }

    function testInvalidRecipientCountsAndShares() public {
        for (uint256 count; count <= 9; ++count) {
            if (count >= 2 && count <= 8) continue;
            (address[] memory invalidRecipients, uint256[] memory invalidShares) = _split(count);
            vm.expectRevert(NFT111K.InvalidMintSplit.selector);
            _deploy(invalidRecipients, invalidShares, DELIVERY);
        }
        (address[] memory recipients, uint256[] memory shares) = _split(3);
        vm.expectRevert(NFT111K.InvalidMintSplit.selector);
        _deploy(recipients, new uint256[](2), DELIVERY);
        shares[0] = 0;
        vm.expectRevert(NFT111K.InvalidMintSplit.selector);
        _deploy(recipients, shares, DELIVERY);
        shares[0] = type(uint256).max;
        vm.expectRevert(NFT111K.InvalidMintSplit.selector);
        _deploy(recipients, shares, DELIVERY);
        shares[0] = 3332;
        vm.expectRevert(NFT111K.InvalidMintSplit.selector);
        _deploy(recipients, shares, DELIVERY);
        shares[0] = 3334;
        vm.expectRevert(NFT111K.InvalidMintSplit.selector);
        _deploy(recipients, shares, DELIVERY);
    }

    function testInvalidRecipientAddresses() public {
        (address[] memory recipients, uint256[] memory shares) = _split(3);
        recipients[0] = address(0);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(recipients, shares, DELIVERY);
        recipients[0] = recipients[1];
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(recipients, shares, DELIVERY);
        recipients[0] = _nextCreateAddress();
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(recipients, shares, DELIVERY);
        recipients[0] = address(0xC00001);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(recipients, shares, payable(address(0)));
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(recipients, shares, payable(recipients[0]));
        address payable self = payable(_nextCreateAddress());
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(recipients, shares, self);
    }

    function testMintRoutesRecordActualRevenueAndSeparateDelivery() public {
        vm.prank(BUYER);
        token.mintCrates{value: 0.0002 ether}(2);
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(BUYER))));
        token.setDiscountConfig(leaf, 1);
        vm.prank(BUYER);
        token.mintCratesDiscounted{value: 0.00005 ether}(1, new bytes32[](0));
        vm.prank(BUYER);
        token.mintWarehouses{value: 0.0022 ether}(2);
        _deliver(BUYER, 111112, 1, 17);
        assertEq(token.totalMintReceived(), 0.00245 ether);
        assertEq(token.totalDeliveryReceived(), 17);
        assertEq(token.releasableDelivery(), 17);
        vm.prank(address(0xCA11));
        token.releaseDelivery();
        assertEq(DELIVERY.balance, 17);
        assertEq(address(token).balance, 0.00245 ether);
        _releaseAll();
        assertEq(token.totalMintReleased(), 0.00245 ether);
        assertEq(token.totalDeliveryReleased(), 17);
        assertEq(address(token).balance, 0);
        for (uint256 i; i < token.mintRecipientCount(); ++i) {
            assertEq(token.mintReleased(token.mintRecipients(i)), 0.00245 ether / 4);
        }
    }

    function testUnknownRecipientAndEmptyRelease() public {
        assertEq(token.releasableMint(BUYER), 0);
        vm.expectRevert(NFT111K.InvalidMintRecipient.selector);
        token.releaseMint(BUYER);
        token.releaseMint(token.mintRecipients(0));
        token.releaseDelivery();
        assertEq(token.totalMintReleased(), 0);
        assertEq(token.totalDeliveryReleased(), 0);
    }

    function testRoundingRemainsMonotonicAndIndependentOfReleaseOrder() public {
        (address[] memory recipients, uint256[] memory shares) = _split(3);
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
        for (uint256 i; i < 17; ++i) {
            _buyAt(1);
            token.releaseMint(recipients[2]);
            token.releaseMint(recipients[0]);
            token.releaseMint(recipients[1]);
            for (uint256 j; j < 3; ++j) {
                assertEq(token.mintReleased(recipients[j]), ((i + 1) * shares[j]) / 10_000);
            }
            assertTrue(address(token).balance < 3);
        }
    }

    function testFuzzCumulativeSplit(uint96 firstAmount, uint96 secondAmount, uint16 shareSeed) public {
        (address[] memory recipients, uint256[] memory shares) = _split(2);
        shares[0] = uint256(shareSeed) % 9999 + 1;
        shares[1] = 10_000 - shares[0];
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
        uint256 received = uint256(firstAmount) + uint256(secondAmount);
        vm.deal(BUYER, received);
        _buyAt(firstAmount);
        _releaseAll();
        _buyAt(secondAmount);
        token.releaseMint(recipients[1]);
        token.releaseMint(recipients[0]);
        for (uint256 i; i < 2; ++i) {
            assertEq(token.mintReleased(recipients[i]), (received * shares[i]) / 10_000);
            assertEq(token.releasableMint(recipients[i]), 0);
        }
        assertEq(token.totalMintReceived(), received);
        assertEq(token.totalMintReleased() + address(token).balance, received);
        assertTrue(address(token).balance < 2);
    }

    function testUint256ScaleEntitlementDoesNotOverflow() public {
        (address[] memory recipients, uint256[] memory shares) = _split(2);
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
        uint256 amount = type(uint256).max;
        vm.deal(BUYER, amount);
        _buyAt(amount);
        assertEq(token.releasableMint(recipients[0]), amount / 2);
        assertEq(token.releasableMint(recipients[1]), amount / 2);
        _releaseAll();
        assertEq(token.totalMintReleased(), amount - 1);
        assertEq(address(token).balance, 1);
    }

    function testDeliveryRotationMovesOnlyOutstandingDeliveryFees() public {
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 31);
        vm.prank(BUYER);
        vm.expectRevert();
        token.setDeliveryPaymentReceiver(NEXT_DELIVERY);
        token.setDeliveryPaymentReceiver(NEXT_DELIVERY);
        token.releaseDelivery();
        assertEq(DELIVERY.balance, 0);
        assertEq(NEXT_DELIVERY.balance, 31);
        assertEq(token.totalMintReleased(), 0);
        assertEq(address(token).balance, 100);
        _buyAt(100);
        _deliver(BUYER, 111113, 2, 19);
        token.setDeliveryPaymentReceiver(DELIVERY);
        token.releaseDelivery();
        assertEq(DELIVERY.balance, 19);
        assertEq(NEXT_DELIVERY.balance, 31);
        assertEq(token.totalDeliveryReceived(), 50);
        assertEq(token.totalDeliveryReleased(), 50);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        token.setDeliveryPaymentReceiver(payable(address(0)));
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        token.setDeliveryPaymentReceiver(payable(address(token)));
        address payable mintRecipient = payable(token.mintRecipients(0));
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        token.setDeliveryPaymentReceiver(mintRecipient);
        assertEq(token.deliveryPaymentReceiver(), DELIVERY);
    }

    function testRejectingMintRecipientDoesNotBlockOthersOrPurchases() public {
        ProceedsReceiver receiver = new ProceedsReceiver();
        (address[] memory recipients, uint256[] memory shares) = _split(2);
        recipients[0] = address(receiver);
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
        receiver.configure(token, true, false, payable(address(0)));
        token.releaseMint(address(receiver));
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 11);
        vm.expectRevert(NFT111K.ProceedsPaymentFailed.selector);
        token.releaseMint(address(receiver));
        assertEq(token.mintReleased(address(receiver)), 0);
        assertEq(token.totalMintReleased(), 0);
        assertEq(token.releasableMint(address(receiver)), 50);
        token.releaseMint(recipients[1]);
        token.releaseDelivery();
        _buyAt(100);
        receiver.configure(token, false, false, payable(address(0)));
        token.releaseMint(address(receiver));
        assertEq(address(receiver).balance, 100);
        assertEq(token.mintReleased(address(receiver)), 100);
        assertEq(DELIVERY.balance, 11);
    }

    function testRejectingDeliveryReceiverDoesNotBlockMintAndCanBeRotated() public {
        ProceedsReceiver receiver = new ProceedsReceiver();
        receiver.configure(token, true, false, payable(address(0)));
        token.setDeliveryPaymentReceiver(payable(address(receiver)));
        token.releaseDelivery();
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 13);
        vm.expectRevert(NFT111K.ProceedsPaymentFailed.selector);
        token.releaseDelivery();
        assertEq(token.totalDeliveryReleased(), 0);
        assertEq(token.releasableDelivery(), 13);
        _releaseAll();
        token.setDeliveryPaymentReceiver(NEXT_DELIVERY);
        token.releaseDelivery();
        assertEq(NEXT_DELIVERY.balance, 13);
        assertEq(address(token).balance, 0);
    }

    function testEthCallbacksCannotReenterAndSeeReleasedAccounting() public {
        ProceedsReceiver mintReceiver = new ProceedsReceiver();
        ProceedsReceiver deliveryReceiver = new ProceedsReceiver();
        (address[] memory recipients, uint256[] memory shares) = _split(2);
        recipients[0] = address(mintReceiver);
        token = _deploy(recipients, shares, payable(address(deliveryReceiver)));
        token.setSaleActive(true);
        mintReceiver.configure(token, false, true, payable(address(0)));
        deliveryReceiver.configure(token, false, true, payable(address(0)));
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 17);
        token.releaseMint(address(mintReceiver));
        token.releaseDelivery();
        assertEq(mintReceiver.callbacks(), 1);
        assertEq(deliveryReceiver.callbacks(), 1);
        assertEq(mintReceiver.blockedCalls(), 5);
        assertEq(deliveryReceiver.blockedCalls(), 5);
        assertEq(token.totalMintReceived(), 100);
        assertEq(token.totalMintReleased(), 50);
        assertEq(token.totalDeliveryReleased(), 17);
    }

    function testDeliveryReleaseEventUsesPaidReceiverDuringCallbackRotation() public {
        ProceedsReceiver receiver = new ProceedsReceiver();
        receiver.configure(token, false, false, NEXT_DELIVERY);
        token.setDeliveryPaymentReceiver(payable(address(receiver)));
        token.transferOwnership(address(receiver));
        receiver.acceptOwnership();
        vm.prank(BUYER);
        token.mintCrates{value: 0.0001 ether}(1);
        _deliver(BUYER, 111112, 1, 29);
        vm.recordLogs();
        token.releaseDelivery();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[1].emitter, address(token));
        assertEq(logs[1].topics[0], keccak256("DeliveryProceedsReleased(address,uint256)"));
        assertEq(logs[1].topics[1], bytes32(uint256(uint160(address(receiver)))));
        assertEq(abi.decode(logs[1].data, (uint256)), 29);
        assertEq(address(receiver).balance, 29);
        assertEq(NEXT_DELIVERY.balance, 0);
        assertEq(token.deliveryPaymentReceiver(), NEXT_DELIVERY);
        assertEq(token.totalDeliveryReleased(), 29);
    }

    function testPausesDoNotPreventEitherRelease() public {
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 7);
        token.setSaleActive(false);
        token.setRedemptionsPaused(true);
        _releaseAll();
        token.releaseDelivery();
        assertEq(token.totalMintReleased(), 100);
        assertEq(token.totalDeliveryReleased(), 7);
        assertEq(address(token).balance, 0);
    }

    function testForcedEthIsNotAllocatedAndDirectEthIsRejected() public {
        (bool paid,) = address(token).call{value: 7}("");
        assertFalse(paid);
        new ForcedProceeds{value: 101}(payable(address(token)));
        assertEq(token.totalMintReceived(), 0);
        assertEq(token.totalDeliveryReceived(), 0);
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 7);
        _releaseAll();
        token.releaseDelivery();
        assertEq(address(token).balance, 101);
        assertEq(token.totalMintReleased(), 100);
        assertEq(token.totalDeliveryReleased(), 7);
        assertEq(token.releasableDelivery(), 0);
        assertEq(token.releasableMint(token.mintRecipients(0)), 0);
    }

    function testApprovalAndTransfersRejectEthWithoutChangingState() public {
        _buyAt(100);
        vm.prank(BUYER);
        token.approve(DELIVERY, 111112);
        token.releaseMint(token.mintRecipients(0));
        uint256 buyerBalance = BUYER.balance;
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeCall(token.approve, (NEXT_DELIVERY, 111112));
        calls[1] = abi.encodeCall(token.transferFrom, (BUYER, NEXT_DELIVERY, 111112));
        calls[2] = abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", BUYER, NEXT_DELIVERY, 111112);
        calls[3] = abi.encodeWithSignature(
            "safeTransferFrom(address,address,uint256,bytes)", BUYER, NEXT_DELIVERY, 111112, bytes("payload")
        );
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(BUYER);
            (bool success, bytes memory reason) = address(token).call{value: 7}(calls[i]);
            assertFalse(success);
            assertEq(keccak256(reason), keccak256(abi.encodeWithSelector(NFT111K.WrongPayment.selector)));
            assertEq(token.ownerOf(111112), BUYER);
            assertEq(token.getApproved(111112), DELIVERY);
            assertEq(token.balanceOf(BUYER), 1);
            assertEq(token.balanceOf(NEXT_DELIVERY), 0);
            assertEq(BUYER.balance, buyerBalance);
            assertEq(address(token).balance, 75);
            assertEq(token.totalMintReceived(), 100);
            assertEq(token.totalMintReleased(), 25);
            assertEq(token.totalDeliveryReceived(), 0);
            assertEq(token.totalDeliveryReleased(), 0);
        }
    }

    function testApprovalAndTransfersWithoutEthStillSucceed() public {
        _buyAt(100);
        vm.prank(BUYER);
        token.approve(DELIVERY, 111112);
        assertEq(token.getApproved(111112), DELIVERY);
        vm.prank(DELIVERY);
        token.transferFrom(BUYER, DELIVERY, 111112);
        assertEq(token.ownerOf(111112), DELIVERY);
        assertEq(token.getApproved(111112), address(0));
        vm.prank(DELIVERY);
        token.safeTransferFrom(DELIVERY, NEXT_DELIVERY, 111112);
        assertEq(token.ownerOf(111112), NEXT_DELIVERY);
        vm.prank(NEXT_DELIVERY);
        token.safeTransferFrom(NEXT_DELIVERY, BUYER, 111112, bytes("payload"));
        assertEq(token.ownerOf(111112), BUYER);
        assertEq(address(token).balance, 100);
        assertEq(token.totalMintReceived(), 100);
        assertEq(token.totalDeliveryReceived(), 0);
    }

    function testPaidMintCallbackCanApproveAndTransferWithoutEth() public {
        ProceedsForwarder buyer = new ProceedsForwarder(token, NEXT_DELIVERY);
        vm.prank(BUYER);
        buyer.buy{value: 0.0001 ether}();
        assertEq(token.ownerOf(111112), NEXT_DELIVERY);
        assertEq(token.getApproved(111112), address(0));
        assertEq(address(token).balance, 0.0001 ether);
        assertEq(token.totalMintReceived(), 0.0001 ether);
    }

    function testNftCallbacksSeeAccrualAndRejectedCallbacksRollItBack() public {
        ProceedsBuyer buyer = new ProceedsBuyer(token);
        vm.deal(address(buyer), 1 ether);
        buyer.configure(0.0001 ether, 0, true);
        vm.expectRevert();
        buyer.execute(abi.encodeCall(token.mintCrates, (1)), 0.0001 ether);
        assertEq(token.totalMintReceived(), 0);
        assertEq(token.allocatedCrates(), 0);
        buyer.configure(0.0001 ether, 0, false);
        buyer.execute(abi.encodeCall(token.mintCrates, (1)), 0.0001 ether);
        buyer.configure(0.0012 ether, 0, true);
        vm.expectRevert();
        buyer.execute(abi.encodeCall(token.mintWarehouses, (1)), 0.0011 ether);
        assertEq(token.totalMintReceived(), 0.0001 ether);
        buyer.configure(0.0012 ether, 0, false);
        buyer.execute(abi.encodeCall(token.mintWarehouses, (1)), 0.0011 ether);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 111112;
        (NFT111K.DeliveryQuote memory quote, bytes memory signature) = _quote(address(buyer), ids, 1, 17);
        buyer.configure(0.0012 ether, 17, true);
        vm.expectRevert();
        buyer.execute(abi.encodeCall(token.redeemForDelivery, (ids, quote, signature)), 17);
        assertEq(token.totalDeliveryReceived(), 0);
        assertFalse(token.usedDeliveryOrders(1));
        assertEq(token.ownerOf(111112), address(buyer));
        buyer.configure(0.0012 ether, 17, false);
        buyer.execute(abi.encodeCall(token.redeemForDelivery, (ids, quote, signature)), 17);
        assertEq(token.totalDeliveryReceived(), 17);
        assertEq(token.totalMintReceived(), 0.0012 ether);
    }

    function _split(uint256 count) private pure returns (address[] memory recipients, uint256[] memory shares) {
        recipients = new address[](count);
        shares = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            recipients[i] = address(uint160(0xC00001 + i));
            shares[i] = i + 1 == count ? 10_000 - (10_000 / count) * i : 10_000 / count;
        }
    }

    function _deploy(address[] memory recipients, uint256[] memory shares, address payable delivery)
        private
        returns (NFT111K)
    {
        return new NFT111K(
            address(this),
            vm.addr(SIGNER_KEY),
            delivery,
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            recipients,
            shares
        );
    }

    function _nextCreateAddress() private view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
    }

    function _buyAt(uint256 amount) private {
        token.setPrices(amount, amount, amount, 0.0088 ether);
        vm.prank(BUYER);
        token.mintCrates{value: amount}(1);
    }

    function _releaseAll() private {
        for (uint256 i; i < token.mintRecipientCount(); ++i) {
            address recipient = token.mintRecipients(i);
            vm.prank(address(0xCA11));
            token.releaseMint(recipient);
        }
    }

    function _deliver(address wallet, uint256 tokenId, uint256 orderId, uint256 fee) private {
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        (NFT111K.DeliveryQuote memory quote, bytes memory signature) = _quote(wallet, ids, orderId, fee);
        vm.prank(wallet);
        token.redeemForDelivery{value: fee}(ids, quote, signature);
    }

    function _quote(address wallet, uint256[] memory ids, uint256 orderId, uint256 fee)
        private
        returns (NFT111K.DeliveryQuote memory quote, bytes memory signature)
    {
        uint256[] memory receipts = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint256 displayId,) = token.getTokenInfo(ids[i]);
            receipts[i] = (kind == 1 ? 1_000_000 : 2_000_000) + displayId;
        }
        quote = NFT111K.DeliveryQuote(orderId, wallet, fee, block.timestamp + 300, keccak256(abi.encode(receipts)));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("111K"),
                keccak256("2"),
                block.chainid,
                address(token)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)"
                ),
                wallet,
                keccak256(abi.encode(ids)),
                quote.receiptIdsHash,
                orderId,
                fee,
                quote.deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        signature = abi.encodePacked(r, s, v);
    }
}
