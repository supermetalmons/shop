pragma solidity 0.8.38;

import {NFT111K} from "../src/NFT111K.sol";

interface RegisteredVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function deal(address account, uint256 balance) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata reason) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract RegisteredReceiver {
    NFT111K public token;
    uint256 public mode;
    uint256 public callbacks;
    uint256 public blockedCalls;
    uint256[8] public writes;

    function configure(NFT111K token_, uint256 mode_) external {
        token = token_;
        mode = mode_;
    }

    receive() external payable {
        if (mode == 1) revert();
        if (mode == 2) {
            assembly {
                for {} 1 {} {}
            }
        }
        if (mode == 3) {
            for (uint256 i; i < writes.length; ++i) {
                writes[i]++;
            }
        }
        if (mode == 4) {
            _blocked(abi.encodeCall(token.releaseDelivery, ()));
            _blocked(abi.encodeCall(token.releaseDeliveryFor, (1, false)));
            _blocked(abi.encodeCall(token.releaseMint, (token.mintRecipients(0))));
        }
        callbacks++;
    }

    function _blocked(bytes memory data) private {
        (bool success, bytes memory reason) = address(token).call(data);
        require(!success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        blockedCalls++;
    }
}

contract NFT111KRegisteredDeliveryTest {
    RegisteredVm private constant vm = RegisteredVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SIGNER_KEY = 0xA11CE;
    address private constant BUYER = address(0xA110);
    address private constant FIRST = address(0xD001);
    address private constant SECOND = address(0xD002);
    address private constant THIRD = address(0xD003);
    address private constant MINT1 = address(0xA001);
    address private constant MINT2 = address(0xA002);
    NFT111K private token;
    uint256 private nextOrder = 1;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(2_000_000_000);
        token = _deploy(MINT1, FIRST);
    }

    function testConstructorSeedsSingleConfigOneAtomically() public view {
        _eq(token.deliveryConfigCount(), 1);
        NFT111K.DeliveryConfig memory seeded = _config(1);
        require(seeded.receiver1 == FIRST && seeded.receiver2 == address(0));
        _eq(seeded.receiver2Bps, 0);
        _eq(seeded.totalReceived + seeded.released1 + seeded.released2, 0);
        _eq(token.totalSupply(), 0);
    }

    function testInitialConfigReceivesTheEntireFeeWithoutRegistration() public {
        _redeem(1, 101);
        _eq(token.deliveryConfigCount(), 1);
        _eq(_config(1).totalReceived, 101);
        token.releaseDelivery();
        _eq(FIRST.balance, 101);
        _eq(SECOND.balance, 0);
        _assertAccounting(101, 101);
    }

    function testOwnerRegistersImmutableOneBasedConfigsAndTransfersAuthority() public {
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", BUYER));
        token.registerDeliveryConfig(FIRST, address(0), 0);
        _eq(token.deliveryConfigCount(), 1);
        _eq(token.registerDeliveryConfig(FIRST, address(0), 0), 2);
        _eq(token.registerDeliveryConfig(FIRST, SECOND, 2500), 3);
        token.transferOwnership(BUYER);
        vm.prank(BUYER);
        token.acceptOwnership();
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", address(this)));
        token.registerDeliveryConfig(SECOND, address(0), 0);
        vm.prank(BUYER);
        _eq(token.registerDeliveryConfig(SECOND, THIRD, 3333), 4);
        NFT111K.DeliveryConfig memory config = _config(3);
        require(config.receiver1 == FIRST && config.receiver2 == SECOND);
        _eq(config.receiver2Bps, 2500);
        _eq(config.totalReceived + config.released1 + config.released2, 0);
    }

    function testRegistrationRejectsInvalidAddressesAndNoncanonicalSplits() public {
        _invalidConfig(address(0), address(0), 0, NFT111K.InvalidAddress.selector);
        _invalidConfig(address(token), address(0), 0, NFT111K.InvalidAddress.selector);
        _invalidConfig(MINT1, address(0), 0, NFT111K.InvalidAddress.selector);
        _invalidConfig(FIRST, address(token), 2500, NFT111K.InvalidAddress.selector);
        _invalidConfig(FIRST, MINT2, 2500, NFT111K.InvalidAddress.selector);
        _invalidConfig(FIRST, FIRST, 2500, NFT111K.InvalidDeliverySplit.selector);
        _invalidConfig(FIRST, address(0), 1, NFT111K.InvalidDeliverySplit.selector);
        _invalidConfig(FIRST, SECOND, 0, NFT111K.InvalidDeliverySplit.selector);
        _invalidConfig(FIRST, SECOND, 10_000, NFT111K.InvalidDeliverySplit.selector);
        _invalidConfig(FIRST, SECOND, type(uint16).max, NFT111K.InvalidDeliverySplit.selector);
        _eq(token.registerDeliveryConfig(FIRST, SECOND, 1), 2);
        _eq(token.registerDeliveryConfig(FIRST, SECOND, 9999), 3);
    }

