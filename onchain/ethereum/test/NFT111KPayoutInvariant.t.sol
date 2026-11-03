pragma solidity 0.8.38;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport} from "./TestSupport.sol";

contract PayoutInvariantReceiver {
    enum Mode {
        Accept,
        Revert,
        GasHeavy
    }

    address private immutable controller = msg.sender;
    address private token;
    Mode private mode;
    mapping(uint256 => uint256) private writes;
    uint256 public callbacks;
    uint256 public heavyCallbacks;

    function initialize(address token_) external {
        require(msg.sender == controller && token == address(0));
        token = token_;
    }

    function setMode(Mode mode_) external {
        require(msg.sender == controller);
        mode = mode_;
    }

    receive() external payable {
        require(msg.sender == token);
        if (mode == Mode.Revert) revert();
        if (mode == Mode.GasHeavy) {
            // Fresh slots keep every callback above the batch allowance, even after earlier successful payments.
            uint256 first = heavyCallbacks * 8;
            for (uint256 i; i < 8; ++i) {
                writes[first + i] = 1;
            }
            ++heavyCallbacks;
        }
        ++callbacks;
    }
}

contract NFT111KPayoutInvariantHandler is TestSupport {
    struct DeliveryModel {
        uint8 receiver1;
        uint16 receiver2Bps;
        uint256 received;
        uint256 paid1;
        uint256 paid2;
    }

    uint256 private constant SIGNER_KEY = 0xA11CE;
    address private constant BUYER = address(0xB00001);
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DELIVERY_TYPEHASH = keccak256(
        "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline,uint256 configId)"
    );

    NFT111K public immutable token;
    PayoutInvariantReceiver[6] private receivers;
    PayoutInvariantReceiver.Mode[6] private modes;
    uint256[4] private mintShares = [uint256(5000), 2500, 1500, 1000];
    uint256[6] private paid;
    uint256[6] private callbacks;
    uint256[6] private heavyCallbacks;
    DeliveryModel[] private configurations;
    uint256 private mintReceived;
    uint256 private cratesMinted;
    uint256 private deliveryOrders;
    uint256 public successfulPayments;
    uint256 public failedBatchPayments;
    uint256 public failedIndividualPayments;
    uint256 public expensiveBatchFailures;
    uint256 public expensiveIndividualPayments;

    constructor() {
        address[] memory mintRecipients = new address[](4);
        for (uint256 i; i < receivers.length; ++i) {
            receivers[i] = new PayoutInvariantReceiver();
            if (i < mintRecipients.length) mintRecipients[i] = address(receivers[i]);
        }
        token = new NFT111K(
            address(this),
            vm.addr(SIGNER_KEY),
            address(receivers[4]),
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            mintRecipients,
            _proceedsSharesBps(),
            new NFT111K.FreeMintAllocation[](0),
            5555
        );
        for (uint256 i; i < receivers.length; ++i) {
            receivers[i].initialize(address(token));
        }
        configurations.push(DeliveryModel(0, 0, 0, 0, 0));
        token.setSaleActive(true);
        vm.deal(BUYER, 100 ether);
        registerDeliveryConfig(0, 3333);
        receiveMintRevenue(10000);
        receiveDeliveryRevenue(1, 10000);
        setReceiverMode(0, 1);
        setReceiverMode(1, 2);
        setReceiverMode(4, 1);
        setReceiverMode(5, 2);
    }

    function setReceiverMode(uint256 receiverSeed, uint256 modeSeed) public {
        uint256 index = receiverSeed % receivers.length;
        PayoutInvariantReceiver.Mode mode = PayoutInvariantReceiver.Mode(modeSeed % 3);
        modes[index] = mode;
        receivers[index].setMode(mode);
        assertState();
    }

    function receiveMintRevenue(uint256 seed) public {
        if (cratesMinted < 5555) _buyCrate(seed % 1e12 + 1);
        assertState();
    }

    function receiveDeliveryRevenue(uint256 configSeed, uint256 feeSeed) public {
        if (cratesMinted < 5555) {
            uint256 index = configSeed % configurations.length;
            uint256[] memory ids = new uint256[](1);
            ids[0] = _buyCrate(101);
            uint256[] memory receiptIds = new uint256[](1);
            receiptIds[0] = 2000000 + cratesMinted;
            NFT111K.DeliveryQuote memory quote = NFT111K.DeliveryQuote(
                ++deliveryOrders,
                BUYER,
                feeSeed % 1e12 + 1,
                block.timestamp + 300,
                keccak256(abi.encode(receiptIds)),
                index + 1
            );
            bytes memory signature = _signDelivery(ids, quote);
            vm.prank(BUYER);
            token.redeemForDelivery{value: quote.fee}(ids, quote, signature);
            configurations[index].received += quote.fee;
        }
        assertState();
    }

    function registerDeliveryConfig(uint256 receiverSeed, uint256 shareSeed) public {
        if (configurations.length < 32) {
            uint8 first = uint8(receiverSeed % 2);
            uint16 share = uint16(shareSeed % 10000);
            address second = share == 0 ? address(0) : address(receivers[5 - first]);
            uint256 id = token.registerDeliveryConfig(address(receivers[4 + first]), second, share);
            assertEq(id, configurations.length + 1);
            configurations.push(DeliveryModel(first, share, 0, 0, 0));
        }
        assertState();
    }

    function releaseMint(uint256 seed) public {
        uint256 index = seed % mintShares.length;
        uint256 amount = _mintEntitlement(index) - paid[index];
        (bool success, bytes memory reason) =
            address(token).call{gas: 500_000}(abi.encodeCall(token.releaseMint, (address(receivers[index]))));
        _assertIndividualResult(index, amount, success, reason);
        _recordPayment(index, amount, false);
        assertState();
    }

    function releaseAllMint() public {
        token.releaseAllMint{gas: 2_000_000}();
        for (uint256 i; i < mintShares.length; ++i) {
            _recordPayment(i, _mintEntitlement(i) - paid[i], true);
        }
        assertState();
    }

    function releaseDeliveryFor(uint256 configSeed, bool secondary) public {
        uint256 index = configSeed % configurations.length;
        DeliveryModel storage config = configurations[index];
        uint256 receiver = secondary ? 5 - config.receiver1 : 4 + config.receiver1;
        uint256 amount = _deliveryPending(config, secondary);
        (bool success, bytes memory reason) =
            address(token).call{gas: 500_000}(abi.encodeCall(token.releaseDeliveryFor, (index + 1, secondary)));
        _assertIndividualResult(receiver, amount, success, reason);
        _recordDeliveryPayment(config, secondary, false);
        assertState();
    }

    function releaseDelivery() public {
        token.releaseDelivery{gas: 12_000_000}();
        for (uint256 i; i < configurations.length; ++i) {
            _recordDeliveryPayment(configurations[i], false, true);
            _recordDeliveryPayment(configurations[i], true, true);
        }
        assertState();
    }

    function assertState() public view {
        uint256 mintReleased;
        for (uint256 i; i < mintShares.length; ++i) {
            address receiver = address(receivers[i]);
            uint256 entitlement = _mintEntitlement(i);
            assertTrue(paid[i] <= entitlement);
            assertEq(token.mintRecipients(i), receiver);
            assertEq(token.mintSharesBps(receiver), mintShares[i]);
            assertEq(token.mintReleased(receiver), paid[i]);
            assertEq(token.releasableMint(receiver), entitlement - paid[i]);
            mintReleased += paid[i];
        }
        assertEq(token.totalMintReceived(), mintReceived);
        assertEq(token.totalMintReleased(), mintReleased);
        assertEq(token.allocatedCrates(), cratesMinted);
        assertEq(token.deliveryConfigCount(), configurations.length);
        uint256 deliveryReceived;
        uint256[2] memory deliveryPaid;
        for (uint256 i; i < configurations.length; ++i) {
            DeliveryModel storage config = configurations[i];
            (address first, address second, uint16 share, uint256 received, uint256 paid1, uint256 paid2) =
                token.deliveryConfigs(i + 1);
            assertEq(first, address(receivers[4 + config.receiver1]));
            assertEq(second, config.receiver2Bps == 0 ? address(0) : address(receivers[5 - config.receiver1]));
            assertEq(share, config.receiver2Bps);
            assertEq(received, config.received);
            assertEq(paid1, config.paid1);
            assertEq(paid2, config.paid2);
            uint256 entitlement2 = config.received * config.receiver2Bps / 10000;
            assertTrue(config.paid1 <= config.received - entitlement2);
            assertTrue(config.paid2 <= entitlement2);
            deliveryReceived += config.received;
            deliveryPaid[config.receiver1] += config.paid1;
            deliveryPaid[1 - config.receiver1] += config.paid2;
        }
        assertEq(paid[4], deliveryPaid[0]);
        assertEq(paid[5], deliveryPaid[1]);
        for (uint256 i; i < receivers.length; ++i) {
            assertEq(address(receivers[i]).balance, paid[i]);
            assertEq(receivers[i].callbacks(), callbacks[i]);
            assertEq(receivers[i].heavyCallbacks(), heavyCallbacks[i]);
        }
        assertEq(address(token).balance + mintReleased + paid[4] + paid[5], mintReceived + deliveryReceived);
    }

    function assertSettled() external view {
        assertState();
        for (uint256 i; i < mintShares.length; ++i) {
            assertEq(paid[i], _mintEntitlement(i));
        }
        for (uint256 i; i < configurations.length; ++i) {
            assertEq(_deliveryPending(configurations[i], false), 0);
            assertEq(_deliveryPending(configurations[i], true), 0);
        }
    }

    function _buyCrate(uint256 price) private returns (uint256 tokenId) {
        token.setPrices(price, price * 11, 0);
        vm.prank(BUYER);
        token.mintCrates{value: price}(1);
        mintReceived += price;
        tokenId = 111112 + cratesMinted++;
    }

    function _mintEntitlement(uint256 index) private view returns (uint256) {
        return mintReceived * mintShares[index] / 10000;
    }

    function _deliveryPending(DeliveryModel storage config, bool secondary) private view returns (uint256) {
        uint256 second = config.received * config.receiver2Bps / 10000;
        return secondary ? second - config.paid2 : config.received - second - config.paid1;
    }

    function _willPay(uint256 receiver, bool batch) private view returns (bool) {
        return modes[receiver] == PayoutInvariantReceiver.Mode.Accept
            || (!batch && modes[receiver] == PayoutInvariantReceiver.Mode.GasHeavy);
    }

    function _assertIndividualResult(uint256 receiver, uint256 amount, bool success, bytes memory reason) private view {
        assertTrue(success == (amount == 0 || _willPay(receiver, false)));
        if (!success) assertTrue(reason.length == 4 && bytes4(reason) == NFT111K.ProceedsPaymentFailed.selector);
    }

    function _recordPayment(uint256 receiver, uint256 amount, bool batch) private {
        if (amount == 0) return;
        if (_willPay(receiver, batch)) {
            paid[receiver] += amount;
            ++callbacks[receiver];
            ++successfulPayments;
            if (modes[receiver] == PayoutInvariantReceiver.Mode.GasHeavy) {
                ++heavyCallbacks[receiver];
                ++expensiveIndividualPayments;
            }
        } else if (batch) {
            ++failedBatchPayments;
            if (modes[receiver] == PayoutInvariantReceiver.Mode.GasHeavy) ++expensiveBatchFailures;
        } else {
            ++failedIndividualPayments;
        }
    }

    function _recordDeliveryPayment(DeliveryModel storage config, bool secondary, bool batch) private {
        uint256 receiver = secondary ? 5 - config.receiver1 : 4 + config.receiver1;
        uint256 amount = _deliveryPending(config, secondary);
        if (_willPay(receiver, batch)) {
            if (secondary) config.paid2 += amount;
            else config.paid1 += amount;
        }
        _recordPayment(receiver, amount, batch);
    }

    function _signDelivery(uint256[] memory ids, NFT111K.DeliveryQuote memory quote) private returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                DELIVERY_TYPEHASH,
                quote.wallet,
                keccak256(abi.encode(ids)),
                quote.receiptIdsHash,
                quote.orderId,
                quote.fee,
                quote.deadline,
                quote.configId
            )
        );
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("111K"), keccak256("2"), block.chainid, address(token)));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }
}

