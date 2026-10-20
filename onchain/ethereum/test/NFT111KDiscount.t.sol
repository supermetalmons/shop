pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {NFT111KRenderer} from "../src/NFT111KRenderer.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract DiscountReceiver {
    NFT111K private immutable token;
    uint256 public callbacks;
    uint256 public rejectAt;
    uint256 public observedUsed;
    uint256 public observedAllocated;
    bool public reentryBlocked;

    constructor(NFT111K token_) {
        token = token_;
    }

    function purchase(uint256 quantity, uint256 rejectAt_) external payable {
        rejectAt = rejectAt_;
        token.mintCratesDiscounted{value: msg.value}(quantity, new bytes32[](0));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(token));
        ++callbacks;
        observedUsed = token.discountUsed(address(this));
        observedAllocated = token.allocatedCrates();
        if (rejectAt == callbacks) revert("rejected");
        (bool success, bytes memory result) = address(token).call{value: token.discountCratePrice()}(
            abi.encodeCall(token.mintCratesDiscounted, (1, new bytes32[](0)))
        );
        reentryBlocked = !success && bytes4(result) == bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        require(reentryBlocked);
        return this.onERC721Received.selector;
    }
}

contract NFT111KDiscountTest is TestSupport {
    NFT111K private token;
    address private constant ALICE = address(0xA110);
    address private constant BOB = address(0xB0B);
    address private constant STRANGER = address(0xBAD);
    uint256 private constant PRICE = 0.00005 ether;
    bytes32 private root;

    function setUp() public {
        root = _pair(_leaf(ALICE), _leaf(BOB));
        token =
            new NFT111K(address(this), address(0x5151), payable(address(0xFEE)), address(new NFT111KRenderer()), root);
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
        vm.deal(STRANGER, 100 ether);
        vm.deal(address(this), 100 ether);
    }

    function testDefaultDiscountAndPurchaseEvent() public {
        assertEq(token.discountMerkleRoot(), root);
        assertEq(token.discountAllowance(), 1);
        assertEq(token.discountCratePrice(), PRICE);
        vm.recordLogs();
        _buy(ALICE, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory purchase = logs[logs.length - 1];
        assertEq(purchase.topics[0], keccak256("CratesPurchased(address,uint256,uint256,uint256)"));
        assertEq(address(uint160(uint256(purchase.topics[1]))), ALICE);
        (uint256 first, uint256 quantity, uint256 paid) = abi.decode(purchase.data, (uint256, uint256, uint256));
        assertEq(first, 111112);
        assertEq(quantity, 1);
        assertEq(paid, PRICE);
        assertEq(token.discountUsed(ALICE), 1);
        assertEq(token.discountUsed(BOB), 0);
        assertEq(token.ownerOf(first), ALICE);
        assertEq(address(token).balance, PRICE);
    }

    function testIndependentWalletAllowancesAndRepeatedTransactions() public {
        _buy(ALICE, 1);
        _buy(BOB, 1);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.DiscountAllowanceExceeded.selector);
        token.mintCratesDiscounted{value: PRICE}(1, _proof(ALICE));
        assertEq(token.allocatedCrates(), 2);
        assertEq(token.discountUsed(ALICE), 1);
        assertEq(token.discountUsed(BOB), 1);
        token.setDiscountConfig(root, 3);
        _buy(ALICE, 2);
        assertEq(token.discountUsed(ALICE), 3);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.DiscountAllowanceExceeded.selector);
        token.mintCratesDiscounted{value: PRICE}(1, _proof(ALICE));
        assertEq(token.allocatedCrates(), 4);
    }

    function testWrongWalletAndTamperedProofFail() public {
        vm.prank(STRANGER);
        vm.expectRevert(NFT111K.InvalidDiscountProof.selector);
        token.mintCratesDiscounted{value: PRICE}(1, _proof(ALICE));
        bytes32[] memory proof = _proof(ALICE);
        proof[0] = bytes32(uint256(1));
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.InvalidDiscountProof.selector);
        token.mintCratesDiscounted{value: PRICE}(1, proof);
        assertEq(token.discountUsed(ALICE), 0);
        assertEq(token.discountUsed(STRANGER), 0);
        assertEq(token.allocatedCrates(), 0);
    }

    function testRootReplacementDisableAndAllowanceChangesPreserveUsage() public {
        _buy(ALICE, 1);
        token.setDiscountConfig(_leaf(BOB), 3);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.InvalidDiscountProof.selector);
        token.mintCratesDiscounted{value: PRICE}(1, _proof(ALICE));
        token.setDiscountConfig(bytes32(0), 3);
        vm.prank(BOB);
        vm.expectRevert(NFT111K.DiscountInactive.selector);
        token.mintCratesDiscounted{value: PRICE}(1, new bytes32[](0));
        token.setDiscountConfig(root, 3);
        _buy(ALICE, 2);
        token.setDiscountConfig(root, 1);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.DiscountAllowanceExceeded.selector);
        token.mintCratesDiscounted{value: PRICE}(1, _proof(ALICE));
        assertEq(token.discountUsed(ALICE), 3);
    }

    function testOwnerConfigurationValidationAndIndependentFixedPrice() public {
        vm.prank(ALICE);
        vm.expectRevert();
        token.setDiscountConfig(root, 3);
        vm.prank(ALICE);
        vm.expectRevert();
        token.setPrices(1 ether, 11 ether, 0.5 ether);
        vm.expectRevert(NFT111K.InvalidDiscountConfig.selector);
        token.setDiscountConfig(root, 0);
        vm.expectRevert(NFT111K.InvalidDiscountConfig.selector);
        token.setDiscountConfig(root, 11);
        vm.expectRevert(NFT111K.InvalidDiscountConfig.selector);
        token.setPrices(1, 11, 2);
        token.setPrices(0.0002 ether, 0.0022 ether, PRICE);
        assertEq(token.discountCratePrice(), PRICE);
        _buy(ALICE, 1);
        token.setPrices(0.0002 ether, 0.0022 ether, 0);
        vm.prank(BOB);
        token.mintCratesDiscounted(1, _proof(BOB));
        assertEq(token.discountUsed(BOB), 1);
    }

    function testValidationFailuresDoNotConsumeAllowance() public {
        bytes32[] memory proof = _proof(ALICE);
        vm.startPrank(ALICE);
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.mintCratesDiscounted(0, proof);
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.mintCratesDiscounted{value: PRICE * 16}(16, proof);
        vm.expectRevert(NFT111K.WrongPayment.selector);
        token.mintCratesDiscounted{value: PRICE - 1}(1, proof);
        vm.expectRevert(NFT111K.WrongPayment.selector);
        token.mintCratesDiscounted{value: PRICE + 1}(1, proof);
        vm.stopPrank();
        token.setSaleActive(false);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintCratesDiscounted{value: PRICE}(1, proof);
        assertEq(token.discountUsed(ALICE), 0);
        assertEq(token.allocatedCrates(), 0);
        assertEq(address(token).balance, 0);
    }

    function testPublicPurchasesTransfersAndUnboxingDoNotChangeAllowance() public {
        _buy(ALICE, 1);
        vm.startPrank(ALICE);
        token.mintCrates{value: 0.0001 ether}(1);
        token.mintWarehouses{value: 0.0011 ether}(1);
        token.transferFrom(ALICE, BOB, 111112);
        token.unboxCrate(111113);
        token.unboxWarehouse(116667);
        vm.stopPrank();
        assertEq(token.discountUsed(ALICE), 1);
        assertEq(token.discountUsed(BOB), 0);
        assertEq(token.allocatedCrates(), 13);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.DiscountAllowanceExceeded.selector);
        token.mintCratesDiscounted{value: PRICE}(1, _proof(ALICE));
        _buy(BOB, 1);
        assertEq(token.ownerOf(111125), BOB);
    }

    function testDiscountedAndPublicMintsShareSupply() public {
        _buy(ALICE, 1);
        vm.startPrank(BOB);
        for (uint256 i; i < 33; ++i) {
            token.mintWarehouses{value: 0.0165 ether}(15);
        }
        token.mintWarehouses{value: 0.0099 ether}(9);
        token.mintCrates{value: 0.001 ether}(10);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintCratesDiscounted{value: PRICE}(1, _proof(BOB));
        vm.stopPrank();
        assertEq(token.allocatedCrates(), 5555);
        assertEq(token.discountUsed(BOB), 0);
    }

    function testUsageAndSupplyAreReservedBeforeReceiverCallbacks() public {
        DiscountReceiver receiver = new DiscountReceiver(token);
        token.setDiscountConfig(_leaf(address(receiver)), 3);
        vm.deal(address(receiver), 1 ether);
        receiver.purchase{value: PRICE * 3}(3, 0);
        assertEq(receiver.callbacks(), 3);
        assertEq(receiver.observedUsed(), 3);
        assertEq(receiver.observedAllocated(), 3);
        assertTrue(receiver.reentryBlocked());
        assertEq(token.discountUsed(address(receiver)), 3);
    }

    function testRejectedReceiverRollsBackPaymentSupplyAndUsage() public {
        DiscountReceiver receiver = new DiscountReceiver(token);
        token.setDiscountConfig(_leaf(address(receiver)), 3);
        vm.deal(address(receiver), 1 ether);
        vm.expectRevert();
        receiver.purchase{value: PRICE * 3}(3, 2);
        assertEq(token.discountUsed(address(receiver)), 0);
        assertEq(token.allocatedCrates(), 0);
        assertEq(address(token).balance, 0);
        assertEq(token.balanceOf(address(receiver)), 0);
        receiver.purchase{value: PRICE * 3}(3, 0);
        assertEq(token.discountUsed(address(receiver)), 3);
    }

    function testStatsReturnDiscountTermsAndOnlyQueriedWalletUsage() public {
        _buy(ALICE, 1);
        (,,,,,, bytes32 actualRoot, uint256 price, uint256 allowance, uint256 used) = token.stats(ALICE);
        assertEq(actualRoot, root);
        assertEq(price, PRICE);
        assertEq(allowance, 1);
        assertEq(used, 1);
        (,,,,,,,,, used) = token.stats(BOB);
        assertEq(used, 0);
        (,,,,,,,,, used) = token.stats(address(0));
        assertEq(used, 0);
    }

    function testGeneratedJavascriptProofMintsForExplicitWallet() public {
        string memory fixture = vm.readFile("fixtures/discounts/proof.json");
        bytes32 fixtureRoot = vm.parseJsonBytes32(fixture, ".root");
        address wallet = vm.parseJsonAddress(fixture, ".wallet");
        bytes32[] memory proof = vm.parseJsonBytes32Array(fixture, ".proof");
        token.setDiscountConfig(fixtureRoot, 1);
        vm.deal(wallet, PRICE);
        vm.prank(wallet);
        token.mintCratesDiscounted{value: PRICE}(1, proof);
        assertEq(token.ownerOf(111112), wallet);
        assertEq(token.discountUsed(wallet), 1);
        vm.prank(STRANGER);
        vm.expectRevert(NFT111K.InvalidDiscountProof.selector);
        token.mintCratesDiscounted{value: PRICE}(1, proof);
    }

    function testFuzzDiscountAllowanceCannotBeExceeded(uint8 quantitySeed, uint8 limitSeed) public {
        uint256 allowance = uint256(limitSeed) % 10 + 1;
        uint256 quantity = uint256(quantitySeed) % 15 + 1;
        token.setDiscountConfig(root, allowance);
        vm.startPrank(ALICE);
        if (quantity > allowance) vm.expectRevert(NFT111K.DiscountAllowanceExceeded.selector);
        token.mintCratesDiscounted{value: PRICE * quantity}(quantity, _proof(ALICE));
        vm.stopPrank();
        assertEq(token.discountUsed(ALICE), quantity > allowance ? 0 : quantity);
        assertTrue(token.discountUsed(ALICE) <= allowance);
    }

    function _buy(address wallet, uint256 quantity) private {
        vm.prank(wallet);
        token.mintCratesDiscounted{value: PRICE * quantity}(quantity, _proof(wallet));
    }

    function _proof(address wallet) private pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = _leaf(wallet == ALICE ? BOB : ALICE);
    }

    function _leaf(address wallet) private pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(wallet))));
    }

    function _pair(bytes32 first, bytes32 second) private pure returns (bytes32) {
        return first < second ? keccak256(abi.encode(first, second)) : keccak256(abi.encode(second, first));
    }
}