    function testQuoteBindsConfigIdAndRejectsUnregisteredIdsAndReplay() public {
        uint256 first = token.registerDeliveryConfig(FIRST, address(0), 0);
        uint256 second = token.registerDeliveryConfig(SECOND, address(0), 0);
        uint256 id = _mintCrate(100);
        NFT111K.DeliveryQuote memory quote = _quote(id, first, 100);
        bytes memory signature = _signature(id, quote);
        quote.configId = second;
        _expectRedeemRevert(id, quote, signature, NFT111K.InvalidAuthorization.selector);
        quote.configId = 0;
        _expectRedeemRevert(id, quote, _signature(id, quote), NFT111K.InvalidDeliveryConfig.selector);
        quote.configId = second + 1;
        _expectRedeemRevert(id, quote, _signature(id, quote), NFT111K.InvalidDeliveryConfig.selector);
        quote.configId = first;
        vm.prank(BUYER);
        token.redeemForDelivery{value: quote.fee}(_one(id), quote, signature);
        _expectRedeemRevert(id, quote, signature, NFT111K.AuthorizationAlreadyUsed.selector);
        _eq(_config(first).totalReceived, 100);
        _eq(_config(second).totalReceived, 0);
        vm.expectRevert(NFT111K.InvalidDeliveryConfig.selector);
        token.releaseDeliveryFor(0, false);
        vm.expectRevert(NFT111K.InvalidDeliveryConfig.selector);
        token.releaseDeliveryFor(second + 1, true);
    }

    function testExpiredQuoteAndSignerRotationDoNotAccrue() public {
        uint256 configId = token.registerDeliveryConfig(FIRST, SECOND, 2500);
        uint256 id = _mintCrate(100);
        NFT111K.DeliveryQuote memory quote = _quote(id, configId, 100);
        bytes memory signature = _signature(id, quote);
        token.setQuoteSigner(vm.addr(0xBEEF));
        _expectRedeemRevert(id, quote, signature, NFT111K.InvalidAuthorization.selector);
        token.setQuoteSigner(vm.addr(SIGNER_KEY));
        vm.warp(quote.deadline + 1);
        _expectRedeemRevert(id, quote, signature, NFT111K.AuthorizationExpired.selector);
        require(!token.usedDeliveryOrders(quote.orderId));
        _eq(_config(configId).totalReceived, 0);
    }

    function testOnePermissionlessWithdrawalPaysAllSingleAndSplitConfigs() public {
        uint256 single = token.registerDeliveryConfig(FIRST, address(0), 0);
        uint256 split = token.registerDeliveryConfig(FIRST, SECOND, 2500);
        uint256 other = token.registerDeliveryConfig(SECOND, THIRD, 3333);
        _redeem(single, 100);
        _redeem(split, 101);
        _redeem(other, 8);
        _eq(FIRST.balance + SECOND.balance + THIRD.balance, 0);
        vm.prank(BUYER);
        token.releaseDelivery();
        _eq(FIRST.balance, 176);
        _eq(SECOND.balance, 31);
        _eq(THIRD.balance, 2);
        _assertAccounting(209, 209);
        _redeem(split, 3);
        token.releaseDelivery();
        _eq(FIRST.balance, 178);
        _eq(SECOND.balance, 32);
        _eq(THIRD.balance, 2);
        _assertAccounting(212, 212);
        token.releaseDelivery();
        _assertAccounting(212, 212);
    }

    function testLifetimeRoundingCarriesFractionsAcrossWithdrawals() public {
        uint256 id = token.registerDeliveryConfig(FIRST, SECOND, 2500);
        for (uint256 i = 1; i <= 4; ++i) {
            _redeem(id, 1);
            token.releaseDelivery();
            _eq(SECOND.balance, i / 4);
            _eq(FIRST.balance, i - i / 4);
            _assertAccounting(i, i);
        }
        _eq(FIRST.balance, 3);
        _eq(SECOND.balance, 1);
    }