contract NFT111KPayoutInvariantTest is TestSupport {
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

    NFT111KPayoutInvariantHandler private handler;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(2_000_000_000);
        handler = new NFT111KPayoutInvariantHandler();
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
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.setReceiverMode.selector;
        selectors[1] = handler.receiveMintRevenue.selector;
        selectors[2] = handler.receiveDeliveryRevenue.selector;
        selectors[3] = handler.registerDeliveryConfig.selector;
        selectors[4] = handler.releaseMint.selector;
        selectors[5] = handler.releaseAllMint.selector;
        selectors[6] = handler.releaseDeliveryFor.selector;
        selectors[7] = handler.releaseDelivery.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariant_payoutAccountingMatchesModel() public view {
        handler.assertState();
    }

    function testPayoutFailuresNewRevenueFallbackAndRetry() public {
        handler.releaseAllMint();
        handler.releaseDelivery();
        assertEq(handler.failedBatchPayments(), 4);
        assertEq(handler.expensiveBatchFailures(), 2);

        handler.receiveMintRevenue(27000);
        handler.receiveDeliveryRevenue(1, 17002);
        handler.registerDeliveryConfig(1, 6667);
        handler.receiveDeliveryRevenue(2, 23004);
        handler.releaseMint(0);
        handler.releaseDeliveryFor(1, false);
        assertEq(handler.failedIndividualPayments(), 2);

        handler.releaseMint(1);
        handler.releaseDeliveryFor(1, true);
        assertEq(handler.expensiveIndividualPayments(), 2);

        handler.receiveMintRevenue(19000);
        handler.receiveDeliveryRevenue(1, 29000);
        handler.releaseAllMint();
        handler.releaseDelivery();
        assertEq(handler.expensiveBatchFailures(), 5);
        handler.releaseMint(1);
        handler.releaseDeliveryFor(1, true);
        assertEq(handler.expensiveIndividualPayments(), 4);

        for (uint256 i; i < 6; ++i) {
            handler.setReceiverMode(i, 0);
        }
        handler.releaseAllMint();
        handler.releaseDelivery();
        handler.assertSettled();
        uint256 payments = handler.successfulPayments();
        handler.releaseAllMint();
        handler.releaseDelivery();
        assertEq(handler.successfulPayments(), payments);
        handler.assertSettled();
    }

    function testPayoutsAcrossMaximumSharedReceiverConfigurations() public {
        for (uint256 i; i < 30; ++i) {
            handler.registerDeliveryConfig(i, i * 313 + 1);
        }
        handler.registerDeliveryConfig(0, 5000);
        assertEq(handler.token().deliveryConfigCount(), 32);
        for (uint256 i; i < 32; ++i) {
            handler.receiveDeliveryRevenue(i, 10000 + i);
        }
        handler.releaseDelivery();
        assertEq(handler.failedBatchPayments(), 63);
        handler.releaseDeliveryFor(31, false);
        assertEq(handler.expensiveIndividualPayments(), 1);
        handler.setReceiverMode(4, 0);
        handler.setReceiverMode(5, 0);
        handler.releaseDelivery();
        handler.setReceiverMode(0, 0);
        handler.setReceiverMode(1, 0);
        handler.releaseAllMint();
        handler.assertSettled();
    }
}
