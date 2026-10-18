pragma solidity 0.8.30;

import {Mons111k} from "../src/Mons111k.sol";
import {Mons111kRenderer} from "../src/Mons111kRenderer.sol";
import {TestSupport} from "./TestSupport.sol";

contract MinimalGasReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

contract Mons111kGasTest is TestSupport {
    Mons111k internal token;
    address internal alice = address(0xA110);
    address internal bob = address(0xB0B);
    address internal receiver;
    uint256 internal constant SIGNER_KEY = 0xA11CE;
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
        token =
            new Mons111k(address(this), vm.addr(SIGNER_KEY), payable(address(0xBEEF)), address(new Mons111kRenderer()));
        receiver = address(new MinimalGasReceiver());
        vm.deal(alice, 100 ether);
        vm.deal(receiver, 100 ether);
    }

    function testGasMintCrates1() public {
        _mintCrates(alice, 1, "mintCrates1");
    }

    function testGasMintCrates15() public {
        _mintCrates(alice, 15, "mintCrates15");
    }

    function testGasMintCrates15Receiver() public {
        _mintCrates(receiver, 15, "mintCrates15Receiver");
    }

    function testGasMintCrates15After1() public {
        _buyCrates(alice, 1);
        _mintCrates(alice, 15, "mintCrates15After1");
    }

    function testGasMintCrates15After240() public {
        _buyCrates(alice, 240);
        _mintCrates(alice, 15, "mintCrates15After240");
    }

    function testGasMintCrates1AfterWarehouse() public {
        _buyWarehouses(alice, 1);
        _mintCrates(alice, 1, "mintCrates1AfterWarehouse");
    }

    function testGasMintCrates15AfterWarehouse() public {
        _buyWarehouses(alice, 1);
        _mintCrates(alice, 15, "mintCrates15AfterWarehouse");
    }

    function testGasMintWarehouses1() public {
        _mintWarehouses(alice, 1, "mintWarehouses1");
    }

    function testGasMintWarehouses15() public {
        _mintWarehouses(alice, 15, "mintWarehouses15");
    }

    function testGasMintWarehouses15Receiver() public {
        _mintWarehouses(receiver, 15, "mintWarehouses15Receiver");
    }

    function testGasMintWarehouses1AfterCrate() public {
        _buyCrates(alice, 1);
        _mintWarehouses(alice, 1, "mintWarehouses1AfterCrate");
    }

    function testGasMintWarehouses15AfterCrate() public {
        _buyCrates(alice, 1);
        _mintWarehouses(alice, 15, "mintWarehouses15AfterCrate");
    }

    function testGasMintWarehouses1AfterWarehouse() public {
        _buyWarehouses(alice, 1);
        _mintWarehouses(alice, 1, "mintWarehouses1AfterWarehouse");
    }

    function testGasMintWarehouses15AfterWarehouse() public {
        _buyWarehouses(alice, 1);
        _mintWarehouses(alice, 15, "mintWarehouses15AfterWarehouse");
    }

    function testGasUnboxWarehouse() public {
        _unboxWarehouse(alice, "unboxWarehouse");
    }

    function testGasUnboxWarehouseReceiver() public {
        _unboxWarehouse(receiver, "unboxWarehouseReceiver");
    }

    function testGasUnboxCrate20() public {
        _unboxCrate(alice, false, "unboxCrate20");
    }

    function testGasUnboxCrate20Receiver() public {
        _unboxCrate(receiver, false, "unboxCrate20Receiver");
    }

    function testGasUnboxCrate31() public {
        _unboxCrate(alice, true, "unboxCrate31");
    }

    function testGasUnboxCrate31Receiver() public {
        _unboxCrate(receiver, true, "unboxCrate31Receiver");
    }

    function testGasDeliverArtwork1() public {
        _deliverArtworks(alice, 1, "deliverArtwork1");
    }

    function testGasDeliverArtworks50() public {
        _deliverArtworks(alice, 50, "deliverArtworks50");
    }

    function testGasDeliverArtworks50Receiver() public {
        _deliverArtworks(receiver, 50, "deliverArtworks50Receiver");
    }

    function testGasDeliverCrate1() public {
        _deliverCrates(alice, 1, "deliverCrate1");
    }

    function testGasDeliverCrates50() public {
        _deliverCrates(alice, 50, "deliverCrates50");
    }

    function testGasDeliverCrates50Receiver() public {
        _deliverCrates(receiver, 50, "deliverCrates50Receiver");
    }

    function testGasDeliverMixed50() public {
        _deliverMixed(alice, "deliverMixed50");
    }

    function testGasDeliverMixed50Receiver() public {
        _deliverMixed(receiver, "deliverMixed50Receiver");
    }

    function testGasClaim20() public {
        _claim(alice, 1, "claim20");
    }

    function testGasClaim20Receiver() public {
        _claim(receiver, 1, "claim20Receiver");
    }

    function testGasClaim20Crate10() public {
        _claim(alice, 10, "claim20Crate10");
    }

    function testGasClaim31() public {
        _claim(alice, 5555, "claim31");
    }

    function testGasClaim31Receiver() public {
        _claim(receiver, 5555, "claim31Receiver");
    }

    function testGasGetTokenInfoFresh() public {
        _artworks(alice, 1);
        (uint8 kind, uint256 displayId, address owner) = token.getTokenInfo(20);
        vm.snapshotGasLastCall("getTokenInfoFresh");
        assertEq(kind, 1);
        assertEq(displayId, 20);
        assertEq(owner, alice);
    }

    function testGasGetTokenInfoFragmented() public {
        _artworks(alice, 1);
        vm.startPrank(alice);
        token.transferFrom(alice, bob, 5);
        token.transferFrom(alice, bob, 10);
        token.transferFrom(alice, bob, 15);
        vm.stopPrank();
        (uint8 kind, uint256 displayId, address owner) = token.getTokenInfo(20);
        vm.snapshotGasLastCall("getTokenInfoFragmented");
        assertEq(kind, 1);
        assertEq(displayId, 20);
        assertEq(owner, alice);
    }

    function testGasGetTokenInfoFresh31() public {
        uint256 crateId = _bonusCrate(alice);
        vm.prank(alice);
        token.unboxCrate(crateId);
        (uint8 kind, uint256 displayId, address owner) = token.getTokenInfo(31);
        vm.snapshotGasLastCall("getTokenInfoFresh31");
        assertEq(kind, 1);
        assertEq(displayId, 111111);
        assertEq(owner, alice);
    }

    function testGasGetTokenInfoInitialized() public {
        _artworks(alice, 1);
        vm.prank(alice);
        token.transferFrom(alice, bob, 20);
        (uint8 kind, uint256 displayId, address owner) = token.getTokenInfo(20);
        vm.snapshotGasLastCall("getTokenInfoInitialized");
        assertEq(kind, 1);
        assertEq(displayId, 20);
        assertEq(owner, bob);
    }

    function testGasGetTokenInfoSpot() public {
        _buyCrates(alice, 1);
        (uint8 kind, uint256 displayId, address owner) = token.getTokenInfo(111112);
        vm.snapshotGasLastCall("getTokenInfoSpot");
        assertEq(kind, 2);
        assertEq(displayId, 1);
        assertEq(owner, alice);
    }

    function testGasGetTokenInfoAbsentSequential() public {
        _artworks(alice, 1);
        _absentTokenInfo(21, "getTokenInfoAbsentSequential");
    }

    function testGasGetTokenInfoAbsentSpot() public {
        _buyCrates(alice, 1);
        _absentTokenInfo(111113, "getTokenInfoAbsentSpot");
    }

    function testGasGetTokenInfoBurnedSequential() public {
        _artworks(alice, 1);
        uint256[] memory ids = _range(20, 1);
        Mons111k.DeliveryQuote memory quote = _quote(alice, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(alice);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        _absentTokenInfo(20, "getTokenInfoBurnedSequential");
    }

    function testGasGetTokenInfoBurnedSpot() public {
        _artworks(alice, 1);
        _absentTokenInfo(111112, "getTokenInfoBurnedSpot");
    }

    function testGasStats() public {
        _buyCrates(alice, 1);
        _buyWarehouses(alice, 1);
        (
            uint256 allocated,
            uint256 warehouses,
            uint256 artworks,
            uint256 cratePrice,
            uint256 warehousePrice,
            bool saleActive
        ) = token.stats();
        vm.snapshotGasLastCall("stats");
        assertEq(allocated, 12);
        assertEq(warehouses, 1);
        assertEq(artworks, 0);
        assertEq(cratePrice, 0.0001 ether);
        assertEq(warehousePrice, 0.0011 ether);
        assertTrue(saleActive);
    }

    function testGasAllocatedCrates() public {
        _buyCrates(alice, 1);
        _buyWarehouses(alice, 1);
        uint256 allocated = token.allocatedCrates();
        vm.snapshotGasLastCall("allocatedCrates");
        assertEq(allocated, 12);
    }

    function testGasWarehousesMinted() public {
        _buyCrates(alice, 1);
        _buyWarehouses(alice, 1);
        uint256 warehouses = token.warehousesMinted();
        vm.snapshotGasLastCall("warehousesMinted");
        assertEq(warehouses, 1);
    }

    function _absentTokenInfo(uint256 tokenId, string memory name) internal {
        (uint8 kind, uint256 displayId, address owner) = token.getTokenInfo(tokenId);
        vm.snapshotGasLastCall(name);
        assertEq(kind, 0);
        assertEq(displayId, 0);
        assertEq(owner, address(0));
    }

    function _mintCrates(address wallet, uint256 quantity, string memory name) internal {
        vm.prank(wallet);
        token.mintCrates{value: quantity * 0.0001 ether}(quantity);
        vm.snapshotGasLastCall(name);
    }

    function _mintWarehouses(address wallet, uint256 quantity, string memory name) internal {
        vm.prank(wallet);
        token.mintWarehouses{value: quantity * 0.0011 ether}(quantity);
        vm.snapshotGasLastCall(name);
    }

    function _unboxWarehouse(address wallet, string memory name) internal {
        _buyWarehouses(wallet, 1);
        vm.prank(wallet);
        token.unboxWarehouse(116667);
        vm.snapshotGasLastCall(name);
        assertEq(token.balanceOf(wallet), 11);
    }

    function _unboxCrate(address wallet, bool bonus, string memory name) internal {
        uint256 crateId = bonus ? _bonusCrate(wallet) : _ordinaryCrate(wallet, 1);
        vm.prank(wallet);
        token.unboxCrate(crateId);
        vm.snapshotGasLastCall(name);
        (uint8 kind, uint256 displayId, address owner) = token.getTokenInfo(bonus ? 31 : 20);
        assertEq(kind, 1);
        assertEq(displayId, bonus ? 111111 : 20);
        assertEq(owner, wallet);
    }

    function _deliverArtworks(address wallet, uint256 quantity, string memory name) internal {
        _artworks(wallet, (quantity + 19) / 20);
        _deliver(wallet, _range(1, quantity), name);
    }

    function _deliverCrates(address wallet, uint256 quantity, string memory name) internal {
        _buyCrates(wallet, quantity);
        _deliver(wallet, _range(111112, quantity), name);
    }

    function _deliverMixed(address wallet, string memory name) internal {
        _buyCrates(wallet, 27);
        vm.startPrank(wallet);
        token.unboxCrate(111112);
        token.unboxCrate(111113);
        vm.stopPrank();
        uint256[] memory ids = new uint256[](50);
        for (uint256 i; i < 25; ++i) {
            ids[i] = i + 1;
            ids[25 + i] = 111114 + i;
        }
        _deliver(wallet, ids, name);
    }

    function _deliver(address wallet, uint256[] memory ids, string memory name) internal {
        Mons111k.DeliveryQuote memory quote = _quote(wallet, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(wallet);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        vm.snapshotGasLastCall(name);
        assertTrue(token.usedDeliveryOrders(quote.orderId));
    }

    function _claim(address wallet, uint256 crateNumber, string memory name) internal {
        uint256 crateId = crateNumber == 5555 ? _bonusCrate(wallet) : _ordinaryCrate(wallet, crateNumber);
        uint256[] memory ids = _range(crateId, 1);
        Mons111k.DeliveryQuote memory quote = _quote(wallet, ids);
        bytes memory deliverySignature = _deliverySignature(ids, quote);
        vm.prank(wallet);
        token.redeemForDelivery{value: quote.fee}(ids, quote, deliverySignature);
        uint256 receiptId = 2_000_000 + crateNumber;
        bytes32 claimId = keccak256("gas claim");
        uint256 deadline = block.timestamp + 300;
        bytes32 structHash = keccak256(abi.encode(CLAIM_TYPEHASH, wallet, receiptId, claimId, deadline));
        bytes memory signature = _sign(structHash);
        vm.prank(wallet);
        token.claimCrateReceipt(receiptId, claimId, deadline, signature);
        vm.snapshotGasLastCall(name);
        assertTrue(token.usedClaims(claimId));
    }

    function _ordinaryCrate(address wallet, uint256 number) internal returns (uint256) {
        _buyCrates(wallet, number);
        return 111111 + number;
    }

    function _bonusCrate(address wallet) internal returns (uint256) {
        _buyWarehouses(wallet, 505);
        vm.prank(wallet);
        token.unboxWarehouse(117171);
        return 116666;
    }

    function _artworks(address wallet, uint256 crates) internal {
        _buyCrates(wallet, crates);
        vm.startPrank(wallet);
        for (uint256 i; i < crates; ++i) {
            token.unboxCrate(111112 + i);
        }
        vm.stopPrank();
    }

    function _buyCrates(address wallet, uint256 quantity) internal {
        while (quantity != 0) {
            uint256 batch = quantity > 15 ? 15 : quantity;
            vm.prank(wallet);
            token.mintCrates{value: batch * 0.0001 ether}(batch);
            quantity -= batch;
        }
    }

    function _buyWarehouses(address wallet, uint256 quantity) internal {
        while (quantity != 0) {
            uint256 batch = quantity > 15 ? 15 : quantity;
            vm.prank(wallet);
            token.mintWarehouses{value: batch * 0.0011 ether}(batch);
            quantity -= batch;
        }
    }

    function _quote(address wallet, uint256[] memory ids) internal view returns (Mons111k.DeliveryQuote memory) {
        uint256[] memory receipts = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint256 displayId,) = token.getTokenInfo(ids[i]);
            receipts[i] = (kind == 1 ? 1_000_000 : 2_000_000) + displayId;
        }
        return Mons111k.DeliveryQuote(1, wallet, 0.0001 ether, block.timestamp + 300, keccak256(abi.encode(receipts)));
    }

    function _deliverySignature(uint256[] memory ids, Mons111k.DeliveryQuote memory quote)
        internal
        returns (bytes memory)
    {
        return _sign(
            keccak256(
                abi.encode(
                    DELIVERY_TYPEHASH,
                    quote.wallet,
                    keccak256(abi.encode(ids)),
                    quote.receiptIdsHash,
                    quote.orderId,
                    quote.fee,
                    quote.deadline
                )
            )
        );
    }

    function _sign(bytes32 structHash) internal returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Mons111k"), keccak256("2"), block.chainid, address(token))
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _range(uint256 start, uint256 quantity) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](quantity);
        for (uint256 i; i < quantity; ++i) {
            ids[i] = start + i;
        }
    }
}