    function testFuzzCumulativeSplitsConserveEveryWeiAfterPartialWithdrawals(
        uint96 firstFee,
        uint96 secondFee,
        uint16 bps
    ) public {
        uint256 share = uint256(bps) % 9999 + 1;
        uint256 configId = token.registerDeliveryConfig(FIRST, SECOND, uint16(share));
        uint256 first = uint256(firstFee) + 1;
        uint256 second = uint256(secondFee) + 1;
        _redeem(configId, first);
        token.releaseDeliveryFor(configId, true);
        _eq(SECOND.balance, first * share / 10_000);
        _eq(FIRST.balance, 0);
        _redeem(configId, second);
        token.releaseDelivery();
        uint256 total = first + second;
        _eq(SECOND.balance, total * share / 10_000);
        _eq(FIRST.balance, total - total * share / 10_000);
        _assertAccounting(total, total);
    }

    function testMaximumUint256CumulativeRevenueDoesNotOverflow() public {
        uint256 configId = token.registerDeliveryConfig(FIRST, SECOND, 9999);
        uint256 total = type(uint256).max;
        _redeem(configId, total);
        uint256 secondary = (total / 10_000) * 9999 + ((total % 10_000) * 9999) / 10_000;
        token.releaseDelivery();
        _eq(FIRST.balance, total - secondary);
        _eq(SECOND.balance, secondary);
        _assertAccounting(total, total);
    }

    function testRejectedReceiverPreservesCreditAndDoesNotBlockOtherRoutes() public {
        RegisteredReceiver rejecting = new RegisteredReceiver();
        rejecting.configure(token, 1);
        uint256 split = token.registerDeliveryConfig(address(rejecting), SECOND, 2500);
        uint256 single = token.registerDeliveryConfig(THIRD, address(0), 0);
        _redeem(split, 100);
        _redeem(single, 9);
        token.releaseDelivery();
        _eq(_config(split).released1, 0);
        _eq(_config(split).released2, 25);
        _eq(SECOND.balance, 25);
        _eq(THIRD.balance, 9);
        _assertAccounting(109, 34);
        vm.expectRevert(NFT111K.ProceedsPaymentFailed.selector);
        token.releaseDeliveryFor(split, false);
        _assertAccounting(109, 34);
        rejecting.configure(token, 0);
        token.releaseDeliveryFor(split, false);
        _eq(address(rejecting).balance, 75);
        _assertAccounting(109, 109);
    }

    function testExpensiveReceiverCanWithdrawUsingNormalGasFallback() public {
        RegisteredReceiver expensive = new RegisteredReceiver();
        expensive.configure(token, 3);
        uint256 configId = token.registerDeliveryConfig(FIRST, address(expensive), 5000);
        _redeem(configId, 100);
        token.releaseDelivery();
        _eq(FIRST.balance, 50);
        _eq(_config(configId).released2, 0);
        _eq(expensive.writes(0), 0);
        vm.prank(BUYER);
        token.releaseDeliveryFor(configId, true);
        _eq(address(expensive).balance, 50);
        for (uint256 i; i < 8; ++i) {
            _eq(expensive.writes(i), 1);
        }
        _assertAccounting(100, 100);
    }

    function testBatchAndIndividualWithdrawalsRejectReentrancy() public {
        RegisteredReceiver receiver = new RegisteredReceiver();
        receiver.configure(token, 4);
        uint256 configId = token.registerDeliveryConfig(address(receiver), SECOND, 2500);
        _redeem(configId, 100);
        token.releaseDelivery();
        _eq(receiver.callbacks(), 1);
        _eq(receiver.blockedCalls(), 3);
        _redeem(configId, 100);
        token.releaseDeliveryFor(configId, false);
        _eq(receiver.callbacks(), 2);
        _eq(receiver.blockedCalls(), 6);
        token.releaseDelivery();
        _assertAccounting(200, 200);
    }

    function testConfigCapBoundsWithdrawalsEvenWhenEveryReceiverBurnsGas() public {
        RegisteredReceiver first = new RegisteredReceiver();
        RegisteredReceiver second = new RegisteredReceiver();
        token = _deploy(MINT1, address(first));
        first.configure(token, 2);
        second.configure(token, 2);
        _redeem(1, 100);
        for (uint256 i = 2; i <= 32; ++i) {
            _eq(token.registerDeliveryConfig(address(first), address(second), 5000), i);
            _redeem(i, 100);
        }
        vm.expectRevert(NFT111K.InvalidDeliveryConfig.selector);
        token.registerDeliveryConfig(FIRST, address(0), 0);
        _eq(token.deliveryConfigCount(), 32);
        uint256 gasBefore = gasleft();
        token.releaseDelivery();
        require(gasBefore - gasleft() < 9_000_000);
        for (uint256 i = 1; i <= 32; ++i) {
            NFT111K.DeliveryConfig memory config = _config(i);
            _eq(config.totalReceived, 100);
            _eq(config.released1 + config.released2, 0);
        }
        _assertAccounting(3200, 0);
    }

