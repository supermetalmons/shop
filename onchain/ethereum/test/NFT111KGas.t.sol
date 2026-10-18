pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {NFT111KRenderer} from "../src/NFT111KRenderer.sol";
import {TestSupport} from "./TestSupport.sol";

interface GasMeasurementVm {
    function snapshotValue(string calldata name, uint256 value) external;
}

contract MinimalGasReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

contract NFT111KGasTest is TestSupport {
    NFT111K internal token;
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
            new NFT111K(address(this), vm.addr(SIGNER_KEY), payable(address(0xBEEF)), address(new NFT111KRenderer()));
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

    function testGasUnboxCrates1() public {
        _unboxCrates(alice, 1, false, false, "unboxCrates1");
    }

    function testGasUnboxCrates15() public {
        _unboxCrates(alice, 15, false, false, "unboxCrates15");
    }

    function testGasUnboxCrates15Receiver() public {
        _unboxCrates(receiver, 15, false, false, "unboxCrates15Receiver");
    }

    function testGasUnboxCrates15Bonus() public {
        _unboxCrates(alice, 15, true, false, "unboxCrates15Bonus");
    }

    function testGasUnboxCrates15BonusReceiver() public {
        _unboxCrates(receiver, 15, true, false, "unboxCrates15BonusReceiver");
    }

    function testGasUnboxCrates15Separate() public {
        _unboxCrates(alice, 15, false, true, "unboxCrates15Separate");
    }

    function testGasUnboxCrates15SeparateReceiver() public {
        _unboxCrates(receiver, 15, false, true, "unboxCrates15SeparateReceiver");
    }

    function testGasUnboxCrates15BonusSeparate() public {
        _unboxCrates(alice, 15, true, true, "unboxCrates15BonusSeparate");
    }

    function testGasUnboxCrates15BonusSeparateReceiver() public {
        _unboxCrates(receiver, 15, true, true, "unboxCrates15BonusSeparateReceiver");
    }

    function testGasGetTokenInfos150Fresh() public {
        _artworks(alice, 150);
        _buyWarehouses(alice, 491);
        _buyCrates(alice, 4);
        vm.prank(alice);
        token.unboxCrate(116666);
        uint256[] memory ids = new uint256[](150);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = 20 * (i + 1);
        }
        ids[149] = 3031;
        NFT111K.TokenInfo[] memory infos = token.getTokenInfos(ids);
        vm.snapshotGasLastCall("getTokenInfos150Fresh");
        assertEq(infos.length, 150);
        assertEq(infos[149].displayId, 111111);
    }

    function testGasGetTokenInfos150Spot() public {
        _buyCrates(alice, 150);
        NFT111K.TokenInfo[] memory infos = token.getTokenInfos(_range(111112, 150));
        vm.snapshotGasLastCall("getTokenInfos150Spot");
        assertEq(infos.length, 150);
        assertEq(infos[149].displayId, 150);
    }

    function testGasGetTokenInfos150Missing() public {
        NFT111K.TokenInfo[] memory infos = token.getTokenInfos(_range(1000001, 150));
        vm.snapshotGasLastCall("getTokenInfos150Missing");
        assertEq(infos.length, 150);
        assertEq(infos[149].kind, 0);
    }

    function testGasPreviewTokenURIs1ArtworkReceipt() public {
        _metadataBatch(1, 4, "previewTokenURIs1ArtworkReceipt");
    }

    function testGasPreviewTokenURIs30Artworks() public {
        _metadataBatch(30, 1, "previewTokenURIs30Artworks");
    }

    function testGasPreviewTokenURIs30ArtworkReceipts() public {
        _metadataBatch(30, 4, "previewTokenURIs30ArtworkReceipts");
    }

    function testGasPreviewTokenURIs30Mixed() public {
        _metadataBatch(30, 0, "previewTokenURIs30Mixed");
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

    function testGasDeliverArtworks20Ascending() public {
        _deliverOrdered(alice, 0, 0, "deliverArtworks20Ascending");
    }

    function testGasDeliverArtworks20AscendingReceiver() public {
        _deliverOrdered(receiver, 0, 0, "deliverArtworks20AscendingReceiver");
    }

    function testGasDeliverArtworks20Descending() public {
        _deliverOrdered(alice, 0, 1, "deliverArtworks20Descending");
    }

    function testGasDeliverArtworks20DescendingReceiver() public {
        _deliverOrdered(receiver, 0, 1, "deliverArtworks20DescendingReceiver");
    }

    function testGasDeliverArtworks20Shuffled() public {
        _deliverOrdered(alice, 0, 2, "deliverArtworks20Shuffled");
    }

    function testGasDeliverArtworks20ShuffledReceiver() public {
        _deliverOrdered(receiver, 0, 2, "deliverArtworks20ShuffledReceiver");
    }

    function testGasDeliverArtworks31Ascending() public {
        _deliverOrdered(alice, 1, 0, "deliverArtworks31Ascending");
    }

    function testGasDeliverArtworks31AscendingReceiver() public {
        _deliverOrdered(receiver, 1, 0, "deliverArtworks31AscendingReceiver");
    }

    function testGasDeliverArtworks31Descending() public {
        _deliverOrdered(alice, 1, 1, "deliverArtworks31Descending");
    }

    function testGasDeliverArtworks31DescendingReceiver() public {
        _deliverOrdered(receiver, 1, 1, "deliverArtworks31DescendingReceiver");
    }

    function testGasDeliverArtworks31Shuffled() public {
        _deliverOrdered(alice, 1, 2, "deliverArtworks31Shuffled");
    }

    function testGasDeliverArtworks31ShuffledReceiver() public {
        _deliverOrdered(receiver, 1, 2, "deliverArtworks31ShuffledReceiver");
    }

    function testGasDeliverArtworks50Descending() public {
        _deliverOrdered(alice, 2, 1, "deliverArtworks50Descending");
    }

    function testGasDeliverArtworks50DescendingReceiver() public {
        _deliverOrdered(receiver, 2, 1, "deliverArtworks50DescendingReceiver");
    }

    function testGasDeliverArtworks50Shuffled() public {
        _deliverOrdered(alice, 2, 2, "deliverArtworks50Shuffled");
    }

    function testGasDeliverArtworks50ShuffledReceiver() public {
        _deliverOrdered(receiver, 2, 2, "deliverArtworks50ShuffledReceiver");
    }

    function testGasDeliverSparseArtworks50Ascending() public {
        _deliverOrdered(alice, 3, 0, "deliverSparseArtworks50Ascending");
    }

    function testGasDeliverSparseArtworks50AscendingReceiver() public {
        _deliverOrdered(receiver, 3, 0, "deliverSparseArtworks50AscendingReceiver");
    }

    function testGasDeliverSparseArtworks50Descending() public {
        _deliverOrdered(alice, 3, 1, "deliverSparseArtworks50Descending");
    }

    function testGasDeliverSparseArtworks50DescendingReceiver() public {
        _deliverOrdered(receiver, 3, 1, "deliverSparseArtworks50DescendingReceiver");
    }

    function testGasDeliverSparseArtworks50Shuffled() public {
        _deliverOrdered(alice, 3, 2, "deliverSparseArtworks50Shuffled");
    }

    function testGasDeliverSparseArtworks50ShuffledReceiver() public {
        _deliverOrdered(receiver, 3, 2, "deliverSparseArtworks50ShuffledReceiver");
    }

    function testGasDeliverFragmentedArtworks50Ascending() public {
        _deliverOrdered(alice, 4, 0, "deliverFragmentedArtworks50Ascending");
    }

    function testGasDeliverFragmentedArtworks50AscendingReceiver() public {
        _deliverOrdered(receiver, 4, 0, "deliverFragmentedArtworks50AscendingReceiver");
    }

    function testGasDeliverFragmentedArtworks50Descending() public {
        _deliverOrdered(alice, 4, 1, "deliverFragmentedArtworks50Descending");
    }

    function testGasDeliverFragmentedArtworks50DescendingReceiver() public {
        _deliverOrdered(receiver, 4, 1, "deliverFragmentedArtworks50DescendingReceiver");
    }

    function testGasDeliverFragmentedArtworks50Shuffled() public {
        _deliverOrdered(alice, 4, 2, "deliverFragmentedArtworks50Shuffled");
    }

    function testGasDeliverFragmentedArtworks50ShuffledReceiver() public {
        _deliverOrdered(receiver, 4, 2, "deliverFragmentedArtworks50ShuffledReceiver");
    }

    function testGasDeliverInitializedArtworks50Ascending() public {
        _deliverOrdered(alice, 5, 0, "deliverInitializedArtworks50Ascending");
    }

    function testGasDeliverInitializedArtworks50AscendingReceiver() public {
        _deliverOrdered(receiver, 5, 0, "deliverInitializedArtworks50AscendingReceiver");
    }

    function testGasDeliverInitializedArtworks50Descending() public {
        _deliverOrdered(alice, 5, 1, "deliverInitializedArtworks50Descending");
    }

    function testGasDeliverInitializedArtworks50DescendingReceiver() public {
        _deliverOrdered(receiver, 5, 1, "deliverInitializedArtworks50DescendingReceiver");
    }

    function testGasDeliverInitializedArtworks50Shuffled() public {
        _deliverOrdered(alice, 5, 2, "deliverInitializedArtworks50Shuffled");
    }

    function testGasDeliverInitializedArtworks50ShuffledReceiver() public {
        _deliverOrdered(receiver, 5, 2, "deliverInitializedArtworks50ShuffledReceiver");
    }

    function testGasDeliverMixed50Descending() public {
        _deliverOrdered(alice, 6, 1, "deliverMixed50Descending");
    }

    function testGasDeliverMixed50DescendingReceiver() public {
        _deliverOrdered(receiver, 6, 1, "deliverMixed50DescendingReceiver");
    }

    function testGasDeliverMixed50Shuffled() public {
        _deliverOrdered(alice, 6, 2, "deliverMixed50Shuffled");
    }

    function testGasDeliverMixed50ShuffledReceiver() public {
        _deliverOrdered(receiver, 6, 2, "deliverMixed50ShuffledReceiver");
    }

    function testGasDeliverCrates50Descending() public {
        _deliverOrdered(alice, 7, 1, "deliverCrates50Descending");
    }

    function testGasDeliverCrates50DescendingReceiver() public {
        _deliverOrdered(receiver, 7, 1, "deliverCrates50DescendingReceiver");
    }

    function testGasDeliverCrates50Shuffled() public {
        _deliverOrdered(alice, 7, 2, "deliverCrates50Shuffled");
    }

    function testGasDeliverCrates50ShuffledReceiver() public {
        _deliverOrdered(receiver, 7, 2, "deliverCrates50ShuffledReceiver");
    }

    function testGasDeliverArtwork1Receiver() public {
        _deliverArtworks(receiver, 1, "deliverArtwork1Receiver");
    }

    function testGasDeliverCrate1Receiver() public {
        _deliverCrates(receiver, 1, "deliverCrate1Receiver");
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
        NFT111K.DeliveryQuote memory quote = _quote(alice, ids);
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

    function _unboxCrates(address wallet, uint256 quantity, bool bonus, bool separate, string memory name) internal {
        _buyCrates(wallet, quantity);
        uint256[] memory ids = _range(111112, quantity);
        if (bonus) {
            _buyWarehouses(wallet, 503);
            _buyCrates(wallet, 7);
            ids[quantity - 1] = 116666;
        }
        if (separate) {
            uint256 totalGas;
            for (uint256 i; i < ids.length; ++i) {
                vm.prank(wallet);
                token.unboxCrate(ids[i]);
                totalGas += vm.snapshotGasLastCall(name);
            }
            GasMeasurementVm(address(vm)).snapshotValue(name, totalGas);
        } else {
            vm.prank(wallet);
            token.unboxCrates(ids);
            vm.snapshotGasLastCall(name);
        }
        (,, uint256 count,,,) = token.stats();
        assertEq(count, quantity * 20 + (bonus ? 11 : 0));
        (uint8 kind, uint256 displayId, address holder) = token.getTokenInfo(count);
        assertEq(kind, 1);
        assertEq(displayId, bonus ? 111111 : quantity * 20);
        assertEq(holder, wallet);
    }

    function _metadataBatch(uint256 count, uint8 kind, string memory name) internal {
        uint8[] memory kinds = new uint8[](count);
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            kinds[i] = kind == 0 ? uint8(i % 5 + 1) : kind;
            ids[i] = kinds[i] == 3 ? 505 : kinds[i] == 2 || kinds[i] == 5 ? 5555 : 111111;
        }
        string[] memory uris = token.previewTokenURIs(kinds, ids);
        vm.snapshotGasLastCall(name);
        assertEq(uris.length, count);
        assertTrue(2 * abi.encode(uris).length + 1024 < 512 * 1024);
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
        NFT111K.DeliveryQuote memory quote = _quote(wallet, ids);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(wallet);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        vm.snapshotGasLastCall(name);
        assertTrue(token.usedDeliveryOrders(quote.orderId));
    }

    function _deliverOrdered(address wallet, uint256 scenario, uint256 order, string memory name) internal {
        uint256[] memory ids;
        if (scenario == 1) {
            uint256 crateId = _bonusCrate(wallet);
            vm.prank(wallet);
            token.unboxCrate(crateId);
            ids = _range(1, 31);
        } else if (scenario == 6) {
            _buyCrates(wallet, 27);
            vm.startPrank(wallet);
            token.unboxCrate(111112);
            token.unboxCrate(111113);
            vm.stopPrank();
            ids = new uint256[](50);
            for (uint256 i; i < 25; ++i) {
                ids[i] = i + 1;
                ids[25 + i] = 111114 + i;
            }
        } else if (scenario == 7) {
            _buyCrates(wallet, 50);
            ids = _range(111112, 50);
        } else {
            uint256 quantity = scenario == 0 ? 20 : 50;
            _artworks(wallet, scenario == 0 ? 1 : scenario == 3 ? 5 : 3);
            ids = _range(1, quantity);
            if (scenario == 3) {
                for (uint256 i; i < quantity; ++i) {
                    ids[i] = 2 * i + 1;
                }
            } else if (scenario == 4 || scenario == 5) {
                uint256 step = scenario == 4 ? 5 : 1;
                for (uint256 i = step - 1; i < quantity; i += step) {
                    vm.prank(wallet);
                    token.transferFrom(wallet, bob, ids[i]);
                    vm.prank(bob);
                    token.transferFrom(bob, wallet, ids[i]);
                }
            }
        }
        if (order == 1) {
            for (uint256 i; i < ids.length / 2; ++i) {
                uint256 last = ids.length - 1 - i;
                (ids[i], ids[last]) = (ids[last], ids[i]);
            }
        } else if (order == 2) {
            uint256 seed = 0x111c;
            for (uint256 i = ids.length - 1; i > 0; --i) {
                seed = (seed * 1664525 + 1013904223) & 0xffffffff;
                uint256 j = seed % (i + 1);
                (ids[i], ids[j]) = (ids[j], ids[i]);
            }
        }
        _deliver(wallet, ids, name);
    }

    function _claim(address wallet, uint256 crateNumber, string memory name) internal {
        uint256 crateId = crateNumber == 5555 ? _bonusCrate(wallet) : _ordinaryCrate(wallet, crateNumber);
        uint256[] memory ids = _range(crateId, 1);
        NFT111K.DeliveryQuote memory quote = _quote(wallet, ids);
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

    function _quote(address wallet, uint256[] memory ids) internal view returns (NFT111K.DeliveryQuote memory) {
        uint256[] memory receipts = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint256 displayId,) = token.getTokenInfo(ids[i]);
            receipts[i] = (kind == 1 ? 1_000_000 : 2_000_000) + displayId;
        }
        return NFT111K.DeliveryQuote(1, wallet, 0.0001 ether, block.timestamp + 300, keccak256(abi.encode(receipts)));
    }

    function _deliverySignature(uint256[] memory ids, NFT111K.DeliveryQuote memory quote)
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
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("111K"), keccak256("2"), block.chainid, address(token)));
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
