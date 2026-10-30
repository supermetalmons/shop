pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport} from "./TestSupport.sol";

contract NFT111KInvariantHandler is TestSupport {
    struct ModelToken {
        uint8 kind;
        uint256 displayId;
        address holder;
        bool issued;
        bool live;
    }

    struct DeliveryAttempt {
        uint256 id;
        bool consumed;
    }

    struct ClaimAttempt {
        bytes32 id;
        bool consumed;
    }

    uint256 private constant SIGNER_KEY = 0xA11CE;
    uint256 private constant MODELED_CRATE_LIMIT = 444;
    uint256 private constant DELIVERY_FEE = 0.0001 ether;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DELIVERY_TYPEHASH = keccak256(
        "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)"
    );
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("CrateClaim(address wallet,uint256 receiptId,bytes32 claimId,uint256 deadline)");

    NFT111K public immutable token;
    address[3] private actors = [address(0xA110), address(0xB0B), address(0xCA10)];
    mapping(uint256 => ModelToken) private model;
    mapping(uint256 => uint256) private firstCrates;
    mapping(uint256 => uint256) private reliquaryFirstCrates;
    mapping(address => uint256) private discountedPurchases;
    uint256[] private touched;
    DeliveryAttempt[] private deliveryAttempts;
    ClaimAttempt[] private claimAttempts;
    uint256[] private consumedOrders;
    bytes32[] private consumedClaims;
    uint256 private allocations;
    uint256 private warehouseCount;
    uint256 private reliquaryCount;
    uint256 private artworkCount;
    uint256 private openedCrates;
    uint256 private claimedCrates;
    uint256 private redeemedArtworks;
    uint256 private mintRevenue;
    uint256 private deliveryRevenue;
    uint256[4] private mintPaid;
    uint256 private deliveryPaid;
    bool private paused;

    constructor() {
        token = new NFT111K(
            address(this),
            vm.addr(SIGNER_KEY),
            payable(address(0xFEE)),
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            _proceedsRecipients(),
            _proceedsSharesBps()
        );
        token.setSaleActive(true);
        bytes32 firstLeaf = _discountLeaf(actors[0]);
        bytes32 secondLeaf = _discountLeaf(actors[1]);
        token.setDiscountConfig(
            firstLeaf < secondLeaf
                ? keccak256(abi.encode(firstLeaf, secondLeaf))
                : keccak256(abi.encode(secondLeaf, firstLeaf)),
            3
        );
        for (uint256 i; i < actors.length; ++i) {
            vm.deal(actors[i], 100 ether);
        }
        _purchaseCrates(actors[0], 4);
        _purchaseWarehouse(actors[1]);
        _unboxWarehouse(116667);
        _unboxCrate(111112);
        _transfer(1, actors[2]);
        _deliver(1);
        _deliver(111113);
        _transfer(2000002, actors[1]);
        _claim(2000002);
        _deliver(111114);
        _purchaseWarehouse(actors[2]);
        _setPause(true);
        _deliver(2);
        _claim(2000003);
        _setPause(false);
        _purchaseReliquary(actors[0]);
        _unboxReliquary(117172);
        _purchaseReliquary(actors[1]);
    }

    function purchaseCrates(uint256 actorSeed, uint256 quantitySeed) external {
        uint256 remaining = MODELED_CRATE_LIMIT - allocations;
        if (remaining == 0) return;
        uint256 quantity = quantitySeed % 3 + 1;
        if (quantity > remaining) quantity = remaining;
        _purchaseCrates(actors[actorSeed % actors.length], quantity);
    }

    function purchaseReliquary(uint256 actorSeed) external {
        if (allocations + 111 > MODELED_CRATE_LIMIT || reliquaryCount == 30) return;
        _purchaseReliquary(actors[actorSeed % actors.length]);
    }

    function unboxReliquary(uint256 seed) external {
        uint256 id = _select(6, seed);
        if (id != 0) _unboxReliquary(id);
    }

    function purchaseWarehouse(uint256 actorSeed) external {
        if (allocations + 11 > MODELED_CRATE_LIMIT) return;
        _purchaseWarehouse(actors[actorSeed % actors.length]);
    }

    function purchaseCratesDiscounted(uint256 actorSeed, uint256 quantitySeed) external {
        uint256 index = actorSeed % 2;
        address wallet = actors[index];
        uint256 remaining = 3 - discountedPurchases[wallet];
        if (remaining > MODELED_CRATE_LIMIT - allocations) remaining = MODELED_CRATE_LIMIT - allocations;
        if (remaining == 0) return;
        uint256 quantity = quantitySeed % remaining + 1;
        uint256 first = allocations + 1;
        uint256 cost = quantity * 0.00005 ether;
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _discountLeaf(actors[1 - index]);
        vm.prank(wallet);
        token.mintCratesDiscounted{value: cost}(quantity, proof);
        discountedPurchases[wallet] += quantity;
        allocations += quantity;
        mintRevenue += cost;
        for (uint256 i; i < quantity; ++i) {
            _issue(111111 + first + i, 2, first + i, wallet);
        }
    }

    function unboxWarehouse(uint256 seed) external {
        uint256 id = _select(3, seed);
        if (id != 0) _unboxWarehouse(id);
    }

    function unboxCrate(uint256 seed) external {
        uint256 id = _select(2, seed);
        if (id != 0) _unboxCrate(id);
    }

    function unboxCrates(uint256 seed, uint256 quantitySeed) external {
        uint256 selected = _select(2, seed);
        if (selected == 0) return;
        address wallet = model[selected].holder;
        uint256[] memory candidates = new uint256[](quantitySeed % 15 + 1);
        uint256 count;
        uint256 start = seed % touched.length;
        for (uint256 i; i < touched.length && count < candidates.length; ++i) {
            uint256 id = touched[(start + i) % touched.length];
            if (model[id].live && model[id].kind == 2 && model[id].holder == wallet) candidates[count++] = id;
        }
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = candidates[i];
        }
        vm.prank(wallet);
        token.unboxCrates(ids);
        for (uint256 i; i < ids.length; ++i) {
            _recordUnbox(ids[i]);
        }
    }

    function rejectDuplicateBatch(uint256 seed) external {
        uint256 selected = _select(2, seed);
        if (selected == 0) return;
        uint256[] memory ids = new uint256[](2);
        ids[0] = selected;
        ids[1] = selected;
        vm.prank(model[selected].holder);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxCrates(ids);
    }

    function checkBatchRead(uint256 seed) external view {
        uint256 count = touched.length < 150 ? touched.length : 150;
        uint256[] memory ids = new uint256[](count);
        uint256 start = seed % touched.length;
        for (uint256 i; i < count; ++i) {
            ids[i] = touched[(start + i) % touched.length];
        }
        NFT111K.TokenInfo[] memory infos = token.getTokenInfos(ids);
        assertEq(infos.length, ids.length);
        for (uint256 i; i < ids.length; ++i) {
            ModelToken storage expected = model[ids[i]];
            assertEq(infos[i].kind, expected.live ? expected.kind : 0);
            assertEq(infos[i].displayId, expected.live ? expected.displayId : 0);
            assertEq(infos[i].holder, expected.live ? expected.holder : address(0));
        }
    }

    function transfer(uint256 tokenSeed, uint256 actorSeed) external {
        uint256 id = _select(0, tokenSeed);
        if (id != 0) _transfer(id, actors[actorSeed % actors.length]);
    }

    function deliverArtwork(uint256 seed) external {
        uint256 id = _select(1, seed);
        if (id != 0) _deliver(id);
    }

    function deliverCrate(uint256 seed) external {
        uint256 id = _select(2, seed);
        if (id != 0) _deliver(id);
    }

    function claim(uint256 seed) external {
        uint256 id = _select(5, seed);
        if (id != 0) _claim(id);
    }

    function togglePause() external {
        _setPause(!paused);
    }

    function rejectWrongOwner(uint256 seed) external {
        uint256 id = _select(2, seed);
        if (id == 0) return;
        address stranger = model[id].holder == actors[0] ? actors[1] : actors[0];
        vm.prank(stranger);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxCrate(id);
    }

    function rejectDeliveryReplay(uint256 seed) external {
        uint256 id = _select(1, seed);
        if (id == 0 || consumedOrders.length == 0) return;
        uint256[] memory ids = _one(id);
        NFT111K.DeliveryQuote memory quote = _quote(id, consumedOrders[seed % consumedOrders.length]);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(quote.wallet);
        vm.expectRevert(paused ? NFT111K.RedemptionsPaused.selector : NFT111K.AuthorizationAlreadyUsed.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
    }

    function rejectClaimReplay(uint256 seed) external {
        uint256 id = _select(5, seed);
        if (id == 0 || consumedClaims.length == 0) return;
        bytes32 claimId = consumedClaims[seed % consumedClaims.length];
        uint256 deadline = block.timestamp + 300;
        address wallet = model[id].holder;
        bytes memory signature = _claimSignature(wallet, id, claimId, deadline);
        vm.prank(wallet);
        vm.expectRevert(paused ? NFT111K.RedemptionsPaused.selector : NFT111K.AuthorizationAlreadyUsed.selector);
        token.claimCrateReceipt(id, claimId, deadline, signature);
    }

    function releaseMint(uint256 seed) external {
        uint256 index = seed % 4;
        address[] memory recipients = _proceedsRecipients();
        uint256[] memory shares = _proceedsSharesBps();
        uint256 entitlement = mintRevenue * shares[index] / 10000;
        vm.prank(actors[seed % actors.length]);
        token.releaseMint(recipients[index]);
        mintPaid[index] = entitlement;
    }

    function releaseDelivery(uint256 seed) external {
        vm.prank(actors[seed % actors.length]);
        token.releaseDelivery();
        deliveryPaid = deliveryRevenue;
    }

    function releaseAllMint(uint256 seed) external {
        uint256[] memory shares = _proceedsSharesBps();
        vm.prank(actors[seed % actors.length]);
        token.releaseAllMint();
        for (uint256 i; i < shares.length; ++i) {
            mintPaid[i] = mintRevenue * shares[i] / 10000;
        }
    }

    function assertState() external view {
        assertEq(token.allocatedCrates(), allocations);
        assertEq(token.warehousesMinted(), warehouseCount);
        assertEq(token.reliquariesMinted(), reliquaryCount);
        assertTrue(reliquaryCount <= 30);
        assertEq(token.remainingCrates(), 5555 - allocations);
        (,, uint256 minted,,,,,,,,,) = token.stats(address(0));
        assertEq(minted, artworkCount);
        uint256 released;
        address[] memory recipients = _proceedsRecipients();
        uint256[] memory shares = _proceedsSharesBps();
        for (uint256 i; i < recipients.length; ++i) {
            uint256 entitlement = mintRevenue * shares[i] / 10000;
            assertTrue(mintPaid[i] <= entitlement);
            assertEq(token.mintReleased(recipients[i]), mintPaid[i]);
            assertEq(recipients[i].balance, mintPaid[i]);
            assertEq(token.releasableMint(recipients[i]), entitlement - mintPaid[i]);
            released += mintPaid[i];
        }
        assertEq(token.totalMintReceived(), mintRevenue);
        assertEq(token.totalMintReleased(), released);
        assertEq(token.totalDeliveryReceived(), deliveryRevenue);
        assertEq(token.totalDeliveryReleased(), deliveryPaid);
        assertEq(token.deliveryPaymentReceiver().balance, deliveryPaid);
        assertEq(token.releasableDelivery(), deliveryRevenue - deliveryPaid);
        assertEq(address(token).balance + released + deliveryPaid, mintRevenue + deliveryRevenue);
        assertTrue(token.redemptionsPaused() == paused);
        assertTrue(allocations <= MODELED_CRATE_LIMIT);
        assertTrue(warehouseCount * 11 + reliquaryCount * 111 <= allocations);
        for (uint256 number = 1; number <= reliquaryCount; ++number) {
            assertEq(token.reliquaryFirstCrate(number), reliquaryFirstCrates[number]);
        }
        for (uint256 number = 1; number <= warehouseCount; ++number) {
            assertEq(token.warehouseFirstCrate(number), firstCrates[number]);
        }

        uint256[3] memory balances;
        uint256[7] memory liveKinds;
        for (uint256 i; i < touched.length; ++i) {
            uint256 id = touched[i];
            ModelToken storage expected = model[id];
            (uint8 kind, uint256 displayId, address holder) = token.getTokenInfo(id);
            if (!expected.live) {
                assertEq(kind, 0);
                assertEq(displayId, 0);
                assertEq(holder, address(0));
                continue;
            }
            assertEq(kind, expected.kind);
            assertEq(displayId, expected.displayId);
            assertEq(holder, expected.holder);
            ++liveKinds[kind];
            bool knownActor;
            for (uint256 j; j < actors.length; ++j) {
                if (holder == actors[j]) {
                    ++balances[j];
                    knownActor = true;
                }
            }
            assertTrue(knownActor);
            if (kind == 4) assertEq(id, 1000000 + displayId);
            if (kind == 5) assertEq(id, 2000000 + displayId);
        }
        uint256 liveTotal;
        for (uint256 i; i < actors.length; ++i) {
            assertEq(token.balanceOf(actors[i]), balances[i]);
            assertEq(token.discountUsed(actors[i]), discountedPurchases[actors[i]]);
            assertTrue(discountedPurchases[actors[i]] <= 3);
            liveTotal += balances[i];
        }
        assertEq(token.totalSupply(), liveTotal);
        assertEq(
            allocations,
            liveKinds[6] * 111 + liveKinds[3] * 11 + liveKinds[2] + liveKinds[5] + openedCrates + claimedCrates
        );
        assertEq(artworkCount, openedCrates * 20);
        assertEq(liveKinds[1], artworkCount - redeemedArtworks);
        assertEq(liveKinds[4], redeemedArtworks + claimedCrates * 20);
        for (uint256 i; i < deliveryAttempts.length; ++i) {
            DeliveryAttempt storage attempt = deliveryAttempts[i];
            assertTrue(token.usedDeliveryOrders(attempt.id) == attempt.consumed);
        }
        for (uint256 i; i < claimAttempts.length; ++i) {
            ClaimAttempt storage attempt = claimAttempts[i];
            assertTrue(token.usedClaims(attempt.id) == attempt.consumed);
        }
        assertTrue(consumedOrders.length >= 3);
        assertTrue(consumedClaims.length >= 1);
    }

    function _purchaseCrates(address wallet, uint256 quantity) private {
        uint256 first = allocations + 1;
        uint256 cost = quantity * 0.0001 ether;
        vm.prank(wallet);
        token.mintCrates{value: cost}(quantity);
        allocations += quantity;
        mintRevenue += cost;
        for (uint256 i; i < quantity; ++i) {
            _issue(111111 + first + i, 2, first + i, wallet);
        }
    }

    function _discountLeaf(address wallet) private pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(wallet))));
    }

    function _purchaseReliquary(address wallet) private {
        uint256 number = reliquaryCount + 1;
        uint256 first = allocations + 1;
        vm.prank(wallet);
        token.mintReliquaries{value: 0.0088 ether}(1);
        allocations += 111;
        reliquaryCount = number;
        reliquaryFirstCrates[number] = first;
        mintRevenue += 0.0088 ether;
        _issue(117171 + number, 6, number, wallet);
    }

    function _unboxReliquary(uint256 id) private {
        address wallet = model[id].holder;
        uint256 first = reliquaryFirstCrates[model[id].displayId];
        vm.prank(wallet);
        token.unboxReliquary(id);
        model[id].live = false;
        for (uint256 i; i < 111; ++i) {
            _issue(111111 + first + i, 2, first + i, wallet);
        }
    }

    function _purchaseWarehouse(address wallet) private {
        uint256 number = warehouseCount + 1;
        uint256 first = allocations + 1;
        vm.prank(wallet);
        token.mintWarehouses{value: 0.0011 ether}(1);
        allocations += 11;
        warehouseCount = number;
        firstCrates[number] = first;
        mintRevenue += 0.0011 ether;
        _issue(116666 + number, 3, number, wallet);
    }

    function _unboxWarehouse(uint256 id) private {
        address wallet = model[id].holder;
        uint256 first = firstCrates[model[id].displayId];
        vm.prank(wallet);
        token.unboxWarehouse(id);
        model[id].live = false;
        for (uint256 i; i < 11; ++i) {
            _issue(111111 + first + i, 2, first + i, wallet);
        }
    }

    function _unboxCrate(uint256 id) private {
        address wallet = model[id].holder;
        vm.prank(wallet);
        token.unboxCrate(id);
        _recordUnbox(id);
    }

    function _recordUnbox(uint256 id) private {
        address wallet = model[id].holder;
        uint256 firstToken = artworkCount + 1;
        model[id].live = false;
        ++openedCrates;
        artworkCount += 20;
        for (uint256 i; i < 20; ++i) {
            _issue(firstToken + i, 1, firstToken + i, wallet);
        }
    }

    function _transfer(uint256 id, address recipient) private {
        address wallet = model[id].holder;
        vm.prank(wallet);
        token.transferFrom(wallet, recipient, id);
        model[id].holder = recipient;
    }

    function _deliver(uint256 id) private {
        uint256 orderId = deliveryAttempts.length + 1;
        uint256[] memory ids = _one(id);
        NFT111K.DeliveryQuote memory quote = _quote(id, orderId);
        bytes memory signature = _deliverySignature(ids, quote);
        vm.prank(quote.wallet);
        if (paused) vm.expectRevert(NFT111K.RedemptionsPaused.selector);
        token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
        deliveryAttempts.push(DeliveryAttempt(orderId, !paused));
        if (paused) return;
        ModelToken storage original = model[id];
        original.live = false;
        uint256 receipt = (original.kind == 1 ? 1000000 : 2000000) + original.displayId;
        _issue(receipt, original.kind == 1 ? 4 : 5, original.displayId, original.holder);
        if (original.kind == 1) ++redeemedArtworks;
        deliveryRevenue += quote.fee;
        consumedOrders.push(orderId);
    }

    function _claim(uint256 id) private {
        bytes32 claimId = keccak256(abi.encode("invariant-claim", claimAttempts.length));
        uint256 deadline = block.timestamp + 300;
        address wallet = model[id].holder;
        bytes memory signature = _claimSignature(wallet, id, claimId, deadline);
        vm.prank(wallet);
        if (paused) vm.expectRevert(NFT111K.RedemptionsPaused.selector);
        token.claimCrateReceipt(id, claimId, deadline, signature);
        claimAttempts.push(ClaimAttempt(claimId, !paused));
        if (paused) return;
        uint256 firstDisplayId = 111111 + (model[id].displayId - 1) * 20 + 1;
        model[id].live = false;
        ++claimedCrates;
        consumedClaims.push(claimId);
        for (uint256 i; i < 20; ++i) {
            _issue(1000000 + firstDisplayId + i, 4, firstDisplayId + i, wallet);
        }
    }

    function _setPause(bool value) private {
        token.setRedemptionsPaused(value);
        paused = value;
    }

    function _issue(uint256 id, uint8 kind, uint256 displayId, address wallet) private {
        require(!model[id].issued, "model identity reused");
        model[id] = ModelToken(kind, displayId, wallet, true, true);
        touched.push(id);
    }

    function _select(uint8 kind, uint256 seed) private view returns (uint256) {
        uint256 start = seed % touched.length;
        for (uint256 i; i < touched.length; ++i) {
            uint256 id = touched[(start + i) % touched.length];
            if (model[id].live && (kind == 0 || model[id].kind == kind)) return id;
        }
        return 0;
    }

    function _quote(uint256 id, uint256 orderId) private view returns (NFT111K.DeliveryQuote memory) {
        ModelToken storage original = model[id];
        uint256 receipt = (original.kind == 1 ? 1000000 : 2000000) + original.displayId;
        return NFT111K.DeliveryQuote(
            orderId, original.holder, DELIVERY_FEE, block.timestamp + 300, keccak256(abi.encode(_one(receipt)))
        );
    }

    function _deliverySignature(uint256[] memory ids, NFT111K.DeliveryQuote memory quote)
        private
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

    function _claimSignature(address wallet, uint256 id, bytes32 claimId, uint256 deadline)
        private
        returns (bytes memory)
    {
        return _sign(keccak256(abi.encode(CLAIM_TYPEHASH, wallet, id, claimId, deadline)));
    }

    function _sign(bytes32 structHash) private returns (bytes memory) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("111K"), keccak256("2"), block.chainid, address(token)));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _one(uint256 id) private pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }
}

