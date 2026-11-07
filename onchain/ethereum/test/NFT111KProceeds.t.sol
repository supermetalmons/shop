pragma solidity 0.8.38;

import {NFT111K} from "../src/NFT111K.sol";
import {DeliveryAccounting} from "./DeliveryAccounting.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract ProceedsReceiver {
    NFT111K public token;
    bool public rejecting;
    bool public attacking;
    uint256 public callbacks;
    uint256 public blockedCalls;

    function configure(NFT111K token_, bool rejecting_, bool attacking_) external {
        token = token_;
        rejecting = rejecting_;
        attacking = attacking_;
    }

    receive() external payable {
        require(msg.sender == address(token));
        if (rejecting) revert();
        callbacks++;
        require(token.releasableMint(address(this)) == 0);
        require(DeliveryAccounting.pending(token, address(this)) == 0);
        if (attacking) {
            _blocked(abi.encodeCall(token.releaseMint, (token.mintRecipients(0))));
            _blocked(abi.encodeCall(token.releaseAllMint, ()));
            _blocked(abi.encodeCall(token.releaseDelivery, ()));
            _blocked(abi.encodeCall(token.mintCrates, (1)));
            _blocked(abi.encodeCall(token.mintWarehouses, (1)));
            uint256[] memory ids = new uint256[](0);
            NFT111K.DeliveryQuote memory quote;
            _blocked(abi.encodeCall(token.redeemForDelivery, (ids, quote, bytes(""))));
        }
    }

    function _blocked(bytes memory data) private {
        (bool success, bytes memory reason) = address(token).call(data);
        require(!success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        blockedCalls++;
    }
}

contract ProceedsGasReceiver {
    bool public burning;
    uint256[8] public writes;

    function setBurning(bool value) external {
        burning = value;
    }

    receive() external payable {
        if (burning) {
            assembly {
                for {} 1 {} {}
            }
        }
        for (uint256 i; i < writes.length; ++i) {
            writes[i]++;
        }
    }
}

