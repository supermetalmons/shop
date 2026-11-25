pragma solidity 0.8.38;

import {TarotCards} from "../src/TarotCards.sol";
import {IDMXRenderer} from "../src/IDMXRenderer.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {TestSupport} from "./TestSupport.sol";

contract DMXFixtureRenderer is IDMXRenderer {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IDMXRenderer).interfaceId;
    }

    function tokenURI(address, uint256) external pure returns (string memory) {
        return "fixture-token";
    }

    function contractURI(address) external pure returns (string memory) {
        return "fixture-collection";
    }
}

abstract contract DMXTestSupport is TestSupport {
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant NEXT_SIGNER_KEY = 0xB0B;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant TREASURY1 = address(0xD001);
    address internal constant TREASURY2 = address(0xD002);
    TarotCards internal token;
    DMXFixtureRenderer internal renderer;

    function setUp() public virtual {
        vm.chainId(11155111);
        vm.warp(2_000_000_000);
        renderer = new DMXFixtureRenderer();
        token = new TarotCards(address(this), vm.addr(SIGNER_KEY), address(renderer));
    }

    function _typedDigest(bytes32 structHash, address contractAddress, uint256 chainId)
        internal pure returns (bytes32)
    {
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("divination machina x"), keccak256("1"), chainId, contractAddress
        ));
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }

    function _digest(address wallet, uint256 tokenId, uint256 deadline, address contractAddress, uint256 chainId)
        internal pure returns (bytes32)
    {
        return _typedDigest(keccak256(abi.encode(
            keccak256("TarotClaim(address wallet,uint256 tokenId,uint256 deadline)"), wallet, tokenId, deadline
        )), contractAddress, chainId);
    }

    function _mintDigest(uint256[] memory ids, TarotCards.MintQuote memory quote, address contractAddress, uint256 chainId)
        internal pure returns (bytes32)
    {
        return _typedDigest(keccak256(abi.encode(
            keccak256("DMXMint(address recipient,bytes32 cardIdsHash,bytes32 authorizationId,uint256 deadline)"),
            quote.recipient, keccak256(abi.encode(ids)), quote.authorizationId, quote.deadline
        )), contractAddress, chainId);
    }

    function _redemptionDigest(
        uint256[] memory inputs,
        uint256[] memory outputs,
        TarotCards.RedemptionQuote memory quote,
        address contractAddress,
        uint256 chainId
    ) internal pure returns (bytes32) {
        uint256[] memory receipts = new uint256[](inputs.length);
        for (uint256 i; i < inputs.length; ++i) receipts[i] = 1_000_776 + inputs[i];
        return _typedDigest(keccak256(abi.encode(
            keccak256("DMXRedemption(address wallet,address recipient,bytes32 inputIdsHash,bytes32 outputIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline,uint256 configId)"),
            quote.wallet, quote.recipient, keccak256(abi.encode(inputs)), keccak256(abi.encode(outputs)),
            keccak256(abi.encode(receipts)), quote.orderId, quote.fee, quote.deadline, quote.configId
        )), contractAddress, chainId);
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

    function _mintQuote(address recipient, uint256 authorizationId) internal view returns (TarotCards.MintQuote memory) {
        return TarotCards.MintQuote(bytes32(authorizationId), recipient, block.timestamp + 600);
    }

    function _quote(address wallet, address recipient, uint256 orderId, uint256 fee, uint256 configId)
        internal view returns (TarotCards.RedemptionQuote memory)
    {
        return TarotCards.RedemptionQuote(orderId, wallet, recipient, fee, block.timestamp + 600, configId);
    }

    function _mintSignature(uint256[] memory ids, TarotCards.MintQuote memory quote) internal returns (bytes memory) {
        return _sign(SIGNER_KEY, _mintDigest(ids, quote, address(token), block.chainid));
    }

    function _redemptionSignature(uint256[] memory inputs, uint256[] memory outputs, TarotCards.RedemptionQuote memory quote)
        internal returns (bytes memory)
    {
        return _sign(SIGNER_KEY, _redemptionDigest(inputs, outputs, quote, address(token), block.chainid));
    }

    function _redeem(uint256[] memory inputs, uint256[] memory outputs, TarotCards.RedemptionQuote memory quote) internal {
        bytes memory signature = _redemptionSignature(inputs, outputs, quote);
        vm.deal(quote.wallet, quote.fee);
        vm.prank(quote.wallet);
        token.redeem{value: quote.fee}(inputs, outputs, quote, signature);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _two(uint256 first, uint256 second) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = first;
        ids[1] = second;
    }

    function _range(uint256 first, uint256 count) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) ids[i] = first + i;
    }

    function _absent(uint256 id) internal view {
        (bool success,) = address(token).staticcall(abi.encodeCall(token.ownerOf, (id)));
        assertFalse(success);
    }

    function _sameIds(uint256[] memory actual, uint256[] memory expected) internal pure {
        assertEq(keccak256(abi.encode(actual)), keccak256(abi.encode(expected)));
    }

    function _configReceived(uint256 configId) internal view returns (uint256 received) {
        (,,, received,,) = token.redemptionConfigs(configId);
    }
}

