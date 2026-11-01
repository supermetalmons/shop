pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {DeliveryAccounting} from "./DeliveryAccounting.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract FreeMintReceiver {
    NFT111K private immutable token;
    NFT111K.ItemKind private kind;
    uint256 private rejectAt;
    uint256 public callbacks;
    uint256 public observedUsed;
    uint256 public observedAllocated;
    uint256 public observedMintReceived;
    uint256 public observedWarehouses;
    uint256 public observedMonuments;
    uint256 public observedFirstCrate;

    error ReceiverRejected();

    constructor(NFT111K token_) {
        token = token_;
    }

    function purchase(NFT111K.ItemKind kind_, uint256 quantity, uint256 rejectAt_) external {
        kind = kind_;
        rejectAt = rejectAt_;
        callbacks = 0;
        token.mintFree(kind, quantity);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(token));
        ++callbacks;
        (,,, uint16 cratesUsed, uint16 warehousesUsed, uint16 monumentsUsed) = token.freeMintAllowances(address(this));
        observedUsed = kind == NFT111K.ItemKind.Crate
            ? cratesUsed
            : kind == NFT111K.ItemKind.Warehouse ? warehousesUsed : monumentsUsed;
        observedAllocated = token.allocatedCrates();
        observedMintReceived = token.totalMintReceived();
        observedWarehouses = token.warehousesMinted();
        observedMonuments = token.monumentsMinted();
        if (kind == NFT111K.ItemKind.Warehouse) {
            observedFirstCrate = token.warehouseFirstCrate(tokenId - token.WAREHOUSE_TOKEN_START() + 1);
            require(observedFirstCrate != 0);
        } else if (kind == NFT111K.ItemKind.Monument) {
            observedFirstCrate = token.monumentFirstCrate(tokenId - token.MONUMENT_TOKEN_START() + 1);
            require(observedFirstCrate != 0);
        }
        (bool success, bytes memory reason) = address(token).call(abi.encodeCall(token.mintFree, (kind, 1)));
        require(!success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        if (callbacks == rejectAt) revert ReceiverRejected();
        return this.onERC721Received.selector;
    }
}