contract ProceedsReturnDataReceiver {
    bool private immutable rejecting;

    constructor(bool rejecting_) {
        rejecting = rejecting_;
    }

    receive() external payable {
        bool reject = rejecting;
        assembly {
            if reject { revert(0, 0x30000) }
            return(0, 0x30000)
        }
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
        require(DeliveryAccounting.received(token) == expectedDelivery);
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
    address private deliveryReceiver;
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
        for (uint256 count = 2; count <= 32; ++count) {
            (address[] memory recipients, uint256[] memory shares) = _split(count);
            NFT111K configured = _deploy(recipients, shares, DELIVERY);
            assertEq(configured.mintRecipientCount(), count);
            for (uint256 i; i < count; ++i) {
                assertEq(configured.mintRecipients(i), recipients[i]);
                assertEq(configured.mintSharesBps(recipients[i]), shares[i]);
            }
        }
    }

    function testInvalidRecipientCountsAndShares() public {
        for (uint256 count; count <= 33; ++count) {
            if (count >= 2 && count <= 32) continue;
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
    }

    function testConstructorRejectsInvalidInitialDeliveryReceiver() public {
        (address[] memory recipients, uint256[] memory shares) = _split(3);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(recipients, shares, payable(address(0)));
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(recipients, shares, payable(recipients[0]));
        address payable collection = payable(_nextCreateAddress());
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(recipients, shares, collection);
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
        assertEq(DeliveryAccounting.received(token), 17);
        assertEq(DeliveryAccounting.pending(token, deliveryReceiver), 17);
        vm.prank(address(0xCA11));
        DeliveryAccounting.release(token, deliveryReceiver);
        assertEq(DELIVERY.balance, 17);
        assertEq(address(token).balance, 0.00245 ether);
        _releaseAll();
        assertEq(token.totalMintReleased(), 0.00245 ether);
        assertEq(DeliveryAccounting.released(token), 17);
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
        DeliveryAccounting.release(token, deliveryReceiver);
        assertEq(token.totalMintReleased(), 0);
        assertEq(DeliveryAccounting.released(token), 0);
    }

    function testBatchReleaseIsPermissionlessAndSkipsEmptyAndAlreadyPaidRecipients() public {
        vm.recordLogs();
        vm.prank(address(0xCA11));
        token.releaseAllMint();
        assertEq(vm.getRecordedLogs().length, 0);
        _buyAt(100);
        vm.prank(address(0xCA11));
        token.releaseMint(token.mintRecipients(1));
        vm.recordLogs();
        vm.prank(address(0xCA11));
        token.releaseAllMint();
        assertEq(vm.getRecordedLogs().length, 3);
        for (uint256 i; i < 4; ++i) {
            address recipient = token.mintRecipients(i);
            assertEq(recipient.balance, 25);
            assertEq(token.mintReleased(recipient), 25);
            assertEq(token.releasableMint(recipient), 0);
        }
        assertEq(token.totalMintReleased(), 100);
        vm.recordLogs();
        token.releaseAllMint();
        token.releaseMint(token.mintRecipients(0));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(token.totalMintReleased(), 100);
        assertEq(address(token).balance, 0);
    }

    function testBatchReleasePreservesCumulativeRoundingFor32Recipients() public {
        (address[] memory recipients, uint256[] memory shares) = _split(32);
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
        uint256 received;
        for (uint256 round; round < 17; ++round) {
            uint256 amount = round * 37 + 1;
            received += amount;
            _buyAt(amount);
            token.releaseMint(recipients[round % recipients.length]);
            token.releaseAllMint();
            token.releaseMint(recipients[(round + 1) % recipients.length]);
            uint256 released;
            for (uint256 i; i < recipients.length; ++i) {
                uint256 entitlement = received * shares[i] / 10_000;
                assertEq(recipients[i].balance, entitlement);
                assertEq(token.mintReleased(recipients[i]), entitlement);
                assertEq(token.releasableMint(recipients[i]), 0);
                released += entitlement;
            }
            assertEq(token.totalMintReceived(), received);
            assertEq(token.totalMintReleased(), released);
            assertEq(address(token).balance, received - released);
            assertTrue(address(token).balance < recipients.length);
        }
    }

    function testConfiguredMintSplitPaysExactBasisPointAmounts() public {
        (address[] memory recipients, uint256[] memory shares) = _deployConfiguredSplit();
        _buyAt(10_000);
        vm.prank(address(0xCA11));
        token.releaseAllMint();
        for (uint256 i; i < recipients.length; ++i) {
            assertEq(recipients[i].balance, shares[i]);
            assertEq(token.mintReleased(recipients[i]), shares[i]);
            assertEq(token.releasableMint(recipients[i]), 0);
        }
        assertEq(token.totalMintReceived(), 10_000);
        assertEq(token.totalMintReleased(), 10_000);
        assertEq(address(token).balance, 0);
        vm.recordLogs();
        _releaseAll();
        token.releaseAllMint();
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(token.totalMintReleased(), 10_000);
    }

    function testConfiguredMintSplitPreservesCumulativeRoundingAcrossReleaseOrder() public {
        (address[] memory recipients, uint256[] memory shares) = _deployConfiguredSplit();
        uint256[8] memory payments = [uint256(1), 1, 15, 83, 1, 9899, 1, 9999];
        uint256 received;
        for (uint256 round; round < payments.length; ++round) {
            received += payments[round];
            _buyAt(payments[round]);
            for (uint256 i; i < recipients.length; ++i) {
                uint256 index = round % 2 == 0 ? i : recipients.length - 1 - i;
                vm.prank(address(0xCA11));
                token.releaseMint(recipients[index]);
            }
            vm.recordLogs();
            token.releaseAllMint();
            assertEq(vm.getRecordedLogs().length, 0);
            uint256 released;
            for (uint256 i; i < recipients.length; ++i) {
                uint256 entitlement = received * shares[i] / 10_000;
                assertEq(recipients[i].balance, entitlement);
                assertEq(token.mintReleased(recipients[i]), entitlement);
                assertEq(token.releasableMint(recipients[i]), 0);
                released += entitlement;
            }
            assertEq(token.totalMintReceived(), received);
            assertEq(token.totalMintReleased(), released);
            assertEq(address(token).balance, received - released);
            assertTrue(address(token).balance <= 13);
        }
        assertEq(token.totalMintReleased(), 20_000);
        assertEq(address(token).balance, 0);
    }

    function testUnderfundedBatchRevertsAllAccountingAndCanBeRetried() public {
        _buyAt(100);
        vm.expectRevert(NFT111K.InsufficientMintPayoutGas.selector);
        token.releaseAllMint{gas: 250_000}();
        for (uint256 i; i < token.mintRecipientCount(); ++i) {
            address recipient = token.mintRecipients(i);
            assertEq(recipient.balance, 0);
            assertEq(token.mintReleased(recipient), 0);
            assertEq(token.releasableMint(recipient), 25);
        }
        assertEq(token.totalMintReleased(), 0);
        assertEq(address(token).balance, 100);
        token.releaseAllMint{gas: 1_000_000}();
        assertEq(token.totalMintReleased(), 100);
        assertEq(address(token).balance, 0);
    }

    function testBatchIgnoresLargeReturnAndRevertData() public {
        for (uint256 mode; mode < 2; ++mode) {
            bool rejecting = mode == 1;
            (address[] memory recipients, uint256[] memory shares) = _split(32);
            for (uint256 i; i < 31; ++i) {
                recipients[i] = address(new ProceedsReturnDataReceiver(rejecting));
            }
            vm.deal(recipients[31], 0);
            token = _deploy(recipients, shares, DELIVERY);
            token.setSaleActive(true);
            _buyAt(10_000);
            vm.recordLogs();
            token.releaseAllMint{gas: 6_000_000}();
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(logs.length, 32);
            uint256 released;
            for (uint256 i; i < recipients.length; ++i) {
                uint256 paid = rejecting && i < 31 ? 0 : shares[i];
                assertEq(recipients[i].balance, paid);
                assertEq(token.mintReleased(recipients[i]), paid);
                assertEq(token.releasableMint(recipients[i]), shares[i] - paid);
                assertEq(
                    logs[i].topics[0],
                    paid == 0
                        ? keccak256("MintProceedsReleaseFailed(address,uint256)")
                        : keccak256("MintProceedsReleased(address,uint256)")
                );
                released += paid;
            }
            assertEq(recipients[31].balance, shares[31]);
            assertEq(token.totalMintReleased(), released);
            assertEq(address(token).balance, 10_000 - released);
        }
    }

    function testBatchReleaseContinuesPastRevertingRecipientsAtEveryPosition() public {
        for (uint256 index; index < 5; index += 2) {
            _assertBatchFailure(index, 0);
        }
    }

    function testBatchReleaseContinuesPastGasBurningRecipientsAtEveryPosition() public {
        for (uint256 index; index < 5; index += 2) {
            _assertBatchFailure(index, 1);
        }
    }

    function testExpensiveRecipientsCanUseIndividualReleaseAfterBatchFailure() public {
        for (uint256 index; index < 5; index += 2) {
            _assertBatchFailure(index, 2);
        }
    }

    function testBatchReleaseReachesLastRecipientAfter31GasBurningRecipients() public {
        (address[] memory recipients, uint256[] memory shares) = _split(32);
        for (uint256 i; i < 31; ++i) {
            ProceedsGasReceiver receiver = new ProceedsGasReceiver();
            receiver.setBurning(true);
            recipients[i] = address(receiver);
        }
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
        _buyAt(10_000);
        vm.recordLogs();
        vm.prank(address(0xCA11));
        token.releaseAllMint{gas: 6_000_000}();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 32);
        for (uint256 i; i < 31; ++i) {
            assertEq(logs[i].topics[0], keccak256("MintProceedsReleaseFailed(address,uint256)"));
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(recipients[i]))));
            assertEq(abi.decode(logs[i].data, (uint256)), shares[i]);
            assertEq(token.mintReleased(recipients[i]), 0);
            assertEq(token.releasableMint(recipients[i]), shares[i]);
            assertEq(recipients[i].balance, 0);
        }
        assertEq(logs[31].topics[0], keccak256("MintProceedsReleased(address,uint256)"));
        assertEq(recipients[31].balance, shares[31]);
        assertEq(token.totalMintReleased(), shares[31]);
        assertEq(address(token).balance, 10_000 - shares[31]);
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

    function testDifferentQuotesKeepOutstandingDeliveryCreditsWithTheirReceivers() public {
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 31);
        deliveryReceiver = NEXT_DELIVERY;
        _buyAt(100);
        _deliver(BUYER, 111113, 2, 19);
        assertEq(DeliveryAccounting.pending(token, DELIVERY), 31);
        assertEq(DeliveryAccounting.pending(token, NEXT_DELIVERY), 19);
        vm.prank(BUYER);
        DeliveryAccounting.release(token, DELIVERY);
        assertEq(DELIVERY.balance, 31);
        assertEq(NEXT_DELIVERY.balance, 0);
        DeliveryAccounting.release(token, NEXT_DELIVERY);
        assertEq(NEXT_DELIVERY.balance, 19);
        assertEq(DeliveryAccounting.received(token), 50);
        assertEq(DeliveryAccounting.released(token), 50);
        assertEq(token.totalMintReleased(), 0);
        assertEq(address(token).balance, 200);
    }

    function testRejectingMintRecipientDoesNotBlockOthersOrPurchases() public {
        ProceedsReceiver receiver = new ProceedsReceiver();
        (address[] memory recipients, uint256[] memory shares) = _split(2);
        recipients[0] = address(receiver);
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
        receiver.configure(token, true, false);
        token.releaseMint(address(receiver));
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 11);
        vm.expectRevert(NFT111K.ProceedsPaymentFailed.selector);
        token.releaseMint(address(receiver));
        assertEq(token.mintReleased(address(receiver)), 0);
        assertEq(token.totalMintReleased(), 0);
        assertEq(token.releasableMint(address(receiver)), 50);
        token.releaseMint(recipients[1]);
        DeliveryAccounting.release(token, deliveryReceiver);
        _buyAt(100);
        receiver.configure(token, false, false);
        token.releaseMint(address(receiver));
        assertEq(address(receiver).balance, 100);
        assertEq(token.mintReleased(address(receiver)), 100);
        assertEq(DELIVERY.balance, 11);
    }

    function testRejectingDeliveryReceiverKeepsCreditsAndCannotBlockOtherReceivers() public {
        ProceedsReceiver receiver = new ProceedsReceiver();
        receiver.configure(token, true, false);
        deliveryReceiver = address(receiver);
        DeliveryAccounting.release(token, deliveryReceiver);
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 13);
        vm.expectRevert(NFT111K.ProceedsPaymentFailed.selector);
        token.releaseDeliveryFor(2, false);
        assertEq(DeliveryAccounting.released(token), 0);
        assertEq(DeliveryAccounting.pending(token, address(receiver)), 13);
        deliveryReceiver = NEXT_DELIVERY;
        _buyAt(100);
        _deliver(BUYER, 111113, 2, 19);
        DeliveryAccounting.release(token, NEXT_DELIVERY);
        assertEq(NEXT_DELIVERY.balance, 19);
        assertEq(DeliveryAccounting.pending(token, address(receiver)), 13);
        _releaseAll();
        receiver.configure(token, false, false);
        DeliveryAccounting.release(token, address(receiver));
        assertEq(address(receiver).balance, 13);
        assertEq(DeliveryAccounting.released(token), 32);
        assertEq(address(token).balance, 0);
    }

    function testEthCallbacksCannotReenterAndSeeReleasedAccounting() public {
        ProceedsReceiver mintReceiver = new ProceedsReceiver();
        ProceedsReceiver deliveryContract = new ProceedsReceiver();
        (address[] memory recipients, uint256[] memory shares) = _split(2);
        recipients[0] = address(mintReceiver);
        token = _deploy(recipients, shares, payable(address(deliveryContract)));
        token.setSaleActive(true);
        mintReceiver.configure(token, false, true);
        deliveryContract.configure(token, false, true);
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 17);
        token.releaseMint(address(mintReceiver));
        DeliveryAccounting.release(token, deliveryReceiver);
        assertEq(mintReceiver.callbacks(), 1);
        assertEq(deliveryContract.callbacks(), 1);
        assertEq(mintReceiver.blockedCalls(), 6);
        assertEq(deliveryContract.blockedCalls(), 6);
        assertEq(token.totalMintReceived(), 100);
        assertEq(token.totalMintReleased(), 50);
        assertEq(DeliveryAccounting.released(token), 17);
    }

    function testBatchCallbacksCannotReenterAndSeeReleasedAccounting() public {
        ProceedsReceiver receiver = new ProceedsReceiver();
        (address[] memory recipients, uint256[] memory shares) = _split(3);
        recipients[1] = address(receiver);
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
        receiver.configure(token, false, true);
        _buyAt(10_000);
        token.releaseAllMint();
        assertEq(receiver.callbacks(), 1);
        assertEq(receiver.blockedCalls(), 6);
        assertEq(address(receiver).balance, shares[1]);
        assertEq(token.mintReleased(address(receiver)), shares[1]);
        assertEq(token.totalMintReleased(), 10_000);
        assertEq(address(token).balance, 0);
    }

    function testDeliveryReleaseEventUsesTheCreditedReceiver() public {
        ProceedsReceiver receiver = new ProceedsReceiver();
        receiver.configure(token, false, false);
        deliveryReceiver = address(receiver);
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 29);
        vm.recordLogs();
        vm.prank(BUYER);
        DeliveryAccounting.release(token, address(receiver));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(token));
        assertEq(logs[0].topics[0], keccak256("DeliveryProceedsReleased(uint256,address,uint256)"));
        assertEq(logs[0].topics[1], bytes32(uint256(2)));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(address(receiver)))));
        assertEq(abi.decode(logs[0].data, (uint256)), 29);
        assertEq(address(receiver).balance, 29);
        assertEq(NEXT_DELIVERY.balance, 0);
        assertEq(DeliveryAccounting.pending(token, address(receiver)), 0);
        assertEq(DeliveryAccounting.released(token), 29);
    }

    function testPausesDoNotPreventEitherRelease() public {
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 7);
        token.setSaleActive(false);
        token.setRedemptionsPaused(true);
        token.releaseMint(token.mintRecipients(0));
        token.releaseAllMint();
        DeliveryAccounting.release(token, deliveryReceiver);
        assertEq(token.totalMintReleased(), 100);
        assertEq(DeliveryAccounting.released(token), 7);
        assertEq(address(token).balance, 0);
    }

    function testForcedEthIsNotAllocatedAndDirectEthIsRejected() public {
        (bool paid,) = address(token).call{value: 7}("");
        assertFalse(paid);
        new ForcedProceeds{value: 101}(payable(address(token)));
        assertEq(token.totalMintReceived(), 0);
        assertEq(DeliveryAccounting.received(token), 0);
        _buyAt(100);
        _deliver(BUYER, 111112, 1, 7);
        token.releaseAllMint();
        assertEq(DeliveryAccounting.released(token), 0);
        assertEq(DeliveryAccounting.pending(token, deliveryReceiver), 7);
        assertEq(address(token).balance, 108);
        DeliveryAccounting.release(token, deliveryReceiver);
        assertEq(address(token).balance, 101);
        assertEq(token.totalMintReleased(), 100);
        assertEq(DeliveryAccounting.released(token), 7);
        assertEq(DeliveryAccounting.pending(token, deliveryReceiver), 0);
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
            assertEq(DeliveryAccounting.received(token), 0);
            assertEq(DeliveryAccounting.released(token), 0);
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
        assertEq(DeliveryAccounting.received(token), 0);
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
        (NFT111K.DeliveryQuote memory quote,) = _quote(address(buyer), ids, 1, 17);
        quote.configId = token.registerDeliveryConfig(DELIVERY, NEXT_DELIVERY, 3000);
        bytes memory signature = _deliverySignature(ids, quote);
        buyer.configure(0.0012 ether, 17, true);
        vm.expectRevert();
        buyer.execute(abi.encodeCall(token.redeemForDelivery, (ids, quote, signature)), 17);
        assertEq(DeliveryAccounting.received(token), 0);
        assertEq(DeliveryAccounting.pending(token, DELIVERY), 0);
        assertEq(DeliveryAccounting.pending(token, NEXT_DELIVERY), 0);
        assertFalse(token.usedDeliveryOrders(1));
        assertEq(token.ownerOf(111112), address(buyer));
        buyer.configure(0.0012 ether, 17, false);
        buyer.execute(abi.encodeCall(token.redeemForDelivery, (ids, quote, signature)), 17);
        assertEq(DeliveryAccounting.received(token), 17);
        assertEq(DeliveryAccounting.pending(token, DELIVERY), 12);
        assertEq(DeliveryAccounting.pending(token, NEXT_DELIVERY), 5);
        assertEq(token.totalMintReceived(), 0.0012 ether);
    }

    function _assertBatchFailure(uint256 index, uint256 mode) private {
        (address[] memory recipients, uint256[] memory shares) = _split(5);
        ProceedsReceiver rejecting;
        ProceedsGasReceiver expensive;
        if (mode == 0) {
            rejecting = new ProceedsReceiver();
            recipients[index] = address(rejecting);
        } else {
            expensive = new ProceedsGasReceiver();
            expensive.setBurning(mode == 1);
            recipients[index] = address(expensive);
        }
        for (uint256 i; i < recipients.length; ++i) {
            vm.deal(recipients[i], 0);
        }
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
        if (mode == 0) rejecting.configure(token, true, false);
        _buyAt(10_000);
        vm.recordLogs();
        vm.prank(address(0xCA11));
        token.releaseAllMint();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, recipients.length);
        for (uint256 i; i < recipients.length; ++i) {
            uint256 paid = i == index ? 0 : shares[i];
            assertEq(recipients[i].balance, paid);
            assertEq(token.mintReleased(recipients[i]), paid);
            assertEq(token.releasableMint(recipients[i]), shares[i] - paid);
            assertEq(logs[i].emitter, address(token));
            assertEq(
                logs[i].topics[0],
                keccak256(
                    bytes(
                        i == index
                            ? "MintProceedsReleaseFailed(address,uint256)"
                            : "MintProceedsReleased(address,uint256)"
                    )
                )
            );
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(recipients[i]))));
            assertEq(abi.decode(logs[i].data, (uint256)), shares[i]);
        }
        assertEq(token.totalMintReleased(), 10_000 - shares[index]);
        assertEq(address(token).balance, shares[index]);
        vm.recordLogs();
        token.releaseAllMint();
        assertEq(vm.getRecordedLogs().length, 1);
        assertEq(token.totalMintReleased(), 10_000 - shares[index]);
        if (mode == 0) {
            vm.expectRevert(NFT111K.ProceedsPaymentFailed.selector);
            token.releaseMint(recipients[index]);
            rejecting.configure(token, false, false);
        } else {
            expensive.setBurning(false);
            for (uint256 i; i < 8; ++i) {
                assertEq(expensive.writes(i), 0);
            }
        }
        token.releaseMint(recipients[index]);
        assertEq(recipients[index].balance, shares[index]);
        assertEq(token.mintReleased(recipients[index]), shares[index]);
        assertEq(token.releasableMint(recipients[index]), 0);
        assertEq(token.totalMintReleased(), 10_000);
        assertEq(address(token).balance, 0);
    }

    function _split(uint256 count) private pure returns (address[] memory recipients, uint256[] memory shares) {
        recipients = new address[](count);
        shares = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            recipients[i] = address(uint160(0xC00001 + i));
            shares[i] = i + 1 == count ? 10_000 - (10_000 / count) * i : 10_000 / count;
        }
    }

    function _deployConfiguredSplit() private returns (address[] memory recipients, uint256[] memory shares) {
        string memory proceeds = vm.readFile("config/proceeds.json");
        recipients = vm.parseJsonAddressArray(proceeds, ".mintRecipients");
        shares = vm.parseJsonUintArray(proceeds, ".mintSharesBps");
        assertEq(recipients.length, 14);
        for (uint256 i; i < recipients.length; ++i) {
            vm.deal(recipients[i], 0);
        }
        token = _deploy(recipients, shares, DELIVERY);
        token.setSaleActive(true);
    }

    function _deploy(address[] memory recipients, uint256[] memory shares, address payable delivery)
        private
        returns (NFT111K)
    {
        deliveryReceiver = delivery;
        return new NFT111K(
            address(this),
            vm.addr(SIGNER_KEY),
            delivery,
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            recipients,
            shares,
            new NFT111K.FreeMintAllocation[](0),
            5555
        );
    }

    function _nextCreateAddress() private view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
    }

    function _buyAt(uint256 amount) private {
        token.setPrices(amount, amount, amount);
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
        quote = NFT111K.DeliveryQuote(
            orderId,
            wallet,
            fee,
            block.timestamp + 300,
            keccak256(abi.encode(receipts)),
            DeliveryAccounting.ensureSingle(token, deliveryReceiver)
        );
        signature = _deliverySignature(ids, quote);
    }

    function _deliverySignature(uint256[] memory ids, NFT111K.DeliveryQuote memory quote)
        private
        returns (bytes memory signature)
    {
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
                    "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline,uint256 configId)"
                ),
                quote.wallet,
                keccak256(abi.encode(ids)),
                quote.receiptIdsHash,
                quote.orderId,
                quote.fee,
                quote.deadline,
                quote.configId
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        signature = abi.encodePacked(r, s, v);
    }
}
