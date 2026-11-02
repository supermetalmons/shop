pragma solidity 0.8.38;

import {Pre111K} from "../src/Pre111K.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract Pre111KReceiver {
    Pre111K public preorder;
    bool public rejecting;
    bool public attacking;
    uint256 public callbacks;
    uint256 public blockedCalls;
    bytes public reservation;

    function configure(Pre111K preorder_, bool rejecting_, bool attacking_, bytes memory reservation_) external {
        preorder = preorder_;
        rejecting = rejecting_;
        attacking = attacking_;
        reservation = reservation_;
    }

    receive() external payable {
        require(!rejecting);
        callbacks++;
        if (attacking) {
            _blocked(abi.encodeCall(preorder.withdraw, ()), 0);
            _blocked(reservation, preorder.price());
        }
    }

    function _blocked(bytes memory data, uint256 value) private {
        (bool success, bytes memory reason) = address(preorder).call{value: value}(data);
        require(!success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        blockedCalls++;
    }
}

contract Pre111KTest is TestSupport {
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant NEXT_SIGNER_KEY = 0xB0B;
    uint256 internal constant PRICE = 0.0023 ether;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant TREASURY = address(0xCAFE);
    Pre111K internal preorder;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(2_000_000_000);
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
        preorder = new Pre111K(address(this), TREASURY, vm.addr(SIGNER_KEY), PRICE);
    }

    function _digest(address wallet, uint256 nonce, uint256 deadline, address verifyingContract, uint256 chainId)
        internal
        pure
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("pre111k"),
                keccak256("1"),
                chainId,
                verifyingContract
            )
        );
        bytes32 data = keccak256(
            abi.encode(
                keccak256("ReserveRelic(address wallet,uint256 nonce,uint256 deadline)"), wallet, nonce, deadline
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, data));
    }

    function _signature(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _authorize(Pre111K target, address wallet, uint256 nonce, uint256 deadline)
        internal
        returns (bytes memory)
    {
        return _signature(SIGNER_KEY, _digest(wallet, nonce, deadline, address(target), block.chainid));
    }

    function _reserve(Pre111K target, address wallet) internal {
        uint256 nonce = target.reservedRelics(wallet);
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(target, wallet, nonce, deadline);
        uint256 value = target.price();
        vm.prank(wallet);
        target.reserveRelic{value: value}(nonce, deadline, signature);
    }

    function testConstructorConfigurationAndDomain() public view {
        assertEq(preorder.admin(), address(this));
        assertEq(preorder.treasury(), TREASURY);
        assertEq(preorder.price(), PRICE);
        assertEq(preorder.MAX_RELICS(), 18);
        assertEq(preorder.MAX_AUTHORIZATION_LIFETIME(), 600);
        assertEq(preorder.totalReserved(), 0);
        (bytes1 fields, string memory name, string memory version, uint256 chain, address verifyingContract,,) =
            preorder.eip712Domain();
        assertEq(uint256(uint8(fields)), 15);
        assertEq(name, "pre111k");
        assertEq(version, "1");
        assertEq(chain, 11155111);
        assertEq(verifyingContract, address(preorder));
    }

    function testConstructorRejectsZeroAddressesAndPrice() public {
        address signer = vm.addr(SIGNER_KEY);
        vm.expectRevert(Pre111K.InvalidAddress.selector);
        new Pre111K(address(0), TREASURY, signer, PRICE);
        vm.expectRevert(Pre111K.InvalidAddress.selector);
        new Pre111K(address(this), address(0), signer, PRICE);
        vm.expectRevert(Pre111K.InvalidAddress.selector);
        new Pre111K(address(this), TREASURY, address(0), PRICE);
        vm.expectRevert(Pre111K.InvalidPrice.selector);
        new Pre111K(address(this), TREASURY, signer, 0);
    }

    function testReservesOneAtATimeAndEmitsWalletNonce() public {
        vm.recordLogs();
        _reserve(preorder, ALICE);
        _reserve(preorder, ALICE);
        _reserve(preorder, BOB);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        assertEq(logs[0].topics[0], keccak256("RelicReserved(address,uint256,uint256)"));
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(ALICE))));
        assertEq(logs[0].topics[2], bytes32(0));
        assertEq(abi.decode(logs[0].data, (uint256)), 1);
        assertEq(preorder.reservedRelics(ALICE), 2);
        assertEq(preorder.reservedRelics(BOB), 1);
        assertEq(preorder.totalReserved(), 3);
        assertEq(address(preorder).balance, PRICE * 3);
        assertEq(TREASURY.balance, 0);
    }

    function testEnforcesLifetimeSupplyAcrossWalletsAndWithdrawals() public {
        for (uint256 i; i < 18; ++i) {
            _reserve(preorder, i % 2 == 0 ? ALICE : BOB);
            if (i == 8) preorder.withdraw();
        }
        bytes memory signature = _authorize(preorder, ALICE, 9, block.timestamp + 600);
        vm.prank(ALICE);
        vm.expectRevert(Pre111K.SoldOut.selector);
        preorder.reserveRelic{value: PRICE}(9, block.timestamp + 600, signature);
        assertEq(preorder.totalReserved(), 18);
        assertEq(preorder.reservedRelics(ALICE), 9);
        assertEq(preorder.reservedRelics(BOB), 9);
        assertEq(address(preorder).balance + TREASURY.balance, PRICE * 18);
    }

    function testRejectsWrongPaymentIncludingAttemptedBatch() public {
        bytes memory signature = _authorize(preorder, ALICE, 0, block.timestamp + 600);
        uint256[4] memory values = [uint256(0), PRICE - 1, PRICE + 1, PRICE * 2];
        for (uint256 i; i < values.length; ++i) {
            vm.prank(ALICE);
            vm.expectRevert(Pre111K.WrongPayment.selector);
            preorder.reserveRelic{value: values[i]}(0, block.timestamp + 600, signature);
        }
        assertEq(preorder.totalReserved(), 0);
        assertEq(preorder.reservedRelics(ALICE), 0);
        assertEq(address(preorder).balance, 0);
        _reserve(preorder, ALICE);
    }

    function testMainnetPriceIsExact() public {
        vm.chainId(1);
        Pre111K mainnet = new Pre111K(address(this), TREASURY, vm.addr(SIGNER_KEY), 2.3 ether);
        bytes memory signature = _authorize(mainnet, ALICE, 0, block.timestamp + 600);
        vm.prank(ALICE);
        vm.expectRevert(Pre111K.WrongPayment.selector);
        mainnet.reserveRelic{value: PRICE}(0, block.timestamp + 600, signature);
        _reserve(mainnet, ALICE);
        assertEq(address(mainnet).balance, 2.3 ether);
    }

    function testRejectsSignatureReplayAndFutureNonce() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(preorder, ALICE, 0, deadline);
        _reserve(preorder, ALICE);
        vm.prank(ALICE);
        vm.expectRevert(Pre111K.InvalidNonce.selector);
        preorder.reserveRelic{value: PRICE}(0, deadline, signature);
        signature = _authorize(preorder, ALICE, 2, deadline);
        vm.prank(ALICE);
        vm.expectRevert(Pre111K.InvalidNonce.selector);
        preorder.reserveRelic{value: PRICE}(2, deadline, signature);
        assertEq(preorder.reservedRelics(ALICE), 1);
        _reserve(preorder, ALICE);
    }

    function testRejectsMissingMalformedAndWrongSigner() public {
        uint256 deadline = block.timestamp + 600;
        vm.prank(ALICE);
        vm.expectRevert();
        preorder.reserveRelic{value: PRICE}(0, deadline, bytes(""));
        vm.prank(ALICE);
        vm.expectRevert();
        preorder.reserveRelic{value: PRICE}(0, deadline, new bytes(65));
        bytes memory signature =
            _signature(NEXT_SIGNER_KEY, _digest(ALICE, 0, deadline, address(preorder), block.chainid));
        vm.prank(ALICE);
        vm.expectRevert(Pre111K.InvalidAuthorization.selector);
        preorder.reserveRelic{value: PRICE}(0, deadline, signature);
        assertEq(preorder.totalReserved(), 0);
    }

    function testRejectsAnotherWalletChainContractOrDeadline() public {
        uint256 deadline = block.timestamp + 600;
        bytes32[4] memory digests = [
            _digest(BOB, 0, deadline, address(preorder), block.chainid),
            _digest(ALICE, 0, deadline, address(preorder), 1),
            _digest(ALICE, 0, deadline, address(0x1111), block.chainid),
            _digest(ALICE, 0, deadline - 1, address(preorder), block.chainid)
        ];
        for (uint256 i; i < digests.length; ++i) {
            bytes memory signature = _signature(SIGNER_KEY, digests[i]);
            vm.prank(ALICE);
            vm.expectRevert(Pre111K.InvalidAuthorization.selector);
            preorder.reserveRelic{value: PRICE}(0, deadline, signature);
        }
        assertEq(preorder.totalReserved(), 0);
    }

    function testDeadlineBoundariesAndExpiredAuthorization() public {
        uint256[4] memory deadlines = [block.timestamp - 1, block.timestamp, block.timestamp + 601, type(uint256).max];
        for (uint256 i; i < deadlines.length; ++i) {
            bytes memory invalidSignature = _authorize(preorder, ALICE, 0, deadlines[i]);
            vm.prank(ALICE);
            vm.expectRevert(Pre111K.InvalidDeadline.selector);
            preorder.reserveRelic{value: PRICE}(0, deadlines[i], invalidSignature);
        }
        uint256 deadline = block.timestamp + 1;
        bytes memory signature = _authorize(preorder, ALICE, 0, deadline);
        vm.prank(ALICE);
        preorder.reserveRelic{value: PRICE}(0, deadline, signature);
        signature = _authorize(preorder, ALICE, 1, deadline);
        vm.warp(deadline);
        vm.prank(ALICE);
        vm.expectRevert(Pre111K.InvalidDeadline.selector);
        preorder.reserveRelic{value: PRICE}(1, deadline, signature);
        _reserve(preorder, ALICE);
    }

    function testOnlyFixedAdminCanRotateSignerAndOldSignaturesStopWorking() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory original = _authorize(preorder, ALICE, 0, deadline);
        address nextSigner = vm.addr(NEXT_SIGNER_KEY);
        vm.prank(BOB);
        vm.expectRevert(Pre111K.Unauthorized.selector);
        preorder.setQuoteSigner(nextSigner);
        vm.expectRevert(Pre111K.InvalidAddress.selector);
        preorder.setQuoteSigner(address(0));
        vm.expectRevert(Pre111K.InvalidAddress.selector);
        preorder.setQuoteSigner(address(preorder));
        preorder.setQuoteSigner(nextSigner);
        assertEq(preorder.quoteSigner(), nextSigner);
        assertEq(preorder.admin(), address(this));
        vm.prank(ALICE);
        vm.expectRevert(Pre111K.InvalidAuthorization.selector);
        preorder.reserveRelic{value: PRICE}(0, deadline, original);
        bytes memory signature =
            _signature(NEXT_SIGNER_KEY, _digest(ALICE, 0, deadline, address(preorder), block.chainid));
        vm.prank(ALICE);
        preorder.reserveRelic{value: PRICE}(0, deadline, signature);
    }

    function testAnyoneWithdrawsEverythingOnlyToTreasuryIncludingForcedBalance() public {
        _reserve(preorder, ALICE);
        vm.deal(address(preorder), PRICE + 17);
        uint256 bobBefore = BOB.balance;
        vm.prank(BOB);
        preorder.withdraw();
        assertEq(TREASURY.balance, PRICE + 17);
        assertEq(BOB.balance, bobBefore);
        assertEq(address(preorder).balance, 0);
        assertEq(preorder.totalReserved(), 1);
        preorder.withdraw();
        _reserve(preorder, BOB);
        preorder.withdraw();
        assertEq(TREASURY.balance, PRICE * 2 + 17);
        assertEq(preorder.totalReserved(), 2);
    }

    function testWithdrawForwardsEnoughGasAndBlocksReentrantCalls() public {
        Pre111KReceiver receiver = new Pre111KReceiver();
        Pre111K target = new Pre111K(address(this), address(receiver), vm.addr(SIGNER_KEY), PRICE);
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(target, address(receiver), 0, deadline);
        receiver.configure(target, false, true, abi.encodeCall(target.reserveRelic, (0, deadline, signature)));
        _reserve(target, ALICE);
        target.withdraw();
        assertEq(receiver.callbacks(), 1);
        assertEq(receiver.blockedCalls(), 2);
        assertEq(address(receiver).balance, PRICE);
        assertEq(address(target).balance, 0);
        assertEq(target.totalReserved(), 1);
        assertEq(target.reservedRelics(address(receiver)), 0);
    }

    function testRejectingWithdrawalRetainsFundsAndCanBeRetried() public {
        Pre111KReceiver receiver = new Pre111KReceiver();
        Pre111K target = new Pre111K(address(this), address(receiver), vm.addr(SIGNER_KEY), PRICE);
        receiver.configure(target, true, false, bytes(""));
        _reserve(target, ALICE);
        vm.expectRevert(Pre111K.WithdrawalFailed.selector);
        target.withdraw();
        assertEq(address(target).balance, PRICE);
        assertEq(address(receiver).balance, 0);
        assertEq(target.totalReserved(), 1);
        receiver.configure(target, false, false, bytes(""));
        target.withdraw();
        assertEq(address(target).balance, 0);
        assertEq(address(receiver).balance, PRICE);
    }

    function testOrdinaryTransfersAndUnknownCallsRevert() public {
        vm.prank(ALICE);
        (bool success,) = address(preorder).call{value: PRICE}("");
        assertFalse(success);
        vm.prank(ALICE);
        (success,) = address(preorder).call{value: PRICE}(hex"deadbeef");
        assertFalse(success);
        assertEq(address(preorder).balance, 0);
        assertEq(preorder.totalReserved(), 0);
    }

    function testFuzzReservationsConserveCountAndFunds(uint256 seed, uint8 count_) public {
        uint256 count = uint256(count_) % 19;
        uint256 aliceCount;
        for (uint256 i; i < count; ++i) {
            bool alice = (seed >> i) & 1 == 0;
            _reserve(preorder, alice ? ALICE : BOB);
            if (alice) aliceCount++;
            if ((seed >> (i + 18)) & 1 == 1) preorder.withdraw();
        }
        assertEq(preorder.totalReserved(), count);
        assertEq(preorder.reservedRelics(ALICE), aliceCount);
        assertEq(preorder.reservedRelics(BOB), count - aliceCount);
        assertEq(TREASURY.balance + address(preorder).balance, count * PRICE);
    }
}