contract NFT111KInvariantTest is TestSupport {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    NFT111KInvariantHandler private handler;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(2_000_000_000);
        handler = new NFT111KInvariantHandler();
    }

    function targetContracts() public view returns (address[] memory contracts_) {
        contracts_ = new address[](1);
        contracts_[0] = address(handler);
    }

    function targetArtifactSelectors() public pure returns (FuzzArtifactSelector[] memory) {
        return new FuzzArtifactSelector[](0);
    }

    function targetArtifacts() public pure returns (string[] memory) {
        return new string[](0);
    }

    function excludeArtifacts() public pure returns (string[] memory) {
        return new string[](0);
    }

    function targetSenders() public pure returns (address[] memory) {
        return new address[](0);
    }

    function excludeSenders() public pure returns (address[] memory) {
        return new address[](0);
    }

    function excludeContracts() public pure returns (address[] memory) {
        return new address[](0);
    }

    function targetInterfaces() public pure returns (FuzzInterface[] memory) {
        return new FuzzInterface[](0);
    }

    function excludeSelectors() public pure returns (FuzzSelector[] memory) {
        return new FuzzSelector[](0);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](21);
        selectors[0] = handler.purchaseCrates.selector;
        selectors[1] = handler.purchaseWarehouse.selector;
        selectors[2] = handler.unboxWarehouse.selector;
        selectors[3] = handler.unboxCrate.selector;
        selectors[4] = handler.transfer.selector;
        selectors[5] = handler.deliverArtwork.selector;
        selectors[6] = handler.deliverCrate.selector;
        selectors[7] = handler.claim.selector;
        selectors[8] = handler.togglePause.selector;
        selectors[9] = handler.rejectWrongOwner.selector;
        selectors[10] = handler.rejectDeliveryReplay.selector;
        selectors[11] = handler.rejectClaimReplay.selector;
        selectors[12] = handler.unboxCrates.selector;
        selectors[13] = handler.rejectDuplicateBatch.selector;
        selectors[14] = handler.checkBatchRead.selector;
        selectors[15] = handler.purchaseCratesDiscounted.selector;
        selectors[16] = handler.releaseMint.selector;
        selectors[17] = handler.releaseDelivery.selector;
        selectors[18] = handler.purchaseReliquary.selector;
        selectors[19] = handler.unboxReliquary.selector;
        selectors[20] = handler.releaseAllMint.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariant_modelMatchesContract() public view {
        handler.assertState();
    }
}
