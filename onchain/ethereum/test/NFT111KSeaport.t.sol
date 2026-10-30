pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {IERC721A} from "erc721a/contracts/IERC721A.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract SeaportTokenReceiver {
    address public operator;
    address public from;
    uint256 public tokenId;
    bytes public data;

    function onERC721Received(address operator_, address from_, uint256 tokenId_, bytes calldata data_)
        external
        returns (bytes4)
    {
        operator = operator_;
        from = from_;
        tokenId = tokenId_;
        data = data_;
        return this.onERC721Received.selector;
    }
}

contract NFT111KSeaportTest is TestSupport {
    NFT111K private token;
    address private constant ALICE = address(0xA110);
    address private constant BOB = address(0xB0B);
    address private constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395;
    address private constant OPENSEA_CONDUIT = 0x1E0049783F008A0085193E00003D00cd54003c71;
    uint256 private constant SIGNER_KEY = 0xA11CE;
    bytes32 private constant APPROVAL_FOR_ALL = keccak256("ApprovalForAll(address,address,bool)");

    function setUp() public {
        vm.chainId(1);
        vm.warp(2_000_000_000);
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
        token = new NFT111K(
            address(this),
            vm.addr(SIGNER_KEY),
            payable(BOB),
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            _proceedsRecipients(),
            _proceedsSharesBps()
        );
        token.setSaleActive(true);
    }

    function testSeaportTransfersWithoutApprovalOnMainnetAndSepolia() public {
        assertEq(token.SEAPORT(), SEAPORT);
        uint256[2] memory chains = [uint256(1), 11155111];
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            _buyCrates(ALICE, 1);
            uint256 tokenId = 111112 + i;
            assertTrue(token.isApprovedForAll(ALICE, SEAPORT));
            assertEq(token.getApproved(tokenId), address(0));
            vm.prank(SEAPORT);
            token.transferFrom(ALICE, BOB, tokenId);
            assertEq(token.ownerOf(tokenId), BOB);
        }
    }

    function testBothSafeTransferOverloadsUseDefaultApprovalAndReceiverChecks() public {
        _buyCrates(ALICE, 2);
        SeaportTokenReceiver receiver = new SeaportTokenReceiver();
        vm.prank(SEAPORT);
        token.safeTransferFrom(ALICE, address(receiver), 111112);
        assertEq(token.ownerOf(111112), address(receiver));
        assertEq(receiver.operator(), SEAPORT);
        assertEq(receiver.from(), ALICE);
        assertEq(receiver.tokenId(), 111112);
        assertEq(receiver.data().length, 0);

        bytes memory data = hex"1111abcd";
        vm.prank(SEAPORT);
        token.safeTransferFrom(ALICE, address(receiver), 111113, data);
        assertEq(token.ownerOf(111113), address(receiver));
        assertEq(receiver.tokenId(), 111113);
        assertEq(keccak256(receiver.data()), keccak256(data));

        vm.prank(SEAPORT);
        vm.expectRevert(IERC721A.TransferToNonERC721ReceiverImplementer.selector);
        token.safeTransferFrom(address(receiver), address(this), 111113);
        assertEq(token.ownerOf(111113), address(receiver));
    }

    function testWalletCanRevokeAndRestoreSeaportWithStandardApprovalEvents() public {
        _buyCrates(ALICE, 1);
        _setSeaportApproval(ALICE, false);
        assertFalse(token.isApprovedForAll(ALICE, SEAPORT));
        _expectRejectedTransfer(SEAPORT, ALICE, BOB, 111112);
        _setSeaportApproval(ALICE, true);
        assertTrue(token.isApprovedForAll(ALICE, SEAPORT));
        vm.prank(SEAPORT);
        token.transferFrom(ALICE, BOB, 111112);
        assertEq(token.ownerOf(111112), BOB);
    }

    function testRevocationIsWalletSpecificAndSurvivesNewAcquisitions() public {
        _setSeaportApproval(ALICE, false);
        _buyCrates(BOB, 1);
        assertTrue(token.isApprovedForAll(BOB, SEAPORT));
        vm.prank(SEAPORT);
        token.transferFrom(BOB, ALICE, 111112);
        _buyCrates(ALICE, 1);
        assertFalse(token.isApprovedForAll(ALICE, SEAPORT));
        _expectRejectedTransfer(SEAPORT, ALICE, BOB, 111112);
        _expectRejectedTransfer(SEAPORT, ALICE, BOB, 111113);
        vm.prank(ALICE);
        token.transferFrom(ALICE, BOB, 111112);
        assertTrue(token.isApprovedForAll(BOB, SEAPORT));
        vm.prank(SEAPORT);
        token.transferFrom(BOB, ALICE, 111112);
        assertFalse(token.isApprovedForAll(ALICE, SEAPORT));
        _expectRejectedTransfer(SEAPORT, ALICE, BOB, 111112);
    }

    function testOtherOperatorsAndConduitsStillRequireExplicitApproval() public {
        _buyCrates(ALICE, 3);
        address[2] memory operators = [BOB, OPENSEA_CONDUIT];
        for (uint256 i; i < operators.length; ++i) {
            address operator = operators[i];
            uint256 tokenId = 111112 + i;
            assertFalse(token.isApprovedForAll(ALICE, operator));
            _expectRejectedTransfer(operator, ALICE, BOB, tokenId);
            vm.prank(ALICE);
            token.setApprovalForAll(operator, true);
            assertTrue(token.isApprovedForAll(ALICE, operator));
            vm.prank(operator);
            token.transferFrom(ALICE, BOB, tokenId);
            assertEq(token.ownerOf(tokenId), BOB);
            vm.prank(ALICE);
            token.setApprovalForAll(operator, false);
            assertFalse(token.isApprovedForAll(ALICE, operator));
            _expectRejectedTransfer(operator, ALICE, BOB, 111114);
        }
        assertTrue(token.isApprovedForAll(ALICE, SEAPORT));
    }

    function testFuzzOtherChainsRequireExplicitSeaportApproval(uint64 chainId) public {
        if (chainId == 1 || chainId == 11155111) return;
        vm.chainId(chainId);
        _buyCrates(ALICE, 2);
        assertFalse(token.isApprovedForAll(ALICE, SEAPORT));
        _expectRejectedTransfer(SEAPORT, ALICE, BOB, 111112);
        _setSeaportApproval(ALICE, true);
        assertTrue(token.isApprovedForAll(ALICE, SEAPORT));
        vm.prank(SEAPORT);
        token.transferFrom(ALICE, BOB, 111112);
        assertEq(token.ownerOf(111112), BOB);
        _setSeaportApproval(ALICE, false);
        assertFalse(token.isApprovedForAll(ALICE, SEAPORT));
        _expectRejectedTransfer(SEAPORT, ALICE, BOB, 111113);
    }

    function testOperatorRevocationPreservesExplicitTokenApprovalSemantics() public {
        _buyCrates(ALICE, 1);
        vm.prank(ALICE);
        token.approve(SEAPORT, 111112);
        _setSeaportApproval(ALICE, false);
        assertFalse(token.isApprovedForAll(ALICE, SEAPORT));
        assertEq(token.getApproved(111112), SEAPORT);
        vm.prank(SEAPORT);
        token.transferFrom(ALICE, BOB, 111112);
        assertEq(token.ownerOf(111112), BOB);
        assertEq(token.getApproved(111112), address(0));
    }

    function testDefaultOperatorCannotUnboxRedeemOrClaimForTokenOwner() public {
        _buyCrates(ALICE, 3);
        vm.prank(ALICE);
        token.mintWarehouses{value: 0.0011 ether}(1);
        vm.prank(ALICE);
        token.unboxCrate(111112);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 111113;
        (NFT111K.DeliveryQuote memory quote, bytes memory signature) = _deliveryQuote(ALICE, 111113, 2000002, 1);
        vm.prank(ALICE);
        token.redeemForDelivery(ids, quote, signature);

        vm.prank(SEAPORT);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxWarehouse(116667);
        vm.prank(SEAPORT);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxCrate(111114);
        ids[0] = 111114;
        vm.prank(SEAPORT);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.unboxCrates(ids);
        vm.prank(SEAPORT);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.claimCrateReceipt(2000002, bytes32(uint256(1)), block.timestamp + 60, hex"");

        ids[0] = 1;
        (quote, signature) = _deliveryQuote(SEAPORT, 1, 1000001, 2);
        vm.prank(SEAPORT);
        vm.expectRevert(NFT111K.WrongOwner.selector);
        token.redeemForDelivery(ids, quote, signature);
        assertEq(token.ownerOf(1), ALICE);
        assertEq(token.ownerOf(111114), ALICE);
        assertEq(token.ownerOf(116667), ALICE);
        assertEq(token.ownerOf(2000002), ALICE);
    }

    function _buyCrates(address wallet, uint256 quantity) private {
        vm.prank(wallet);
        token.mintCrates{value: quantity * 0.0001 ether}(quantity);
    }

    function _setSeaportApproval(address wallet, bool approved) private {
        vm.recordLogs();
        vm.prank(wallet);
        token.setApprovalForAll(SEAPORT, approved);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(token));
        assertEq(logs[0].topics.length, 3);
        assertEq(logs[0].topics[0], APPROVAL_FOR_ALL);
        assertEq(address(uint160(uint256(logs[0].topics[1]))), wallet);
        assertEq(address(uint160(uint256(logs[0].topics[2]))), SEAPORT);
        assertTrue(abi.decode(logs[0].data, (bool)) == approved);
    }

    function _expectRejectedTransfer(address operator, address from, address to, uint256 tokenId) private {
        vm.prank(operator);
        vm.expectRevert(IERC721A.TransferCallerNotOwnerNorApproved.selector);
        token.transferFrom(from, to, tokenId);
        assertEq(token.ownerOf(tokenId), from);
    }

    function _deliveryQuote(address wallet, uint256 tokenId, uint256 receiptId, uint256 orderId)
        private
        returns (NFT111K.DeliveryQuote memory quote, bytes memory signature)
    {
        uint256[] memory ids = new uint256[](1);
        ids[0] = receiptId;
        quote = NFT111K.DeliveryQuote(orderId, wallet, 0, block.timestamp + 60, keccak256(abi.encode(ids)));
        ids[0] = tokenId;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)"
                ),
                wallet,
                keccak256(abi.encode(ids)),
                quote.receiptIdsHash,
                orderId,
                0,
                quote.deadline
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("111K"),
                keccak256("2"),
                block.chainid,
                address(token)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        signature = abi.encodePacked(r, s, v);
    }
}