    function testUnderfundedBatchRevertsWithoutChangingCredits() public {
        uint256 configId = token.registerDeliveryConfig(FIRST, SECOND, 2500);
        _redeem(configId, 100);
        (bool success, bytes memory reason) =
            address(token).call{gas: 100_000}(abi.encodeCall(token.releaseDelivery, ()));
        require(!success && bytes4(reason) == NFT111K.InsufficientMintPayoutGas.selector);
        _eq(FIRST.balance + SECOND.balance, 0);
        _assertAccounting(100, 0);
        token.releaseDelivery();
        _assertAccounting(100, 100);
    }

    function testFreeRedemptionsAndEmptyWithdrawalsHaveNoProceeds() public {
        token.releaseDelivery();
        uint256 single = token.registerDeliveryConfig(FIRST, address(0), 0);
        uint256 split = token.registerDeliveryConfig(FIRST, SECOND, 2500);
        _redeem(single, 0);
        _redeem(split, 0);
        token.releaseDelivery();
        token.releaseDeliveryFor(single, true);
        _eq(FIRST.balance + SECOND.balance, 0);
        _assertAccounting(0, 0);
    }

    function testMintProceedsRemainSeparateAndSharedGasHelperPreservesFallback() public {
        RegisteredReceiver expensive = new RegisteredReceiver();
        token = _deploy(address(expensive), FIRST);
        expensive.configure(token, 3);
        token.setPrices(100, 100, 100);
        uint256 configId = token.registerDeliveryConfig(FIRST, SECOND, 2500);
        _redeem(configId, 40);
        token.releaseDelivery();
        _eq(FIRST.balance, 30);
        _eq(SECOND.balance, 10);
        _eq(token.totalMintReceived(), 100);
        _eq(address(token).balance, 100);
        token.releaseAllMint();
        _eq(token.mintReleased(address(expensive)), 0);
        _eq(MINT2.balance, 50);
        token.releaseMint(address(expensive));
        _eq(address(expensive).balance, 50);
        _eq(address(token).balance, 0);
        _assertAccounting(40, 40);
    }

    function testRegistrationRedemptionAndFailureEventsIncludeConfigId() public {
        RegisteredReceiver rejecting = new RegisteredReceiver();
        rejecting.configure(token, 1);
        vm.recordLogs();
        uint256 configId = token.registerDeliveryConfig(FIRST, address(rejecting), 2500);
        RegisteredVm.Log[] memory logs = vm.getRecordedLogs();
        _eq(logs.length, 1);
        require(logs[0].topics[0] == keccak256("DeliveryConfigRegistered(uint256,address,address,uint16)"));
        require(logs[0].topics[1] == bytes32(configId));
        vm.recordLogs();
        _redeem(configId, 100);
        logs = vm.getRecordedLogs();
        RegisteredVm.Log memory delivery = logs[logs.length - 1];
        require(
            delivery.topics[0] == keccak256("DeliveryRedeemed(uint256,address,uint256,uint256[],uint256[],uint256)")
        );
        (,,, uint256 recordedId) = abi.decode(delivery.data, (uint256, uint256[], uint256[], uint256));
        _eq(recordedId, configId);
        vm.recordLogs();
        token.releaseDelivery();
        logs = vm.getRecordedLogs();
        _eq(logs.length, 2);
        require(logs[0].topics[0] == keccak256("DeliveryProceedsReleased(uint256,address,uint256)"));
        require(logs[1].topics[0] == keccak256("DeliveryProceedsReleaseFailed(uint256,address,uint256)"));
        require(logs[0].topics[1] == bytes32(configId) && logs[1].topics[1] == bytes32(configId));
        _eq(abi.decode(logs[0].data, (uint256)), 75);
        _eq(abi.decode(logs[1].data, (uint256)), 25);
    }

