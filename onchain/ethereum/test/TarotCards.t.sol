pragma solidity 0.8.38;

import {TarotCards} from "../src/TarotCards.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract TarotReceiver is IERC721Receiver {
    TarotCards public token;
    uint256 public rejectingTokenId;
    bytes public reentrantCall;
    uint256 public callbacks;
    uint256 public blockedCalls;

    function configure(TarotCards token_, uint256 rejectingTokenId_, bytes memory reentrantCall_) external {
        token = token_;
        rejectingTokenId = rejectingTokenId_;
        reentrantCall = reentrantCall_;
    }

    function claim(uint256 tokenId, uint256 deadline, bytes calldata signature) external {
        token.claim(tokenId, deadline, signature);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(token));
        require(tokenId != rejectingTokenId);
        callbacks++;
        if (reentrantCall.length > 0) {
            (bool success, bytes memory reason) = address(token).call(reentrantCall);
            require(!success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")));
            blockedCalls++;
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract TarotCardsTest is TestSupport {
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant NEXT_SIGNER_KEY = 0xB0B;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    string internal constant BASE_URI = "https://cdn.mons.shop/tarot-sepolia/v1/";
    TarotCards internal token;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(2_000_000_000);
        token = new TarotCards(address(this), vm.addr(SIGNER_KEY), BASE_URI);
    }

    function _digest(address wallet, uint256 tokenId, uint256 deadline, address contractAddress, uint256 chainId)
        internal
        pure
        returns (bytes32)
    {
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Tarot Cards"), keccak256("1"), chainId, contractAddress
        ));
        bytes32 data = keccak256(abi.encode(
            keccak256("TarotClaim(address wallet,uint256 tokenId,uint256 deadline)"), wallet, tokenId, deadline
        ));
        return keccak256(abi.encodePacked(hex"1901", domain, data));
    }

    function _sign(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _authorize(address wallet, uint256 tokenId, uint256 deadline) internal returns (bytes memory) {
        return _sign(SIGNER_KEY, _digest(wallet, tokenId, deadline, address(token), block.chainid));
    }

    function _claim(address wallet, uint256 tokenId) internal {
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(wallet, tokenId, deadline);
        vm.prank(wallet);
        token.claim(tokenId, deadline, signature);
    }

    function testConfigurationAndEip712Domain() public {
        assertEq(token.name(), "Tarot Cards");
        assertEq(token.symbol(), "TAROT");
        assertEq(token.owner(), address(this));
        assertEq(token.quoteSigner(), vm.addr(SIGNER_KEY));
        assertEq(token.MAX_CARDS(), 777);
        assertEq(token.RECEIPT_OFFSET(), 777);
        assertEq(token.MAX_AUTHORIZATION_LIFETIME(), 600);
        assertEq(token.baseURI(), BASE_URI);
        assertEq(token.contractURI(), string.concat(BASE_URI, "collection.json"));
        assertTrue(token.supportsInterface(0x80ac58cd));
        assertTrue(token.supportsInterface(0x5b5e139f));
        (bytes1 fields, string memory name, string memory version, uint256 chain, address verifyingContract,,) =
            token.eip712Domain();
        assertEq(uint256(uint8(fields)), 15);
        assertEq(name, "Tarot Cards");
        assertEq(version, "1");
        assertEq(chain, 11155111);
        assertEq(verifyingContract, address(token));
    }

    function testConstructorRejectsMainnetAndUnknownChainsButAllowsLocal() public {
        for (uint256 i; i < 2; ++i) {
            vm.chainId(i == 0 ? 1 : 17000);
            vm.expectRevert(TarotCards.UnsupportedChain.selector);
            new TarotCards(address(this), ALICE, BASE_URI);
        }
        vm.chainId(31337);
        TarotCards local = new TarotCards(address(this), ALICE, BASE_URI);
        assertEq(local.owner(), address(this));
    }

    function testConstructorRejectsInvalidAddressesAndMetadata() public {
        vm.expectRevert();
        new TarotCards(address(0), ALICE, BASE_URI);
        vm.expectRevert(TarotCards.InvalidAddress.selector);
        new TarotCards(address(this), address(0), BASE_URI);
        vm.expectRevert(TarotCards.InvalidBaseURI.selector);
        new TarotCards(address(this), ALICE, "https://cdn.mons.shop/111k/");
    }

    function testClaimsBothBoundaryPairsAndEmitsExpectedEvent() public {
        vm.recordLogs();
        _claim(ALICE, 1);
        _claim(BOB, 777);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 6);
        assertEq(logs[2].topics[0], keccak256("TarotClaimed(address,uint256,uint256)"));
        assertEq(logs[2].topics[1], bytes32(uint256(uint160(ALICE))));
        assertEq(logs[2].topics[2], bytes32(uint256(1)));
        assertEq(logs[2].topics[3], bytes32(uint256(778)));
        assertEq(logs[2].data.length, 0);
        assertEq(token.ownerOf(1), ALICE);
        assertEq(token.ownerOf(778), ALICE);
        assertEq(token.ownerOf(777), BOB);
        assertEq(token.ownerOf(1554), BOB);
        assertEq(token.balanceOf(ALICE), 2);
        assertEq(token.balanceOf(BOB), 2);
        assertTrue(token.claimed(1));
        assertTrue(token.claimed(777));
        assertEq(token.tokenURI(1), string.concat(BASE_URI, "1.json"));
        assertEq(token.tokenURI(778), string.concat(BASE_URI, "778.json"));
        assertEq(token.tokenURI(1554), string.concat(BASE_URI, "1554.json"));
    }

    function testUnmintedTokenMetadataReverts() public {
        vm.expectRevert();
        token.tokenURI(1);
        vm.expectRevert();
        token.tokenURI(778);
    }

    function testSigningDigestMatchesSharedFixture() public pure {
        assertEq(_digest(0x1111111111111111111111111111111111111111, 777, 2_000_000_600,
            0x3333333333333333333333333333333333333333, 11155111),
            0x2000d9adbb67a0beb4cc16b29f621b369f4b6396a12308a78393169888fc261a);
    }

    function testAllCardsCanBeClaimedOnceWithoutReceiptCollisions() public {
        for (uint256 id = 1; id <= 777; ++id) {
            _claim(ALICE, id);
            assertEq(token.ownerOf(id), ALICE);
            assertEq(token.ownerOf(id + 777), ALICE);
            assertTrue(token.claimed(id));
        }
        assertEq(token.balanceOf(ALICE), 1554);
    }

    function testRejectsInvalidIdsBeforeSignatureVerification() public {
        uint256[4] memory ids = [uint256(0), 778, 1554, type(uint256).max];
        for (uint256 i; i < ids.length; ++i) {
            vm.expectRevert(TarotCards.InvalidTokenId.selector);
            token.claim(ids[i], block.timestamp + 600, "");
            vm.expectRevert(TarotCards.InvalidTokenId.selector);
            token.receiptTokenId(ids[i]);
        }
    }

    function testRejectsExpiredAndOverlongAuthorization() public {
        uint256[4] memory deadlines = [block.timestamp - 1, block.timestamp, block.timestamp + 601, type(uint256).max];
        for (uint256 i; i < deadlines.length; ++i) {
            bytes memory signature = _authorize(ALICE, 1, deadlines[i]);
            vm.prank(ALICE);
            vm.expectRevert(TarotCards.InvalidDeadline.selector);
            token.claim(1, deadlines[i], signature);
        }
        _claim(ALICE, 1);
    }

    function testRejectsWrongWalletCardDeadlineChainAndContract() public {
        uint256 deadline = block.timestamp + 600;
        bytes32[5] memory digests = [
            _digest(BOB, 1, deadline, address(token), block.chainid),
            _digest(ALICE, 2, deadline, address(token), block.chainid),
            _digest(ALICE, 1, deadline - 1, address(token), block.chainid),
            _digest(ALICE, 1, deadline, address(token), 1),
            _digest(ALICE, 1, deadline, address(0x1234), block.chainid)
        ];
        for (uint256 i; i < digests.length; ++i) {
            bytes memory signature = _sign(SIGNER_KEY, digests[i]);
            vm.prank(ALICE);
            vm.expectRevert(TarotCards.InvalidAuthorization.selector);
            token.claim(1, deadline, signature);
            assertFalse(token.claimed(1));
        }
    }

    function testRejectsMalformedWrongSignerAndHighSSignatures() public {
        uint256 deadline = block.timestamp + 600;
        bytes32 digest = _digest(ALICE, 1, deadline, address(token), block.chainid);
        bytes memory wrong = _sign(NEXT_SIGNER_KEY, digest);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidAuthorization.selector);
        token.claim(1, deadline, wrong);
        bytes[3] memory malformed = [bytes(""), new bytes(64), new bytes(65)];
        for (uint256 i; i < malformed.length; ++i) {
            vm.prank(ALICE);
            vm.expectRevert();
            token.claim(1, deadline, malformed[i]);
        }
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory highS = abi.encodePacked(r, bytes32(order - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(ALICE);
        vm.expectRevert();
        token.claim(1, deadline, highS);
        _claim(ALICE, 1);
    }

    function testDuplicateAndCompetingClaimsRemainRejectedAfterTransfers() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory alice = _authorize(ALICE, 1, deadline);
        bytes memory bob = _authorize(BOB, 1, deadline);
        vm.prank(ALICE);
        token.claim(1, deadline, alice);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.AlreadyClaimed.selector);
        token.claim(1, deadline, alice);
        vm.prank(BOB);
        vm.expectRevert(TarotCards.AlreadyClaimed.selector);
        token.claim(1, deadline, bob);
        vm.startPrank(ALICE);
        token.transferFrom(ALICE, BOB, 1);
        token.transferFrom(ALICE, BOB, 778);
        vm.stopPrank();
        assertTrue(token.claimed(1));
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.AlreadyClaimed.selector);
        token.claim(1, deadline, alice);
    }

    function testRejectingEitherSafeMintRollsBackWholeClaimAndAllowsRetry() public {
        TarotReceiver receiver = new TarotReceiver();
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(address(receiver), 1, deadline);
        for (uint256 i; i < 2; ++i) {
            receiver.configure(token, i == 0 ? 1 : 778, "");
            vm.expectRevert();
            receiver.claim(1, deadline, signature);
            assertFalse(token.claimed(1));
            assertEq(token.balanceOf(address(receiver)), 0);
            assertEq(receiver.callbacks(), 0);
        }
        receiver.configure(token, 0, "");
        receiver.claim(1, deadline, signature);
        assertTrue(token.claimed(1));
        assertEq(token.balanceOf(address(receiver)), 2);
        assertEq(receiver.callbacks(), 2);
    }

    function testSafeMintCallbacksCannotReenterAnotherAuthorizedClaim() public {
        TarotReceiver receiver = new TarotReceiver();
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(address(receiver), 1, deadline);
        bytes memory nested = _authorize(address(receiver), 2, deadline);
        receiver.configure(token, 0, abi.encodeCall(token.claim, (2, deadline, nested)));
        receiver.claim(1, deadline, signature);
        assertEq(receiver.blockedCalls(), 2);
        assertEq(token.balanceOf(address(receiver)), 2);
        assertFalse(token.claimed(2));
        receiver.configure(token, 0, "");
        receiver.claim(2, deadline, nested);
        assertTrue(token.claimed(2));
    }

    function testSignerRotationInvalidatesPreviousAuthorizationsAndRequiresOwner() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory oldSignature = _authorize(ALICE, 1, deadline);
        vm.prank(ALICE);
        vm.expectRevert();
        token.setQuoteSigner(BOB);
        vm.expectRevert(TarotCards.InvalidAddress.selector);
        token.setQuoteSigner(address(0));
        vm.expectRevert(TarotCards.InvalidAddress.selector);
        token.setQuoteSigner(address(token));
        address signer = vm.addr(NEXT_SIGNER_KEY);
        token.setQuoteSigner(signer);
        assertEq(token.quoteSigner(), signer);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.InvalidAuthorization.selector);
        token.claim(1, deadline, oldSignature);
        bytes memory signature = _sign(NEXT_SIGNER_KEY, _digest(ALICE, 1, deadline, address(token), block.chainid));
        vm.prank(ALICE);
        token.claim(1, deadline, signature);
    }

    function testOwnershipTransferRequiresAcceptanceAndCannotBeRenounced() public {
        token.transferOwnership(BOB);
        assertEq(token.owner(), address(this));
        assertEq(token.pendingOwner(), BOB);
        vm.prank(ALICE);
        vm.expectRevert();
        token.acceptOwnership();
        vm.prank(BOB);
        token.acceptOwnership();
        assertEq(token.owner(), BOB);
        vm.prank(BOB);
        vm.expectRevert(TarotCards.OwnershipRenunciationDisabled.selector);
        token.renounceOwnership();
    }

    function testClaimRejectsMainnetEvenAfterChainIdChanges() public {
        vm.chainId(1);
        bytes memory signature = _authorize(ALICE, 1, block.timestamp + 600);
        vm.prank(ALICE);
        vm.expectRevert(TarotCards.UnsupportedChain.selector);
        token.claim(1, block.timestamp + 600, signature);
    }

    function testClaimIsNonpayable() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = _authorize(ALICE, 1, deadline);
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        (bool success,) = address(token).call{value: 1}(abi.encodeCall(token.claim, (1, deadline, signature)));
        assertFalse(success);
        assertFalse(token.claimed(1));
    }

    function testFuzzValidCardIdsAlwaysProduceTheMatchingPair(uint16 seed) public {
        uint256 id = uint256(seed) % 777 + 1;
        _claim(ALICE, id);
        assertEq(token.ownerOf(id), ALICE);
        assertEq(token.ownerOf(token.receiptTokenId(id)), ALICE);
        assertEq(token.balanceOf(ALICE), 2);
    }
}
