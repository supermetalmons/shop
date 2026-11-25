pragma solidity 0.8.38;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import {IDMXRenderer, IDMXTokenInfo} from "./IDMXRenderer.sol";

contract TarotCards is ERC721, Ownable2Step, EIP712, ReentrancyGuardTransient, IDMXTokenInfo {
    using BitMaps for BitMaps.BitMap;

    struct MintQuote {
        bytes32 authorizationId;
        address recipient;
        uint256 deadline;
    }

    struct RedemptionQuote {
        uint256 orderId;
        address wallet;
        address recipient;
        uint256 fee;
        uint256 deadline;
        uint256 configId;
    }

    struct RedemptionRecord {
        address wallet;
        address recipient;
        uint32[] inputCardIds;
        uint32[] outputCardIds;
    }

    struct RedemptionConfig {
        address receiver1;
        address receiver2;
        uint16 receiver2Bps;
        uint256 totalReceived;
        uint256 released1;
        uint256 released2;
    }

    uint256 public constant INITIAL_CARDS = 777;
    uint256 public constant MAX_CARDS = 999_999;
    uint256 public constant RECEIPT_OFFSET = 999_999;
    uint256 public constant REDEMPTION_RECEIPT_OFFSET = 1_000_776;
    uint256 public constant MAX_TOKEN_ID = REDEMPTION_RECEIPT_OFFSET + MAX_CARDS;
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant MAX_RELEASE_CONFIGS = 32;
    uint256 public constant PAYOUT_GAS_LIMIT = 100_000;
    uint256 public constant MAX_AUTHORIZATION_LIFETIME = 10 minutes;

    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("TarotClaim(address wallet,uint256 tokenId,uint256 deadline)");
    bytes32 private constant MINT_TYPEHASH = keccak256(
        "DMXMint(address recipient,bytes32 cardIdsHash,bytes32 authorizationId,uint256 deadline)"
    );
    bytes32 private constant REDEMPTION_TYPEHASH = keccak256(
        "DMXRedemption(address wallet,address recipient,bytes32 inputIdsHash,bytes32 outputIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline,uint256 configId)"
    );

    address public quoteSigner;
    address public renderer;
    bool public mintingPaused;
    bool public redemptionsPaused = true;
    uint256 public redemptionConfigCount;
    BitMaps.BitMap private issuedBits;
    mapping(bytes32 => bool) public usedMintAuthorizations;
    mapping(uint256 => bool) public usedRedemptionOrders;
    mapping(uint256 => uint256) public generation;
    mapping(uint256 => uint256) public createdByOrder;
    mapping(uint256 => uint256) public redeemedByOrder;
    mapping(uint256 => RedemptionConfig) public redemptionConfigs;
    mapping(uint256 => RedemptionRecord) private redemptions;

    error UnsupportedChain();
    error InvalidAddress();
    error InvalidTokenId();
    error InvalidQuantity();
    error AlreadyClaimed();
    error AlreadyIssued();
    error InvalidDeadline();
    error InvalidAuthorization();
    error AuthorizationAlreadyUsed();
    error WrongOwner();
    error WrongPayment();
    error MintingPaused();
    error RedemptionsPaused();
    error InvalidRenderer();
    error InvalidRedemptionConfig();
    error InvalidRedemptionSplit();
    error ProceedsPaymentFailed();
    error InsufficientPayoutGas();
    error OwnershipRenunciationDisabled();

    event TarotClaimed(address indexed wallet, uint256 indexed tokenId, uint256 indexed receiptTokenId);
    event CardsMinted(address indexed recipient, bytes32 indexed authorizationId, uint256[] cardIds);
    event CardsRedeemed(
        uint256 indexed orderId,
        address indexed wallet,
        address indexed recipient,
        uint256 fee,
        uint256[] inputCardIds,
        uint256[] outputCardIds,
        uint256[] receiptIds,
        uint256 configId
    );
    event QuoteSignerUpdated(address indexed signer);
    event MintingPauseUpdated(bool paused);
    event RedemptionsPauseUpdated(bool paused);
    event RendererUpdated(address indexed previousRenderer, address indexed newRenderer);
    event MetadataUpdate(uint256 tokenId);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);
    event ContractURIUpdated();
    event RedemptionConfigRegistered(
        uint256 indexed configId, address indexed receiver1, address indexed receiver2, uint16 receiver2Bps
    );
    event RedemptionProceedsReleased(uint256 indexed configId, address indexed receiver, uint256 amount);
    event RedemptionProceedsReleaseFailed(uint256 indexed configId, address indexed receiver, uint256 amount);

    constructor(address initialOwner, address signer, address initialRenderer)
        ERC721("divination machina x", "DMX")
        Ownable(initialOwner)
        EIP712("divination machina x", "1")
    {
        _checkChain();
        _validateRecipient(initialOwner);
        _validateRecipient(signer);
        quoteSigner = signer;
        _setRenderer(initialRenderer);
    }

    function claimed(uint256 tokenId) public view returns (bool) {
        return tokenId > 0 && tokenId <= INITIAL_CARDS && issuedBits.get(tokenId);
    }

    function issued(uint256 tokenId) public view returns (bool) {
        if (tokenId == 0 || tokenId > MAX_TOKEN_ID) return false;
        if (tokenId <= MAX_CARDS) return issuedBits.get(tokenId);
        if (tokenId <= REDEMPTION_RECEIPT_OFFSET) return issuedBits.get(tokenId - RECEIPT_OFFSET);
        return redeemedByOrder[tokenId - REDEMPTION_RECEIPT_OFFSET] != 0;
    }

    function claim(uint256 tokenId, uint256 deadline, bytes calldata signature) external nonReentrant {
        _claim(msg.sender, tokenId, deadline, signature);
    }

    function claimTo(address recipient, uint256 tokenId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        _claim(recipient, tokenId, deadline, signature);
    }

    function mintTo(address recipient, uint256[] calldata cardIds) external onlyOwner nonReentrant {
        _checkMinting();
        _mintCards(recipient, cardIds);
        emit CardsMinted(recipient, bytes32(0), cardIds);
    }

    function mintToAuthorized(uint256[] calldata cardIds, MintQuote calldata quote, bytes calldata signature)
        external
        nonReentrant
    {
        _checkMinting();
        if (quote.authorizationId == bytes32(0)) revert InvalidAuthorization();
        if (usedMintAuthorizations[quote.authorizationId]) revert AuthorizationAlreadyUsed();
        _checkDeadline(quote.deadline);
        _checkSignature(_hashTypedDataV4(keccak256(abi.encode(
            MINT_TYPEHASH, quote.recipient, keccak256(abi.encode(cardIds)), quote.authorizationId, quote.deadline
        ))), signature);
        usedMintAuthorizations[quote.authorizationId] = true;
        _mintCards(quote.recipient, cardIds);
        emit CardsMinted(quote.recipient, quote.authorizationId, cardIds);
    }

    function redeem(
        uint256[] calldata inputCardIds,
        uint256[] calldata outputCardIds,
        RedemptionQuote calldata quote,
        bytes calldata signature
    ) external payable nonReentrant {
        _checkChain();
        if (redemptionsPaused) revert RedemptionsPaused();
        if (inputCardIds.length == 0 || inputCardIds.length > MAX_BATCH_SIZE || outputCardIds.length > MAX_BATCH_SIZE) {
            revert InvalidQuantity();
        }
        if (quote.wallet != msg.sender || quote.orderId == 0) revert InvalidAuthorization();
        _validateRecipient(quote.recipient);
        if (msg.value != quote.fee) revert WrongPayment();
        _checkDeadline(quote.deadline);
        if (usedRedemptionOrders[quote.orderId]) revert AuthorizationAlreadyUsed();
        uint256[] memory receiptIds = new uint256[](inputCardIds.length);
        for (uint256 i; i < inputCardIds.length; ++i) {
            receiptIds[i] = redemptionReceiptTokenId(inputCardIds[i]);
        }
        _checkSignature(_redemptionDigest(inputCardIds, outputCardIds, receiptIds, quote), signature);
        _accrueRedemptionFee(quote.configId);
        _prepareRedemption(inputCardIds, outputCardIds, quote);
        // Every input is burned before a receiver can observe or transfer any output.
        for (uint256 i; i < inputCardIds.length; ++i) {
            _burn(inputCardIds[i]);
            if (inputCardIds[i] <= INITIAL_CARDS) emit MetadataUpdate(receiptTokenId(inputCardIds[i]));
        }
        for (uint256 i; i < outputCardIds.length; ++i) _safeMint(quote.recipient, outputCardIds[i]);
        for (uint256 i; i < receiptIds.length; ++i) _safeMint(quote.recipient, receiptIds[i]);
        emit CardsRedeemed(
            quote.orderId, quote.wallet, quote.recipient, quote.fee, inputCardIds, outputCardIds, receiptIds, quote.configId
        );
    }

    function receiptTokenId(uint256 tokenId) public pure returns (uint256) {
        if (tokenId == 0 || tokenId > INITIAL_CARDS) revert InvalidTokenId();
        return tokenId + RECEIPT_OFFSET;
    }

    function redemptionReceiptTokenId(uint256 cardId) public pure returns (uint256) {
        _validateCardId(cardId);
        return cardId + REDEMPTION_RECEIPT_OFFSET;
    }

    function getTokenInfo(uint256 tokenId) external view returns (TokenInfo memory info) {
        if (!issued(tokenId)) revert InvalidTokenId();
        if (tokenId <= MAX_CARDS) {
            info.kind = TokenKind.Card;
            info.cardId = tokenId;
            info.burned = redeemedByOrder[tokenId] != 0;
        } else if (tokenId <= REDEMPTION_RECEIPT_OFFSET) {
            info.kind = TokenKind.NFCReceipt;
            info.cardId = tokenId - RECEIPT_OFFSET;
        } else {
            info.kind = TokenKind.RedemptionReceipt;
            info.cardId = tokenId - REDEMPTION_RECEIPT_OFFSET;
        }
        info.generation = generation[info.cardId];
        info.createdByOrder = createdByOrder[info.cardId];
        info.redeemedByOrder = redeemedByOrder[info.cardId];
    }

    function getRedemption(uint256 orderId)
        external
        view
        returns (address wallet, address recipient, uint256[] memory inputCardIds, uint256[] memory outputCardIds)
    {
        RedemptionRecord storage record = redemptions[orderId];
        if (!usedRedemptionOrders[orderId]) revert InvalidAuthorization();
        inputCardIds = new uint256[](record.inputCardIds.length);
        outputCardIds = new uint256[](record.outputCardIds.length);
        for (uint256 i; i < inputCardIds.length; ++i) inputCardIds[i] = record.inputCardIds[i];
        for (uint256 i; i < outputCardIds.length; ++i) outputCardIds[i] = record.outputCardIds[i];
        return (record.wallet, record.recipient, inputCardIds, outputCardIds);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return IDMXRenderer(renderer).tokenURI(address(this), tokenId);
    }

    function contractURI() external view returns (string memory) {
        return IDMXRenderer(renderer).contractURI(address(this));
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0x49064906 || interfaceId == type(IDMXTokenInfo).interfaceId
            || super.supportsInterface(interfaceId);
    }

    function setRenderer(address nextRenderer) external onlyOwner {
        _setRenderer(nextRenderer);
    }

    function refreshMetadata(uint256 fromTokenId, uint256 toTokenId) external onlyOwner {
        if (fromTokenId == 0 || fromTokenId > toTokenId || toTokenId > MAX_TOKEN_ID) revert InvalidTokenId();
        emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    function refreshContractMetadata() external onlyOwner {
        emit ContractURIUpdated();
    }

    function setQuoteSigner(address signer) external onlyOwner {
        _validateRecipient(signer);
        quoteSigner = signer;
        emit QuoteSignerUpdated(signer);
    }

    function setMintingPaused(bool paused) external onlyOwner {
        mintingPaused = paused;
        emit MintingPauseUpdated(paused);
    }

    function setRedemptionsPaused(bool paused) external onlyOwner {
        redemptionsPaused = paused;
        emit RedemptionsPauseUpdated(paused);
    }

    function renounceOwnership() public override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    function registerRedemptionConfig(address receiver1, address receiver2, uint16 receiver2Bps)
        external
        onlyOwner
        returns (uint256 configId)
    {
        _validateRecipient(receiver1);
        if (receiver2 == address(0)) {
            if (receiver2Bps != 0) revert InvalidRedemptionSplit();
        } else {
            _validateRecipient(receiver2);
            if (receiver1 == receiver2 || receiver2Bps == 0 || receiver2Bps >= 10_000) revert InvalidRedemptionSplit();
        }
        configId = ++redemptionConfigCount;
        RedemptionConfig storage config = redemptionConfigs[configId];
        config.receiver1 = receiver1;
        config.receiver2 = receiver2;
        config.receiver2Bps = receiver2Bps;
        emit RedemptionConfigRegistered(configId, receiver1, receiver2, receiver2Bps);
    }

    function releasableRedemption(uint256 configId) public view returns (uint256 amount1, uint256 amount2) {
        RedemptionConfig storage config = redemptionConfigs[configId];
        if (config.receiver1 == address(0)) revert InvalidRedemptionConfig();
        uint256 total = config.totalReceived;
        uint256 share = config.receiver2Bps;
        uint256 entitlement2 = (total / 10_000) * share + ((total % 10_000) * share) / 10_000;
        amount1 = total - entitlement2 - config.released1;
        amount2 = entitlement2 - config.released2;
    }

    function releaseRedemptionFor(uint256 configId, bool secondary) external nonReentrant {
        (uint256 amount1, uint256 amount2) = releasableRedemption(configId);
        _releaseRedemption(configId, secondary, secondary ? amount2 : amount1, false);
    }

    function releaseRedemption(uint256[] calldata configIds) external nonReentrant {
        if (configIds.length == 0 || configIds.length > MAX_RELEASE_CONFIGS) revert InvalidQuantity();
        for (uint256 i; i < configIds.length; ++i) {
            (uint256 amount1, uint256 amount2) = releasableRedemption(configIds[i]);
            _releaseRedemption(configIds[i], false, amount1, true);
            _releaseRedemption(configIds[i], true, amount2, true);
        }
    }

    function _claim(address recipient, uint256 tokenId, uint256 deadline, bytes calldata signature) private {
        _checkMinting();
        receiptTokenId(tokenId);
        _validateRecipient(recipient);
        if (claimed(tokenId)) revert AlreadyClaimed();
        _checkDeadline(deadline);
        _checkSignature(_hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, recipient, tokenId, deadline))), signature);
        _prepareCardMint(tokenId, 0, 0);
        _mintPreparedCard(recipient, tokenId);
    }

    function _mintCards(address recipient, uint256[] calldata cardIds) private {
        _validateRecipient(recipient);
        if (cardIds.length == 0 || cardIds.length > MAX_BATCH_SIZE) revert InvalidQuantity();
        for (uint256 i; i < cardIds.length; ++i) _prepareCardMint(cardIds[i], 0, 0);
        for (uint256 i; i < cardIds.length; ++i) _mintPreparedCard(recipient, cardIds[i]);
    }

    function _prepareCardMint(uint256 cardId, uint256 nextGeneration, uint256 orderId) private {
        _validateCardId(cardId);
        if (cardId <= INITIAL_CARDS) {
            if (issuedBits.get(cardId)) revert AlreadyClaimed();
        }
        _reserve(cardId);
        if (nextGeneration != 0) generation[cardId] = nextGeneration;
        if (orderId != 0) createdByOrder[cardId] = orderId;
    }

    function _mintPreparedCard(address recipient, uint256 cardId) private {
        _safeMint(recipient, cardId);
        if (cardId <= INITIAL_CARDS) {
            uint256 receipt = receiptTokenId(cardId);
            _safeMint(recipient, receipt);
            emit TarotClaimed(recipient, cardId, receipt);
        }
    }

    function _prepareRedemption(
        uint256[] calldata inputCardIds,
        uint256[] calldata outputCardIds,
        RedemptionQuote calldata quote
    ) private {
        usedRedemptionOrders[quote.orderId] = true;
        RedemptionRecord storage record = redemptions[quote.orderId];
        record.wallet = quote.wallet;
        record.recipient = quote.recipient;
        uint256 highestGeneration;
        for (uint256 i; i < inputCardIds.length; ++i) {
            uint256 cardId = inputCardIds[i];
            if (_ownerOf(cardId) != quote.wallet) revert WrongOwner();
            if (redeemedByOrder[cardId] != 0) revert AlreadyIssued();
            redeemedByOrder[cardId] = quote.orderId;
            if (generation[cardId] > highestGeneration) highestGeneration = generation[cardId];
            record.inputCardIds.push(uint32(cardId));
        }
        for (uint256 i; i < outputCardIds.length; ++i) {
            if (outputCardIds[i] <= INITIAL_CARDS) revert InvalidTokenId();
            _prepareCardMint(outputCardIds[i], highestGeneration + 1, quote.orderId);
            record.outputCardIds.push(uint32(outputCardIds[i]));
        }
    }

    function _redemptionDigest(
        uint256[] calldata inputCardIds,
        uint256[] calldata outputCardIds,
        uint256[] memory receiptIds,
        RedemptionQuote calldata quote
    ) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            REDEMPTION_TYPEHASH, quote.wallet, quote.recipient, keccak256(abi.encode(inputCardIds)),
            keccak256(abi.encode(outputCardIds)), keccak256(abi.encode(receiptIds)), quote.orderId,
            quote.fee, quote.deadline, quote.configId
        )));
    }

    function _accrueRedemptionFee(uint256 configId) private {
        if (configId == 0) {
            if (msg.value != 0) revert InvalidRedemptionConfig();
            return;
        }
        RedemptionConfig storage config = redemptionConfigs[configId];
        if (config.receiver1 == address(0)) revert InvalidRedemptionConfig();
        config.totalReceived += msg.value;
    }

    function _releaseRedemption(uint256 configId, bool secondary, uint256 amount, bool batch) private {
        if (amount == 0) return;
        RedemptionConfig storage config = redemptionConfigs[configId];
        address receiver = secondary ? config.receiver2 : config.receiver1;
        if (secondary) config.released2 += amount;
        else config.released1 += amount;
        bool paid;
        if (batch) {
            if (gasleft() < PAYOUT_GAS_LIMIT + 50_000) revert InsufficientPayoutGas();
            assembly ("memory-safe") {
                paid := call(PAYOUT_GAS_LIMIT, receiver, amount, 0, 0, 0, 0)
            }
        } else {
            (paid,) = payable(receiver).call{value: amount}("");
        }
        if (!paid) {
            if (!batch) revert ProceedsPaymentFailed();
            if (secondary) config.released2 -= amount;
            else config.released1 -= amount;
            emit RedemptionProceedsReleaseFailed(configId, receiver, amount);
            return;
        }
        emit RedemptionProceedsReleased(configId, receiver, amount);
    }

    function _setRenderer(address nextRenderer) private {
        if (nextRenderer == address(this) || nextRenderer.code.length == 0
            || !ERC165Checker.supportsInterface(nextRenderer, type(IDMXRenderer).interfaceId)) revert InvalidRenderer();
        address previous = renderer;
        renderer = nextRenderer;
        emit RendererUpdated(previous, nextRenderer);
        emit BatchMetadataUpdate(1, MAX_TOKEN_ID);
        emit ContractURIUpdated();
    }

    function _reserve(uint256 tokenId) private {
        if (issuedBits.get(tokenId)) revert AlreadyIssued();
        issuedBits.set(tokenId);
    }

    function _validateCardId(uint256 cardId) private pure {
        if (cardId == 0 || cardId > MAX_CARDS) revert InvalidTokenId();
    }

    function _validateRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
    }

    function _checkMinting() private view {
        _checkChain();
        if (mintingPaused) revert MintingPaused();
    }

    function _checkDeadline(uint256 deadline) private view {
        if (deadline <= block.timestamp || deadline - block.timestamp > MAX_AUTHORIZATION_LIFETIME) revert InvalidDeadline();
    }

    function _checkSignature(bytes32 digest, bytes calldata signature) private view {
        if (ECDSA.recoverCalldata(digest, signature) != quoteSigner) revert InvalidAuthorization();
    }

    function _checkChain() private view {
        if (block.chainid != 1 && block.chainid != 11155111 && block.chainid != 31337) revert UnsupportedChain();
    }
}