    function testMaximumSupportedConstructorAndRuntimeFitEvmLimits() public {
        address[] memory recipients = new address[](32);
        uint256[] memory shares = new uint256[](32);
        NFT111K.FreeMintAllocation[] memory allocations = new NFT111K.FreeMintAllocation[](32);
        bytes memory deploymentId = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            deploymentId[i] = "a";
        }
        string memory uri = string.concat("https://cdn.mons.shop/111k-sepolia/", string(deploymentId), "/");
        for (uint256 i; i < 32; ++i) {
            recipients[i] = address(uint160(0xC00001 + i));
            shares[i] = i < 16 ? 313 : 312;
            allocations[i] = NFT111K.FreeMintAllocation(address(uint160(0xD00001 + i)), 5555, 505, 18);
        }
        bytes memory arguments = abi.encode(
            address(this), vm.addr(SIGNER_KEY), FIRST, uri, bytes32(0), recipients, shares, allocations, 5555
        );
        _eq(arguments.length, 6688);
        require(type(NFT111K).creationCode.length + arguments.length <= 49_152);
        NFT111K maximum = new NFT111K(
            address(this), vm.addr(SIGNER_KEY), FIRST, uri, bytes32(0), recipients, shares, allocations, 5555
        );
        require(address(maximum).code.length <= 24_576);
        _eq(maximum.mintRecipientCount(), 32);
    }

    function _deploy(address mint1, address initialReceiver) private returns (NFT111K deployed) {
        address[] memory recipients = new address[](2);
        recipients[0] = mint1;
        recipients[1] = MINT2;
        uint256[] memory shares = new uint256[](2);
        shares[0] = 5000;
        shares[1] = 5000;
        deployed = new NFT111K(
            address(this),
            vm.addr(SIGNER_KEY),
            initialReceiver,
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            recipients,
            shares,
            new NFT111K.FreeMintAllocation[](0),
            5555
        );
        deployed.setSaleActive(true);
        deployed.setPrices(0, 0, 0);
    }

    function _mintCrate(uint256 fee) private returns (uint256 id) {
        id = 111112 + token.allocatedCrates();
        uint256 price = token.cratePrice();
        vm.deal(BUYER, fee + price);
        vm.prank(BUYER);
        token.mintCrates{value: price}(1);
    }

    function _redeem(uint256 configId, uint256 fee) private {
        uint256 id = _mintCrate(fee);
        NFT111K.DeliveryQuote memory quote = _quote(id, configId, fee);
        bytes memory signature = _signature(id, quote);
        vm.prank(BUYER);
        token.redeemForDelivery{value: fee}(_one(id), quote, signature);
    }

    function _quote(uint256 id, uint256 configId, uint256 fee) private returns (NFT111K.DeliveryQuote memory) {
        return NFT111K.DeliveryQuote(
            nextOrder++,
            BUYER,
            fee,
            block.timestamp + 300,
            keccak256(abi.encode(_one(2_000_001 + id - 111112))),
            configId
        );
    }

    function _signature(uint256 id, NFT111K.DeliveryQuote memory quote) private returns (bytes memory) {
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
                keccak256(abi.encode(_one(id))),
                quote.receiptIdsHash,
                quote.orderId,
                quote.fee,
                quote.deadline,
                quote.configId
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _expectRedeemRevert(
        uint256 id,
        NFT111K.DeliveryQuote memory quote,
        bytes memory signature,
        bytes4 selector
    ) private {
        vm.deal(BUYER, quote.fee);
        vm.prank(BUYER);
        vm.expectRevert(selector);
        token.redeemForDelivery{value: quote.fee}(_one(id), quote, signature);
    }

    function _invalidConfig(address first, address second, uint16 share, bytes4 selector) private {
        vm.expectRevert(selector);
        token.registerDeliveryConfig(first, second, share);
        _eq(token.deliveryConfigCount(), 1);
    }

    function _config(uint256 id) private view returns (NFT111K.DeliveryConfig memory config) {
        (
            config.receiver1,
            config.receiver2,
            config.receiver2Bps,
            config.totalReceived,
            config.released1,
            config.released2
        ) = token.deliveryConfigs(id);
    }

    function _assertAccounting(uint256 expectedReceived, uint256 expectedReleased) private view {
        uint256 received;
        uint256 released;
        for (uint256 id = 1; id <= token.deliveryConfigCount(); ++id) {
            NFT111K.DeliveryConfig memory config = _config(id);
            received += config.totalReceived;
            released += config.released1 + config.released2;
        }
        _eq(received, expectedReceived);
        _eq(released, expectedReleased);
        _eq(address(token).balance, received - released + token.totalMintReceived() - token.totalMintReleased());
    }

    function _one(uint256 value) private pure returns (uint256[] memory values) {
        values = new uint256[](1);
        values[0] = value;
    }

    function _eq(uint256 actual, uint256 expected) private pure {
        require(actual == expected, "uint mismatch");
    }
}