contract NFT111KFreeMintTest is TestSupport {
    NFT111K private token;
    address private constant ALICE = address(0xA110);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);

    function setUp() public {
        NFT111K.FreeMintAllocation[] memory allocations = new NFT111K.FreeMintAllocation[](3);
        allocations[0] = NFT111K.FreeMintAllocation(ALICE, 100, 1, 0);
        allocations[1] = NFT111K.FreeMintAllocation(BOB, 5, 0, 0);
        allocations[2] = NFT111K.FreeMintAllocation(CAROL, 0, 0, 2);
        token = _deploy(allocations);
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
    }

    function testConstructorInitializesIndependentAllocationsWithoutIssuance() public view {
        _allowance(ALICE, [uint16(100), 1, 0, 0, 0, 0]);
        _allowance(BOB, [uint16(5), 0, 0, 0, 0, 0]);
        _allowance(CAROL, [uint16(0), 0, 2, 0, 0, 0]);
        assertFalse(token.saleActive());
        assertEq(token.totalSupply(), 0);
        assertEq(token.allocatedCrates(), 0);
        assertEq(token.totalMintReceived(), 0);
        assertTrue(address(token).code.length <= 24_576);
    }

    function testConstructorAcceptsEmptyAndMaximumAllocations() public {
        NFT111K empty = _deploy(new NFT111K.FreeMintAllocation[](0));
        assertEq(empty.totalSupply(), 0);
        NFT111K.FreeMintAllocation[] memory allocations = new NFT111K.FreeMintAllocation[](32);
        for (uint256 i; i < allocations.length; ++i) {
            allocations[i] = NFT111K.FreeMintAllocation(address(uint160(0xD000 + i)), 5555, 505, 18);
        }
        NFT111K maximum = _deploy(allocations);
        (uint16 crates, uint16 warehouses, uint16 monuments,,,) = maximum.freeMintAllowances(address(0xD01F));
        assertEq(crates, 5555);
        assertEq(warehouses, 505);
        assertEq(monuments, 18);
        assertEq(maximum.allocatedCrates(), 0);
    }

    function testConstructorRejectsOversizedDuplicateAndInvalidAllocations() public {
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        _deploy(new NFT111K.FreeMintAllocation[](33));
        NFT111K.FreeMintAllocation[] memory allocations = new NFT111K.FreeMintAllocation[](2);
        allocations[0] = NFT111K.FreeMintAllocation(ALICE, 0, 0, 0);
        allocations[1] = allocations[0];
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        _deploy(allocations);
        allocations = new NFT111K.FreeMintAllocation[](1);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(allocations);
        allocations[0] = NFT111K.FreeMintAllocation(ALICE, 5556, 0, 0);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        _deploy(allocations);
        allocations[0] = NFT111K.FreeMintAllocation(ALICE, 0, 506, 0);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        _deploy(allocations);
        allocations[0] = NFT111K.FreeMintAllocation(ALICE, 0, 0, 19);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        _deploy(allocations);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        allocations[0] = NFT111K.FreeMintAllocation(predicted, 1, 0, 0);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        _deploy(allocations);
    }

    function testFreeMintsUseSharedSaleGateAndRejectPayment() public {
        NFT111K.ItemKind[3] memory kinds =
            [NFT111K.ItemKind.Crate, NFT111K.ItemKind.Warehouse, NFT111K.ItemKind.Monument];
        token.setFreeMintAllowances(_wallet(ALICE), 1, 1, 1);
        for (uint256 i; i < kinds.length; ++i) {
            vm.prank(ALICE);
            vm.expectRevert(NFT111K.SaleInactive.selector);
            token.mintFree(kinds[i], 1);
        }
        token.setSaleActive(true);
        vm.prank(ALICE);
        (bool success,) = address(token).call{value: 1}(abi.encodeCall(token.mintFree, (NFT111K.ItemKind.Crate, 1)));
        assertFalse(success);
        assertEq(address(token).balance, 0);
        _allowance(ALICE, [uint16(1), 1, 1, 0, 0, 0]);
        token.setRedemptionsPaused(true);
        _mint(ALICE, NFT111K.ItemKind.Crate, 1);
    }

    function testRejectsUnsupportedKindsAndInvalidQuantities() public {
        token.setSaleActive(true);
        for (uint8 kind; kind < 8; ++kind) {
            if (kind == 2 || kind == 3 || kind == 6) continue;
            vm.prank(ALICE);
            vm.expectRevert(NFT111K.WrongItemKind.selector);
            token.mintFree(NFT111K.ItemKind(kind), 1);
        }
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.mintFree(NFT111K.ItemKind.Crate, 0);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.InvalidQuantity.selector);
        token.mintFree(NFT111K.ItemKind.Crate, 16);
        vm.prank(address(0xBAD));
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.mintFree(NFT111K.ItemKind.Crate, 1);
    }

    function testLargeEntitlementClaimsInBatchesAndKindsStayIndependent() public {
        token.setSaleActive(true);
        for (uint256 i; i < 6; ++i) {
            _mint(ALICE, NFT111K.ItemKind.Crate, 15);
        }
        _mint(ALICE, NFT111K.ItemKind.Crate, 10);
        _mint(ALICE, NFT111K.ItemKind.Warehouse, 1);
        _mint(BOB, NFT111K.ItemKind.Crate, 5);
        _mint(CAROL, NFT111K.ItemKind.Monument, 2);
        _allowance(ALICE, [uint16(100), 1, 0, 100, 1, 0]);
        _allowance(BOB, [uint16(5), 0, 0, 5, 0, 0]);
        _allowance(CAROL, [uint16(0), 0, 2, 0, 0, 2]);
        assertEq(token.allocatedCrates(), 338);
        assertEq(token.warehouseFirstCrate(1), 101);
        assertEq(token.monumentFirstCrate(1), 117);
        assertEq(token.monumentFirstCrate(2), 228);
        assertEq(token.ownerOf(116667), ALICE);
        assertEq(token.ownerOf(117172), CAROL);
        assertEq(token.totalMintReceived(), 0);
        assertEq(DeliveryAccounting.received(token), 0);
        assertEq(address(token).balance, 0);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.mintFree(NFT111K.ItemKind.Crate, 1);
    }

    function testMaximumFreeCrateUsageSurvivesRevocationAndRestoration() public {
        _claimMaximumAllowance(NFT111K.ItemKind.Crate, 0, 5555, 1, 111112);
    }

    function testMaximumFreeWarehouseUsageSurvivesRevocationAndRestoration() public {
        _claimMaximumAllowance(NFT111K.ItemKind.Warehouse, 1, 505, 11, 116667);
    }

    function testMaximumFreeMonumentUsageSurvivesRevocationAndRestoration() public {
        _claimMaximumAllowance(NFT111K.ItemKind.Monument, 2, 18, 111, 117172);
    }

    function testLifetimeUsageSurvivesLimitChangesRevocationAndRestoration() public {
        token.setSaleActive(true);
        _mint(ALICE, NFT111K.ItemKind.Crate, 5);
        _mint(ALICE, NFT111K.ItemKind.Warehouse, 1);
        token.setFreeMintAllowances(_wallet(ALICE), 2, 0, 0);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.mintFree(NFT111K.ItemKind.Crate, 1);
        token.setFreeMintAllowances(_wallet(ALICE), 0, 0, 0);
        _allowance(ALICE, [uint16(0), 0, 0, 5, 1, 0]);
        token.setFreeMintAllowances(_wallet(ALICE), 7, 1, 1);
        _mint(ALICE, NFT111K.ItemKind.Crate, 2);
        _mint(ALICE, NFT111K.ItemKind.Monument, 1);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.mintFree(NFT111K.ItemKind.Warehouse, 1);
        _allowance(ALICE, [uint16(7), 1, 1, 7, 1, 1]);
    }

    function testSetterIsOwnerOnlyAndInvalidBatchRollsBack() public {
        vm.prank(ALICE);
        vm.expectRevert();
        token.setFreeMintAllowances(_wallet(ALICE), 1, 1, 1);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setFreeMintAllowances(new address[](0), 1, 1, 1);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setFreeMintAllowances(new address[](33), 1, 1, 1);
        address[] memory wallets = new address[](2);
        wallets[0] = ALICE;
        wallets[1] = ALICE;
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setFreeMintAllowances(wallets, 1, 1, 1);
        wallets[1] = address(0);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        token.setFreeMintAllowances(wallets, 1, 1, 1);
        wallets[1] = address(token);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        token.setFreeMintAllowances(wallets, 1, 1, 1);
        _allowance(ALICE, [uint16(100), 1, 0, 0, 0, 0]);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setFreeMintAllowances(_wallet(ALICE), 5556, 0, 0);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setFreeMintAllowances(_wallet(ALICE), 0, 506, 0);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        token.setFreeMintAllowances(_wallet(ALICE), 0, 0, 19);
        wallets = new address[](32);
        for (uint256 i; i < wallets.length; ++i) {
            wallets[i] = address(uint160(0xD000 + i));
        }
        token.setFreeMintAllowances(wallets, 5555, 505, 18);
        _allowance(wallets[31], [uint16(5555), 505, 18, 0, 0, 0]);
    }

    function testPaidAndDiscountedPurchasesDoNotConsumeFreeEntitlements() public {
        token.setSaleActive(true);
        vm.startPrank(ALICE);
        token.mintCrates{value: 0.0001 ether}(1);
        token.mintWarehouses{value: 0.0011 ether}(1);
        token.mintMonuments{value: 0.0088 ether}(1);
        token.mintCratesDiscounted{value: 0.00005 ether}(1, new bytes32[](0));
        vm.stopPrank();
        _allowance(ALICE, [uint16(100), 1, 0, 0, 0, 0]);
        _mint(ALICE, NFT111K.ItemKind.Crate, 1);
        _mint(ALICE, NFT111K.ItemKind.Warehouse, 1);
        assertEq(token.discountUsed(ALICE), 1);
        assertEq(token.totalMintReceived(), 0.01005 ether);
        assertEq(token.allocatedCrates(), 136);
    }

    function testTransferAndOpeningDoNotConsumeOrRestoreEntitlements() public {
        token.setSaleActive(true);
        _mint(ALICE, NFT111K.ItemKind.Crate, 1);
        _mint(ALICE, NFT111K.ItemKind.Warehouse, 1);
        _mint(CAROL, NFT111K.ItemKind.Monument, 1);
        vm.prank(ALICE);
        token.transferFrom(ALICE, BOB, 111112);
        vm.prank(ALICE);
        token.unboxWarehouse(116667);
        vm.prank(BOB);
        token.unboxCrate(111112);
        vm.prank(CAROL);
        token.unboxMonument(117172);
        _allowance(ALICE, [uint16(100), 1, 0, 1, 1, 0]);
        _allowance(BOB, [uint16(5), 0, 0, 0, 0, 0]);
        _allowance(CAROL, [uint16(0), 0, 2, 0, 0, 1]);
        assertEq(token.allocatedCrates(), 123);
        assertEq(token.warehousesMinted(), 1);
        assertEq(token.monumentsMinted(), 1);
    }

    function testFreeEntitlementsDoNotReserveSupplyAndSoldOutClaimsKeepUsage() public {
        token.setSaleActive(true);
        vm.startPrank(BOB);
        for (uint256 i; i < 33; ++i) {
            token.mintWarehouses{value: 15 * 0.0011 ether}(15);
        }
        token.mintWarehouses{value: 10 * 0.0011 ether}(10);
        vm.stopPrank();
        assertEq(token.allocatedCrates(), 5555);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintFree(NFT111K.ItemKind.Crate, 1);
        vm.prank(ALICE);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintFree(NFT111K.ItemKind.Warehouse, 1);
        vm.prank(CAROL);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintFree(NFT111K.ItemKind.Monument, 1);
        _allowance(ALICE, [uint16(100), 1, 0, 0, 0, 0]);
        _allowance(CAROL, [uint16(0), 0, 2, 0, 0, 0]);
    }

    function testPaidAndFreeMonumentsShareLifetimeCapAfterOpening() public {
        token.setSaleActive(true);
        vm.prank(BOB);
        token.mintMonuments{value: 15 * 0.0088 ether}(15);
        _mint(CAROL, NFT111K.ItemKind.Monument, 2);
        vm.prank(BOB);
        token.mintMonuments{value: 0.0088 ether}(1);
        vm.prank(CAROL);
        token.unboxMonument(117187);
        token.setFreeMintAllowances(_wallet(CAROL), 0, 0, 3);
        vm.prank(CAROL);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintFree(NFT111K.ItemKind.Monument, 1);
        _allowance(CAROL, [uint16(0), 0, 3, 0, 0, 2]);
        assertEq(token.monumentsMinted(), 18);
    }

    function testEventsKeepPurchaseCompatibilityAndIdentifyFreeClaims() public {
        token.setSaleActive(true);
        NFT111K.ItemKind[3] memory kinds =
            [NFT111K.ItemKind.Crate, NFT111K.ItemKind.Warehouse, NFT111K.ItemKind.Monument];
        bytes32[3] memory topics = [
            keccak256("CratesPurchased(address,uint256,uint256,uint256)"),
            keccak256("WarehousesPurchased(address,uint256,uint256,uint256)"),
            keccak256("MonumentsPurchased(address,uint256,uint256,uint256)")
        ];
        uint256[3] memory firstTokens = [uint256(111112), 116667, 117172];
        token.setFreeMintAllowances(_wallet(ALICE), 1, 1, 1);
        for (uint256 i; i < kinds.length; ++i) {
            vm.recordLogs();
            _mint(ALICE, kinds[i], 1);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            Vm.Log memory purchase = logs[logs.length - 2];
            assertEq(purchase.topics[0], topics[i]);
            assertEq(address(uint160(uint256(purchase.topics[1]))), ALICE);
            (uint256 first, uint256 quantity, uint256 paid) = abi.decode(purchase.data, (uint256, uint256, uint256));
            assertEq(first, firstTokens[i]);
            assertEq(quantity, 1);
            assertEq(paid, 0);
            Vm.Log memory claimed = logs[logs.length - 1];
            assertEq(claimed.topics[0], keccak256("FreeMintClaimed(address,uint8,uint256)"));
            assertEq(address(uint160(uint256(claimed.topics[1]))), ALICE);
            assertEq(uint256(claimed.topics[2]), uint256(kinds[i]));
            assertEq(abi.decode(claimed.data, (uint256)), 1);
        }
    }

    function testCallbacksObserveFinalUsageAndRejectReentryForEveryKind() public {
        token.setSaleActive(true);
        NFT111K.ItemKind[3] memory kinds =
            [NFT111K.ItemKind.Crate, NFT111K.ItemKind.Warehouse, NFT111K.ItemKind.Monument];
        uint256[3] memory allocated = [uint256(3), 36, 369];
        uint256[3] memory firstCrates = [uint256(0), 26, 259];
        for (uint256 i; i < kinds.length; ++i) {
            FreeMintReceiver receiver = new FreeMintReceiver(token);
            token.setFreeMintAllowances(_wallet(address(receiver)), 3, 3, 3);
            receiver.purchase(kinds[i], 3, 0);
            assertEq(receiver.callbacks(), 3);
            assertEq(receiver.observedUsed(), 3);
            assertEq(receiver.observedAllocated(), allocated[i]);
            assertEq(receiver.observedMintReceived(), 0);
            assertEq(receiver.observedWarehouses(), i == 0 ? 0 : 3);
            assertEq(receiver.observedMonuments(), i == 2 ? 3 : 0);
            assertEq(receiver.observedFirstCrate(), firstCrates[i]);
        }
    }

    function testRejectedCallbacksRollBackUsageSupplyAndContainersForEveryKind() public {
        token.setSaleActive(true);
        NFT111K.ItemKind[3] memory kinds =
            [NFT111K.ItemKind.Crate, NFT111K.ItemKind.Warehouse, NFT111K.ItemKind.Monument];
        for (uint256 i; i < kinds.length; ++i) {
            FreeMintReceiver receiver = new FreeMintReceiver(token);
            token.setFreeMintAllowances(_wallet(address(receiver)), 3, 3, 3);
            vm.expectRevert(FreeMintReceiver.ReceiverRejected.selector);
            receiver.purchase(kinds[i], 3, 2);
            _allowance(address(receiver), [uint16(3), 3, 3, 0, 0, 0]);
            assertEq(token.allocatedCrates(), 0);
            assertEq(token.totalSupply(), 0);
            assertEq(token.warehousesMinted(), 0);
            assertEq(token.monumentsMinted(), 0);
            assertEq(token.warehouseFirstCrate(1), 0);
            assertEq(token.monumentFirstCrate(1), 0);
            assertEq(token.totalMintReceived(), 0);
        }
    }

    function testFuzzAllowanceCannotBeExceeded(uint8 quantitySeed, uint8 limitSeed, uint8 kindSeed) public {
        uint16 limit = uint16(limitSeed % 18);
        uint256 quantity = uint256(quantitySeed % 15) + 1;
        NFT111K.ItemKind kind = kindSeed % 3 == 0
            ? NFT111K.ItemKind.Crate
            : kindSeed % 3 == 1 ? NFT111K.ItemKind.Warehouse : NFT111K.ItemKind.Monument;
        token.setSaleActive(true);
        token.setFreeMintAllowances(_wallet(ALICE), limit, limit, limit);
        vm.prank(ALICE);
        if (quantity > limit) vm.expectRevert(NFT111K.FreeMintAllowanceExceeded.selector);
        token.mintFree(kind, quantity);
        (,,, uint16 crates, uint16 warehouses, uint16 monuments) = token.freeMintAllowances(ALICE);
        assertEq(uint256(crates) + warehouses + monuments, quantity > limit ? 0 : quantity);
    }

    function _claimMaximumAllowance(
        NFT111K.ItemKind kind,
        uint256 index,
        uint16 limit,
        uint256 units,
        uint256 firstToken
    ) private {
        token.setFreeMintAllowances(_wallet(ALICE), 5555, 505, 18);
        assertEq(token.allocatedCrates(), 0);
        assertEq(token.totalSupply(), 0);
        assertEq(token.remainingCrates(), 5555);
        token.setSaleActive(true);
        uint256 remaining = limit;
        while (remaining != 0) {
            uint256 quantity = remaining > 15 ? 15 : remaining;
            _mint(ALICE, kind, quantity);
            remaining -= quantity;
        }
        uint16[6] memory expected = [uint16(5555), 505, 18, 0, 0, 0];
        expected[index + 3] = limit;
        _allowance(ALICE, expected);
        assertEq(token.allocatedCrates(), uint256(limit) * units);
        assertEq(token.remainingCrates(), 5555 - uint256(limit) * units);
        assertEq(token.warehousesMinted(), index == 1 ? limit : 0);
        assertEq(token.monumentsMinted(), index == 2 ? limit : 0);
        assertEq(token.totalSupply(), limit);
        assertEq(token.balanceOf(ALICE), limit);
        assertEq(token.ownerOf(firstToken), ALICE);
        assertEq(token.ownerOf(firstToken + limit - 1), ALICE);
        assertEq(token.totalMintReceived(), 0);
        assertEq(DeliveryAccounting.received(token), 0);
        assertEq(token.discountUsed(ALICE), 0);
        assertEq(address(token).balance, 0);
        token.setFreeMintAllowances(_wallet(ALICE), 0, 0, 0);
        expected[0] = 0;
        expected[1] = 0;
        expected[2] = 0;
        _allowance(ALICE, expected);
        token.setFreeMintAllowances(_wallet(ALICE), 5555, 505, 18);
        expected[0] = 5555;
        expected[1] = 505;
        expected[2] = 18;
        _allowance(ALICE, expected);
        vm.prank(ALICE);
        vm.expectRevert(index == 2 ? NFT111K.FreeMintAllowanceExceeded.selector : NFT111K.SoldOut.selector);
        token.mintFree(kind, 1);
        _allowance(ALICE, expected);
    }

    function _deploy(NFT111K.FreeMintAllocation[] memory allocations) private returns (NFT111K) {
        return new NFT111K(
            address(this),
            address(0x5151),
            address(0xBEEF),
            "https://cdn.mons.shop/111k-sepolia/",
            keccak256(bytes.concat(keccak256(abi.encode(ALICE)))),
            _proceedsRecipients(),
            _proceedsSharesBps(),
            allocations
        );
    }

    function _wallet(address wallet) private pure returns (address[] memory wallets) {
        wallets = new address[](1);
        wallets[0] = wallet;
    }

    function _mint(address wallet, NFT111K.ItemKind kind, uint256 quantity) private {
        vm.prank(wallet);
        token.mintFree(kind, quantity);
    }

    function _allowance(address wallet, uint16[6] memory expected) private view {
        (
            uint16 crates,
            uint16 warehouses,
            uint16 monuments,
            uint16 cratesUsed,
            uint16 warehousesUsed,
            uint16 monumentsUsed
        ) = token.freeMintAllowances(wallet);
        uint16[6] memory actual = [crates, warehouses, monuments, cratesUsed, warehousesUsed, monumentsUsed];
        for (uint256 i; i < actual.length; ++i) {
            assertEq(actual[i], expected[i]);
        }
    }
}