contract DMXStateReceiver is IERC721Receiver {
    TarotCards public token;
    uint256 public rejectingTokenId;
    uint256 public callbacks;
    uint256 public blockedCalls;
    uint256 public orderId;
    uint256[] private inputs;
    uint256[] private outputs;
    bytes private reentry;
    address private forwardTo;

    function configure(TarotCards token_, uint256 rejectId, bytes memory reentry_) external {
        token = token_;
        rejectingTokenId = rejectId;
        reentry = reentry_;
    }

    function observe(uint256 orderId_, uint256[] memory inputs_, uint256[] memory outputs_) external {
        orderId = orderId_;
        inputs = inputs_;
        outputs = outputs_;
    }

    function observeMint(uint256[] memory cardIds) external {
        orderId = 0;
        outputs = cardIds;
    }

    function forward(address recipient) external {
        forwardTo = recipient;
    }

    function execute(bytes memory data, uint256 value) external payable {
        (bool success, bytes memory reason) = address(token).call{value: value}(data);
        if (!success) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(token) && tokenId != rejectingTokenId);
        if (orderId == 0) {
            for (uint256 i; i < outputs.length; ++i) {
                require(token.issued(outputs[i]));
                require(!token.getTokenInfo(outputs[i]).burned);
                if (outputs[i] <= 777) {
                    require(token.claimed(outputs[i]));
                    require(token.issued(token.receiptTokenId(outputs[i])));
                }
            }
        }
        if (orderId != 0) {
            require(token.usedRedemptionOrders(orderId));
            for (uint256 i; i < inputs.length; ++i) {
                require(token.redeemedByOrder(inputs[i]) == orderId);
                require(token.issued(token.redemptionReceiptTokenId(inputs[i])));
                (bool exists,) = address(token).staticcall(abi.encodeCall(token.ownerOf, (inputs[i])));
                require(!exists);
            }
            for (uint256 i; i < outputs.length; ++i) {
                require(token.issued(outputs[i]));
                require(token.createdByOrder(outputs[i]) == orderId);
                require(!token.getTokenInfo(outputs[i]).burned);
            }
            (,, uint256[] memory storedInputs, uint256[] memory storedOutputs) = token.getRedemption(orderId);
            require(keccak256(abi.encode(inputs)) == keccak256(abi.encode(storedInputs)));
            require(keccak256(abi.encode(outputs)) == keccak256(abi.encode(storedOutputs)));
        }
        callbacks++;
        if (reentry.length != 0) {
            (bool success, bytes memory reason) = address(token).call(reentry);
            require(!success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")));
            blockedCalls++;
        }
        if (forwardTo != address(0)) token.transferFrom(address(this), forwardTo, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract DMXPaymentReceiver {
    TarotCards public token;
    uint256 public configId;
    uint256 public mode;
    uint256 public received;
    uint256 public blockedCalls;

    function configure(TarotCards token_, uint256 configId_, uint256 mode_) external {
        token = token_;
        configId = configId_;
        mode = mode_;
    }

    receive() external payable {
        if (mode == 1) revert();
        if (mode == 2) assembly { for {} 1 {} {} }
        if (mode == 3) require(gasleft() > 150_000);
        if (mode == 4) {
            (uint256 amount,) = token.releasableRedemption(configId);
            require(amount == 0);
            (bool success, bytes memory reason) = address(token).call(abi.encodeCall(token.releaseRedemptionFor, (configId, false)));
            require(!success && bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")));
            blockedCalls++;
        }
        received += msg.value;
    }
}
