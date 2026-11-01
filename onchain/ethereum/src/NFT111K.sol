pragma solidity 0.8.30;

import {ERC721A} from "erc721a/contracts/ERC721A.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract NFT111K is ERC721A, Ownable2Step, ReentrancyGuardTransient, EIP712 {
    using Strings for uint256;

    enum ItemKind {
        None,
        Artwork,
        Crate,
        Warehouse,
        ArtworkReceipt,
        CrateReceipt,
        Relic,
        RelicReceipt
    }

    struct DeliveryQuote {
        uint256 orderId;
        address wallet;
        uint256 fee;
        uint256 deadline;
        bytes32 receiptIdsHash;
        uint256 configId;
    }

    struct DeliveryConfig {
        address receiver1;
        address receiver2;
        uint16 receiver2Bps;
        uint256 totalReceived;
        uint256 released1;
        uint256 released2;
    }

    struct TokenInfo {
        uint8 kind;
        uint256 displayId;
        address holder;
    }

    struct FreeMintAllocation {
        address wallet;
        uint16 crateLimit;
        uint16 warehouseLimit;
        uint16 relicLimit;
    }

    struct FreeMintAllowance {
        uint16 crateLimit;
        uint16 warehouseLimit;
        uint16 relicLimit;
        uint16 cratesUsed;
        uint16 warehousesUsed;
        uint16 relicsUsed;
    }

    uint256 public constant MAX_ARTWORKS = 111_111;
    uint256 public constant MAX_ARTWORK_RECEIPTS = 222_222;
    address public constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395;
    uint256 public constant MAX_CRATES = 5_555;
    uint256 public constant MAX_WAREHOUSES = 505;
    uint256 public constant CRATES_PER_WAREHOUSE = 11;
    uint256 public constant MAX_RELICS = 18;
    uint256 public constant CRATES_PER_RELIC = 111;
    uint256 public constant MAX_PURCHASE_QUANTITY = 15;
    uint256 public constant MAX_DISCOUNT_ALLOWANCE = 10;
    uint256 public constant MAX_UNBOX_QUANTITY = 15;
    uint256 public constant MAX_TOKEN_INFO_BATCH_SIZE = 150;
    uint256 public constant MAX_METADATA_BATCH_SIZE = 30;
    uint256 public constant MAX_DELIVERY_ITEMS = 50;
    uint256 private constant MAX_DELIVERY_CONFIGS = 32;
    uint256 public constant MAX_MINT_RECIPIENTS = 32;
    uint256 public constant MINT_PAYOUT_GAS_LIMIT = 100_000;
    uint256 public constant MAX_QUOTE_LIFETIME = 10 minutes;
    uint256 public constant CRATE_TOKEN_START = 111_112;
    uint256 public constant WAREHOUSE_TOKEN_START = 116_667;
    uint256 public constant RELIC_TOKEN_START = 117_172;
    uint256 public constant ARTWORK_RECEIPT_OFFSET = 1_000_000;
    uint256 public constant CRATE_RECEIPT_OFFSET = 2_000_000;
    uint256 public constant RELIC_RECEIPT_OFFSET = 3_000_000;

    bytes32 private constant DELIVERY_TYPEHASH = keccak256(
        "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline,uint256 configId)"
    );
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("CrateClaim(address wallet,uint256 receiptId,bytes32 claimId,uint256 deadline)");

    uint256 public allocatedCrates;
    uint256 public warehousesMinted;
    uint256 public relicsAllocated;
    uint256 public relicsMinted;
    uint256 public cratePrice = 0.0001 ether;
    uint256 public warehousePrice = 0.0011 ether;
    uint256 public discountCratePrice = 0.00005 ether;
    uint256 public discountAllowance = 1;
    bytes32 public discountMerkleRoot;
    bool public saleActive;
    bool private saleStarted;
    bool public redemptionsPaused;
    address public quoteSigner;
    uint256 public deliveryConfigCount;
    mapping(uint256 => DeliveryConfig) public deliveryConfigs;
    address[] public mintRecipients;
    mapping(address => uint256) public mintSharesBps;
    mapping(address => uint256) public mintReleased;
    uint256 public totalMintReceived;
    uint256 public totalMintReleased;
    string public baseURI;
    mapping(uint256 => uint256) public warehouseFirstCrate;
    mapping(uint256 => uint256) public relicFirstCrate;
    mapping(uint256 => bool) public usedDeliveryOrders;
    mapping(bytes32 => bool) public usedClaims;
    mapping(address => uint256) public discountUsed;
    mapping(address => FreeMintAllowance) public freeMintAllowances;
    mapping(address => bool) private seaportApprovalRevoked;

    error InvalidQuantity();
    error InvalidRelicAllocation();
    error InvalidRelicId();
    error SoldOut();
    error SaleInactive();
    error RedemptionsPaused();
    error WrongPayment();
    error WrongOwner();
    error WrongItemKind();
    error OwnershipRenunciationDisabled();
    error InvalidAuthorization();
    error AuthorizationExpired();
    error AuthorizationTooLong();
    error AuthorizationAlreadyUsed();
    error InvalidAddress();
    error InvalidMintSplit();
    error InvalidMintRecipient();
    error InvalidDeliverySplit();
    error InvalidDeliveryConfig();
    error ProceedsPaymentFailed();
    error InsufficientMintPayoutGas();
    error TokenAlreadyIssued();
    error InvalidMetadataItem();
    error InvalidBaseURI();
    error DiscountInactive();
    error InvalidDiscountProof();
    error DiscountAllowanceExceeded();
    error InvalidDiscountConfig();
    error InvalidFreeMintConfig();
    error FreeMintAllowanceExceeded();

    event CratesPurchased(address indexed wallet, uint256 firstCrateToken, uint256 quantity, uint256 paid);
    event WarehousesPurchased(address indexed wallet, uint256 firstWarehouseToken, uint256 quantity, uint256 paid);
    event RelicsAllocated(uint256 quantity, uint256 paid);
    event RelicClaimed(address indexed wallet, uint256 indexed relicId, uint256 tokenId);
    event RelicUnboxed(uint256 indexed relicToken, address indexed owner, uint256 firstCrateToken, uint256 count);
    event WarehouseUnboxed(
        uint256 indexed warehouseToken, address indexed owner, uint256 firstCrateToken, uint256 count
    );
    event CrateUnboxed(uint256 indexed crateToken, address indexed owner, uint256 firstArtToken, uint256 count);
    event CratesUnboxed(
        address indexed owner, bytes32 indexed tokenIdsHash, uint256 firstArtToken, uint256 artworkCount
    );
    event DeliveryRedeemed(
        uint256 indexed orderId,
        address indexed wallet,
        uint256 fee,
        uint256[] tokenIds,
        uint256[] receiptIds,
        uint256 configId
    );
    event CrateReceiptClaimed(
        bytes32 indexed claimId, address indexed wallet, uint256 indexed receiptId, uint256[] receiptIds
    );
    event PricesUpdated(uint256 cratePrice, uint256 warehousePrice, uint256 discountCratePrice);
    event DiscountConfigUpdated(bytes32 root, uint256 allowance);
    event FreeMintAllowanceUpdated(address indexed wallet, uint16 crateLimit, uint16 warehouseLimit, uint16 relicLimit);
    event FreeMintClaimed(address indexed wallet, ItemKind indexed kind, uint256 quantity);
    event SaleStatusUpdated(bool active);
    event RedemptionsPauseUpdated(bool paused);
    event QuoteSignerUpdated(address indexed signer);
    event BaseURIUpdated(string baseURI);
    event MintProceedsReleased(address indexed recipient, uint256 amount);
    event MintProceedsReleaseFailed(address indexed recipient, uint256 amount);
    event DeliveryConfigRegistered(
        uint256 indexed configId, address indexed receiver1, address indexed receiver2, uint16 receiver2Bps
    );
    event DeliveryProceedsReleased(uint256 indexed configId, address indexed receiver, uint256 amount);
    event DeliveryProceedsReleaseFailed(uint256 indexed configId, address indexed receiver, uint256 amount);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    constructor(
        address initialOwner,
        address signer,
        address initialDeliveryReceiver,
        string memory baseURI_,
        bytes32 discountRoot,
        address[] memory mintRecipients_,
        uint256[] memory mintSharesBps_,
        FreeMintAllocation[] memory freeMintAllocations_
    ) ERC721A("111K", "111K") Ownable(initialOwner) EIP712("111K", "2") {
        if (signer == address(0)) revert InvalidAddress();
        _validateBaseURI(baseURI_);
        uint256 count = mintRecipients_.length;
        if (count < 2 || count > MAX_MINT_RECIPIENTS || mintSharesBps_.length != count) revert InvalidMintSplit();
        uint256 totalShares;
        for (uint256 i; i < count; ++i) {
            address recipient = mintRecipients_[i];
            if (recipient == address(0) || recipient == address(this) || mintSharesBps[recipient] != 0) {
                revert InvalidAddress();
            }
            uint256 share = mintSharesBps_[i];
            if (share == 0 || share > 10_000) revert InvalidMintSplit();
            totalShares += share;
            mintRecipients.push(recipient);
            mintSharesBps[recipient] = share;
        }
        if (totalShares != 10_000) revert InvalidMintSplit();
        _validateDeliveryPaymentReceiver(initialDeliveryReceiver);
        deliveryConfigCount = 1;
        deliveryConfigs[1].receiver1 = initialDeliveryReceiver;
        emit DeliveryConfigRegistered(1, initialDeliveryReceiver, address(0), 0);
        quoteSigner = signer;
        baseURI = baseURI_;
        discountMerkleRoot = discountRoot;
        if (freeMintAllocations_.length > 32) revert InvalidFreeMintConfig();
        for (uint256 i; i < freeMintAllocations_.length; ++i) {
            FreeMintAllocation memory allocation = freeMintAllocations_[i];
            for (uint256 j; j < i; ++j) {
                if (freeMintAllocations_[j].wallet == allocation.wallet) revert InvalidFreeMintConfig();
            }
            _setFreeMintAllowance(
                allocation.wallet, allocation.crateLimit, allocation.warehouseLimit, allocation.relicLimit
            );
        }
    }

    function mintCrates(uint256 quantity) external payable nonReentrant {
        _checkPurchase(quantity, quantity, cratePrice);
        _mintCrates(quantity);
    }

    function mintCratesDiscounted(uint256 quantity, bytes32[] calldata proof) external payable nonReentrant {
        _checkPurchase(quantity, quantity, discountCratePrice);
        if (discountMerkleRoot == bytes32(0)) revert DiscountInactive();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
        if (!MerkleProof.verifyCalldata(proof, discountMerkleRoot, leaf)) revert InvalidDiscountProof();
        uint256 used = discountUsed[msg.sender] + quantity;
        if (used > discountAllowance) revert DiscountAllowanceExceeded();
        discountUsed[msg.sender] = used;
        _mintCrates(quantity);
    }

    function mintWarehouses(uint256 quantity) external payable nonReentrant {
        _checkPurchase(quantity, quantity * CRATES_PER_WAREHOUSE, warehousePrice);
        _mintWarehouses(quantity);
    }

    function allocateRelics(uint256 quantity) external payable onlyOwner nonReentrant {
        if (saleStarted || relicsAllocated != 0 || quantity == 0 || quantity > MAX_RELICS) {
            revert InvalidRelicAllocation();
        }
        relicsAllocated = quantity;
        allocatedCrates = quantity * CRATES_PER_RELIC;
        totalMintReceived += msg.value;
        emit RelicsAllocated(quantity, msg.value);
    }

    function claimRelic(uint256 relicId) external nonReentrant {
        if (!saleActive) revert SaleInactive();
        if (relicId == 0 || relicId > MAX_RELICS) revert InvalidRelicId();
        if (relicsMinted == relicsAllocated) revert SoldOut();
        FreeMintAllowance storage allowance = freeMintAllowances[msg.sender];
        allowance.relicsUsed = _consumeFreeMintAllowance(allowance.relicsUsed, allowance.relicLimit, 1);
        relicFirstCrate[relicId] = relicsMinted * CRATES_PER_RELIC + 1;
        ++relicsMinted;
        uint256 tokenId = RELIC_TOKEN_START + relicId - 1;
        _mintSpotOnce(msg.sender, tokenId);
        emit RelicClaimed(msg.sender, relicId, tokenId);
    }

    function mintFree(ItemKind kind, uint256 quantity) external nonReentrant {
        uint256 units;
        if (kind == ItemKind.Crate) units = 1;
        else if (kind == ItemKind.Warehouse) units = CRATES_PER_WAREHOUSE;
        else revert WrongItemKind();
        _checkPurchase(quantity, quantity * units, 0);
        FreeMintAllowance storage allowance = freeMintAllowances[msg.sender];
        if (kind == ItemKind.Crate) {
            allowance.cratesUsed = _consumeFreeMintAllowance(allowance.cratesUsed, allowance.crateLimit, quantity);
            _mintCrates(quantity);
        } else {
            allowance.warehousesUsed =
                _consumeFreeMintAllowance(allowance.warehousesUsed, allowance.warehouseLimit, quantity);
            _mintWarehouses(quantity);
        }
        emit FreeMintClaimed(msg.sender, kind, quantity);
    }

    function unboxRelic(uint256 tokenId) external nonReentrant {
        uint256 number = _requireOwnedKind(tokenId, ItemKind.Relic);
        uint256 firstToken = CRATE_TOKEN_START + relicFirstCrate[number] - 1;
        _burn(tokenId);
        for (uint256 i; i < CRATES_PER_RELIC; ++i) {
            _mintSpotOnce(msg.sender, firstToken + i);
        }
        emit RelicUnboxed(tokenId, msg.sender, firstToken, CRATES_PER_RELIC);
    }

    function unboxWarehouse(uint256 tokenId) external nonReentrant {
        uint256 number = _requireOwnedKind(tokenId, ItemKind.Warehouse);
        uint256 firstToken = CRATE_TOKEN_START + warehouseFirstCrate[number] - 1;
        _burn(tokenId);
        for (uint256 i; i < CRATES_PER_WAREHOUSE; ++i) {
            _mintSpotOnce(msg.sender, firstToken + i);
        }
        emit WarehouseUnboxed(tokenId, msg.sender, firstToken, CRATES_PER_WAREHOUSE);
    }

    function unboxCrate(uint256 tokenId) external nonReentrant {
        uint256 crateNumber = _requireOwnedKind(tokenId, ItemKind.Crate);
        _burn(tokenId);
        _mintCrateArtworks(tokenId, crateNumber);
    }

    function unboxCrates(uint256[] calldata tokenIds) external nonReentrant {
        if (tokenIds.length == 0 || tokenIds.length > MAX_UNBOX_QUANTITY) revert InvalidQuantity();
        uint256[] memory crateNumbers = new uint256[](tokenIds.length);
        // Burn hooks must remain free of external calls until every selected crate is burned.
        for (uint256 i; i < tokenIds.length; ++i) {
            crateNumbers[i] = _requireOwnedKind(tokenIds[i], ItemKind.Crate);
            _burn(tokenIds[i]);
        }
        uint256 firstArtToken = _nextTokenId();
        for (uint256 i; i < tokenIds.length; ++i) {
            _mintCrateArtworks(tokenIds[i], crateNumbers[i]);
        }
        emit CratesUnboxed(msg.sender, keccak256(abi.encode(tokenIds)), firstArtToken, _nextTokenId() - firstArtToken);
    }

    function redeemForDelivery(uint256[] calldata tokenIds, DeliveryQuote calldata quote, bytes calldata signature)
        external
        payable
        nonReentrant
    {
        if (redemptionsPaused) revert RedemptionsPaused();
        if (tokenIds.length == 0 || tokenIds.length > MAX_DELIVERY_ITEMS) revert InvalidQuantity();
        if (quote.wallet != msg.sender || quote.orderId == 0) revert InvalidAuthorization();
        if (msg.value != quote.fee) revert WrongPayment();
        _checkDeadline(quote.deadline);
        if (usedDeliveryOrders[quote.orderId]) revert AuthorizationAlreadyUsed();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DELIVERY_TYPEHASH,
                    quote.wallet,
                    keccak256(abi.encode(tokenIds)),
                    quote.receiptIdsHash,
                    quote.orderId,
                    quote.fee,
                    quote.deadline,
                    quote.configId
                )
            )
        );
        if (ECDSA.recoverCalldata(digest, signature) != quoteSigner) revert InvalidAuthorization();
        DeliveryConfig storage deliveryConfig = deliveryConfigs[quote.configId];
        if (deliveryConfig.receiver1 == address(0)) revert InvalidDeliveryConfig();
        uint256[] memory receiptIds = new uint256[](tokenIds.length);
        for (uint256 i; i < tokenIds.length; ++i) {
            (uint8 kind, uint256 displayId, address holder) = getTokenInfo(tokenIds[i]);
            if (holder != msg.sender) revert WrongOwner();
            if (kind == uint8(ItemKind.Artwork)) receiptIds[i] = ARTWORK_RECEIPT_OFFSET + displayId;
            else if (kind == uint8(ItemKind.Crate)) receiptIds[i] = CRATE_RECEIPT_OFFSET + displayId;
            else if (kind == uint8(ItemKind.Relic)) receiptIds[i] = RELIC_RECEIPT_OFFSET + displayId;
            else revert WrongItemKind();
        }
        if (keccak256(abi.encode(receiptIds)) != quote.receiptIdsHash) revert InvalidAuthorization();
        deliveryConfig.totalReceived += msg.value;
        usedDeliveryOrders[quote.orderId] = true;
        // Burn hooks must remain free of external calls so upfront ownership checks stay valid.
        for (uint256 i; i < tokenIds.length; ++i) {
            _burn(tokenIds[i]);
        }
        for (uint256 i; i < receiptIds.length; ++i) {
            _mintSpotOnce(msg.sender, receiptIds[i]);
        }
        emit DeliveryRedeemed(quote.orderId, msg.sender, quote.fee, tokenIds, receiptIds, quote.configId);
    }

    function claimCrateReceipt(uint256 receiptId, bytes32 claimId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        if (redemptionsPaused) revert RedemptionsPaused();
        uint256 crateNumber = _requireOwnedKind(receiptId, ItemKind.CrateReceipt);
        if (claimId == bytes32(0)) revert InvalidAuthorization();
        _checkDeadline(deadline);
        if (usedClaims[claimId]) revert AuthorizationAlreadyUsed();
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, receiptId, claimId, deadline)));
        if (ECDSA.recoverCalldata(digest, signature) != quoteSigner) revert InvalidAuthorization();
        usedClaims[claimId] = true;
        _burn(receiptId);
        uint256 count = _crateContentsCount(crateNumber);
        uint256 firstDisplayId = MAX_ARTWORKS + (crateNumber - 1) * 20 + 1;
        uint256[] memory receiptIds = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            receiptIds[i] = ARTWORK_RECEIPT_OFFSET + firstDisplayId + i;
            _mintSpotOnce(msg.sender, receiptIds[i]);
        }
        emit CrateReceiptClaimed(claimId, msg.sender, receiptId, receiptIds);
    }

    function approve(address to, uint256 tokenId) public payable override {
        if (msg.value != 0) revert WrongPayment();
        super.approve(to, tokenId);
    }

    function isApprovedForAll(address holder, address operator) public view override returns (bool) {
        if (operator == SEAPORT && (block.chainid == 1 || block.chainid == 11155111)) {
            return !seaportApprovalRevoked[holder];
        }
        return super.isApprovedForAll(holder, operator);
    }

    function setApprovalForAll(address operator, bool approved) public override {
        if (operator == SEAPORT) seaportApprovalRevoked[_msgSenderERC721A()] = !approved;
        super.setApprovalForAll(operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public payable override {
        if (msg.value != 0) revert WrongPayment();
        super.transferFrom(from, to, tokenId);
    }

    function getTokenInfo(uint256 tokenId) public view returns (uint8 kind, uint256 displayId, address holder) {
        TokenOwnership memory ownership = tokenId <= MAX_ARTWORKS ? _artworkOwnership(tokenId) : _ownershipAt(tokenId);
        if (ownership.addr == address(0) || ownership.burned) return (0, 0, address(0));
        if (tokenId <= MAX_ARTWORKS) {
            return (uint8(ItemKind.Artwork), tokenId, ownership.addr);
        }
        holder = ownership.addr;
        if (tokenId >= CRATE_TOKEN_START && tokenId < CRATE_TOKEN_START + MAX_CRATES) {
            return (uint8(ItemKind.Crate), tokenId - CRATE_TOKEN_START + 1, holder);
        }
        if (tokenId >= WAREHOUSE_TOKEN_START && tokenId < WAREHOUSE_TOKEN_START + MAX_WAREHOUSES) {
            return (uint8(ItemKind.Warehouse), tokenId - WAREHOUSE_TOKEN_START + 1, holder);
        }
        if (tokenId >= RELIC_TOKEN_START && tokenId < RELIC_TOKEN_START + MAX_RELICS) {
            return (uint8(ItemKind.Relic), tokenId - RELIC_TOKEN_START + 1, holder);
        }
        if (tokenId > ARTWORK_RECEIPT_OFFSET && tokenId <= ARTWORK_RECEIPT_OFFSET + MAX_ARTWORK_RECEIPTS) {
            return (uint8(ItemKind.ArtworkReceipt), tokenId - ARTWORK_RECEIPT_OFFSET, holder);
        }
        if (tokenId > CRATE_RECEIPT_OFFSET && tokenId <= CRATE_RECEIPT_OFFSET + MAX_CRATES) {
            return (uint8(ItemKind.CrateReceipt), tokenId - CRATE_RECEIPT_OFFSET, holder);
        }
        if (tokenId > RELIC_RECEIPT_OFFSET && tokenId <= RELIC_RECEIPT_OFFSET + MAX_RELICS) {
            return (uint8(ItemKind.RelicReceipt), tokenId - RELIC_RECEIPT_OFFSET, holder);
        }
        return (0, 0, address(0));
    }

    function getTokenInfos(uint256[] calldata tokenIds) external view returns (TokenInfo[] memory infos) {
        if (tokenIds.length > MAX_TOKEN_INFO_BATCH_SIZE) revert InvalidQuantity();
        infos = new TokenInfo[](tokenIds.length);
        for (uint256 i; i < tokenIds.length; ++i) {
            (infos[i].kind, infos[i].displayId, infos[i].holder) = getTokenInfo(tokenIds[i]);
        }
    }

    function getRelicClaimedMask() external view returns (uint256 mask) {
        for (uint256 i; i < MAX_RELICS; ++i) {
            if (relicFirstCrate[i + 1] != 0) mask |= 1 << i;
        }
    }

    function stats(address wallet)
        external
        view
        returns (
            uint256 allocatedCrates_,
            uint256 warehousesMinted_,
            uint256 artworksMinted_,
            uint256 cratePrice_,
            uint256 warehousePrice_,
            bool saleActive_,
            bytes32 discountMerkleRoot_,
            uint256 discountCratePrice_,
            uint256 discountAllowance_,
            uint256 discountUsed_,
            uint256 relicsAllocated_,
            uint256 relicsMinted_
        )
    {
        allocatedCrates_ = allocatedCrates;
        warehousesMinted_ = warehousesMinted;
        artworksMinted_ = _nextTokenId() - 1;
        cratePrice_ = cratePrice;
        warehousePrice_ = warehousePrice;
        saleActive_ = saleActive;
        discountMerkleRoot_ = discountMerkleRoot;
        discountCratePrice_ = discountCratePrice;
        discountAllowance_ = discountAllowance;
        discountUsed_ = discountUsed[wallet];
        relicsAllocated_ = relicsAllocated;
        relicsMinted_ = relicsMinted;
    }

    function remainingCrates() external view returns (uint256) {
        return MAX_CRATES - allocatedCrates;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        (uint8 kind,,) = getTokenInfo(tokenId);
        if (kind == 0) revert URIQueryForNonexistentToken();
        return _tokenURI(tokenId);
    }

    function previewTokenURI(uint8 kind, uint256 displayId) external view returns (string memory) {
        return _tokenURI(_metadataTokenId(kind, displayId));
    }

    function previewTokenURIs(uint8[] calldata kinds, uint256[] calldata displayIds)
        external
        view
        returns (string[] memory uris)
    {
        if (kinds.length != displayIds.length || kinds.length > MAX_METADATA_BATCH_SIZE) revert InvalidQuantity();
        uris = new string[](kinds.length);
        for (uint256 i; i < kinds.length; ++i) {
            uris[i] = _tokenURI(_metadataTokenId(kinds[i], displayIds[i]));
        }
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0x49064906 || super.supportsInterface(interfaceId);
    }

    function renounceOwnership() public override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    function setPrices(uint256 cratePrice_, uint256 warehousePrice_, uint256 discountCratePrice_) external onlyOwner {
        if (discountCratePrice_ > cratePrice_) revert InvalidDiscountConfig();
        cratePrice = cratePrice_;
        warehousePrice = warehousePrice_;
        discountCratePrice = discountCratePrice_;
        emit PricesUpdated(cratePrice_, warehousePrice_, discountCratePrice_);
    }

    function setDiscountConfig(bytes32 root, uint256 allowance) external onlyOwner {
        if (allowance == 0 || allowance > MAX_DISCOUNT_ALLOWANCE) revert InvalidDiscountConfig();
        discountMerkleRoot = root;
        discountAllowance = allowance;
        emit DiscountConfigUpdated(root, allowance);
    }

    function setFreeMintAllowances(
        address[] calldata wallets,
        uint16 crateLimit,
        uint16 warehouseLimit,
        uint16 relicLimit
    ) external onlyOwner {
        if (wallets.length == 0 || wallets.length > 32) revert InvalidFreeMintConfig();
        for (uint256 i; i < wallets.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (wallets[j] == wallets[i]) revert InvalidFreeMintConfig();
            }
            _setFreeMintAllowance(wallets[i], crateLimit, warehouseLimit, relicLimit);
        }
    }

    function setSaleActive(bool active) external onlyOwner {
        if (active) saleStarted = true;
        saleActive = active;
        emit SaleStatusUpdated(active);
    }

    function setRedemptionsPaused(bool paused) external onlyOwner {
        redemptionsPaused = paused;
        emit RedemptionsPauseUpdated(paused);
    }

    function setQuoteSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidAddress();
        quoteSigner = signer;
        emit QuoteSignerUpdated(signer);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _validateBaseURI(baseURI_);
        baseURI = baseURI_;
        emit BaseURIUpdated(baseURI_);
        emit BatchMetadataUpdate(1, RELIC_RECEIPT_OFFSET + MAX_RELICS);
    }

    function mintRecipientCount() external view returns (uint256) {
        return mintRecipients.length;
    }

    function releasableMint(address recipient) public view returns (uint256) {
        uint256 share = mintSharesBps[recipient];
        uint256 entitlement = _shareOf(totalMintReceived, share);
        return entitlement - mintReleased[recipient];
    }

    function releaseMint(address recipient) external nonReentrant {
        if (mintSharesBps[recipient] == 0) revert InvalidMintRecipient();
        _releaseMint(recipient, false);
    }

    function releaseAllMint() external nonReentrant {
        uint256 count = mintRecipients.length;
        for (uint256 i; i < count; ++i) {
            _releaseMint(mintRecipients[i], true);
        }
    }

    function _releaseMint(address recipient, bool batch) private {
        uint256 amount = releasableMint(recipient);
        if (amount == 0) return;
        mintReleased[recipient] += amount;
        totalMintReleased += amount;
        bool paid;
        if (batch) {
            paid = _payWithBoundedGas(recipient, amount);
        } else {
            (paid,) = payable(recipient).call{value: amount}("");
        }
        if (!paid) {
            if (!batch) revert ProceedsPaymentFailed();
            mintReleased[recipient] -= amount;
            totalMintReleased -= amount;
            emit MintProceedsReleaseFailed(recipient, amount);
            return;
        }
        emit MintProceedsReleased(recipient, amount);
    }

    function registerDeliveryConfig(address receiver1, address receiver2, uint16 receiver2Bps)
        external
        onlyOwner
        returns (uint256 configId)
    {
        if (deliveryConfigCount == MAX_DELIVERY_CONFIGS) revert InvalidDeliveryConfig();
        _validateDeliveryPaymentReceiver(receiver1);
        if (receiver2 == address(0)) {
            if (receiver2Bps != 0) revert InvalidDeliverySplit();
        } else {
            _validateDeliveryPaymentReceiver(receiver2);
            if (receiver1 == receiver2 || receiver2Bps == 0 || receiver2Bps >= 10_000) revert InvalidDeliverySplit();
        }
        configId = ++deliveryConfigCount;
        DeliveryConfig storage config = deliveryConfigs[configId];
        config.receiver1 = receiver1;
        config.receiver2 = receiver2;
        config.receiver2Bps = receiver2Bps;
        emit DeliveryConfigRegistered(configId, receiver1, receiver2, receiver2Bps);
    }

    function _releasableDelivery(uint256 configId) private view returns (uint256 amount1, uint256 amount2) {
        DeliveryConfig storage config = deliveryConfigs[configId];
        if (config.receiver1 == address(0)) revert InvalidDeliveryConfig();
        uint256 total = config.totalReceived;
        uint256 share = config.receiver2Bps;
        uint256 entitlement2 = _shareOf(total, share);
        amount1 = total - entitlement2 - config.released1;
        amount2 = entitlement2 - config.released2;
    }

    function releaseDelivery() external nonReentrant {
        uint256 count = deliveryConfigCount;
        for (uint256 configId = 1; configId <= count; ++configId) {
            (uint256 amount1, uint256 amount2) = _releasableDelivery(configId);
            _releaseDelivery(configId, false, amount1, true);
            _releaseDelivery(configId, true, amount2, true);
        }
    }

    function releaseDeliveryFor(uint256 configId, bool secondary) external nonReentrant {
        (uint256 amount1, uint256 amount2) = _releasableDelivery(configId);
        _releaseDelivery(configId, secondary, secondary ? amount2 : amount1, false);
    }

    function _releaseDelivery(uint256 configId, bool secondary, uint256 amount, bool batch) private {
        if (amount == 0) return;
        DeliveryConfig storage config = deliveryConfigs[configId];
        address receiver = secondary ? config.receiver2 : config.receiver1;
        if (secondary) config.released2 += amount;
        else config.released1 += amount;
        bool paid;
        if (batch) paid = _payWithBoundedGas(receiver, amount);
        else (paid,) = payable(receiver).call{value: amount}("");
        if (!paid) {
            if (!batch) revert ProceedsPaymentFailed();
            if (secondary) config.released2 -= amount;
            else config.released1 -= amount;
            emit DeliveryProceedsReleaseFailed(configId, receiver, amount);
            return;
        }
        emit DeliveryProceedsReleased(configId, receiver, amount);
    }

    function _shareOf(uint256 total, uint256 share) private pure returns (uint256) {
        return (total / 10_000) * share + ((total % 10_000) * share) / 10_000;
    }

    function _payWithBoundedGas(address receiver, uint256 amount) private returns (bool paid) {
        // Reserve gas for call overhead and failure accounting without underfunding the recipient call.
        if (gasleft() < MINT_PAYOUT_GAS_LIMIT + 50_000) revert InsufficientMintPayoutGas();
        assembly ("memory-safe") {
            paid := call(MINT_PAYOUT_GAS_LIMIT, receiver, amount, 0, 0, 0, 0)
        }
    }

    function _validateDeliveryPaymentReceiver(address receiver) private view {
        if (receiver == address(0) || receiver == address(this) || mintSharesBps[receiver] != 0) {
            revert InvalidAddress();
        }
    }

    function _checkPurchase(uint256 quantity, uint256 crateUnits, uint256 unitPrice) private view {
        if (!saleActive) revert SaleInactive();
        if (quantity == 0 || quantity > MAX_PURCHASE_QUANTITY) revert InvalidQuantity();
        if (crateUnits > MAX_CRATES - allocatedCrates) revert SoldOut();
        if (msg.value != quantity * unitPrice) revert WrongPayment();
    }

    function _mintCrates(uint256 quantity) private {
        uint256 firstCrate = allocatedCrates + 1;
        // Single-crate mints skip the shared allocator's container mapping.
        _mintAllocated(quantity, firstCrate, 1, CRATE_TOKEN_START, warehouseFirstCrate);
        emit CratesPurchased(msg.sender, CRATE_TOKEN_START + firstCrate - 1, quantity, msg.value);
    }

    function _mintWarehouses(uint256 quantity) private {
        uint256 firstWarehouse = warehousesMinted + 1;
        warehousesMinted += quantity;
        _mintAllocated(quantity, firstWarehouse, CRATES_PER_WAREHOUSE, WAREHOUSE_TOKEN_START, warehouseFirstCrate);
        emit WarehousesPurchased(msg.sender, WAREHOUSE_TOKEN_START + firstWarehouse - 1, quantity, msg.value);
    }

    function _mintAllocated(
        uint256 quantity,
        uint256 firstItem,
        uint256 crateUnits,
        uint256 tokenStart,
        mapping(uint256 => uint256) storage firstCrates
    ) private {
        uint256 firstCrate = allocatedCrates + 1;
        allocatedCrates += quantity * crateUnits;
        totalMintReceived += msg.value;
        // Purchase checks bound every allocation and token index below the collection limits.
        unchecked {
            for (uint256 i; i < quantity; ++i) {
                if (crateUnits != 1) firstCrates[firstItem + i] = firstCrate + i * crateUnits;
                _mintSpotOnce(msg.sender, tokenStart + firstItem + i - 1);
            }
        }
    }

    function _setFreeMintAllowance(address wallet, uint16 crates, uint16 warehouses, uint16 relics) private {
        if (wallet == address(0) || wallet == address(this)) revert InvalidAddress();
        if (crates > MAX_CRATES || warehouses > MAX_WAREHOUSES || relics > MAX_RELICS) {
            revert InvalidFreeMintConfig();
        }
        FreeMintAllowance storage allowance = freeMintAllowances[wallet];
        allowance.crateLimit = crates;
        allowance.warehouseLimit = warehouses;
        allowance.relicLimit = relics;
        emit FreeMintAllowanceUpdated(wallet, crates, warehouses, relics);
    }

    function _consumeFreeMintAllowance(uint16 used, uint16 limit, uint256 quantity) private pure returns (uint16) {
        uint256 total = uint256(used) + quantity;
        if (total > limit) revert FreeMintAllowanceExceeded();
        return uint16(total);
    }

    function _requireOwnedKind(uint256 tokenId, ItemKind expected) private view returns (uint256 displayId) {
        (uint8 kind, uint256 number, address holder) = getTokenInfo(tokenId);
        if (holder != msg.sender) revert WrongOwner();
        if (kind != uint8(expected)) revert WrongItemKind();
        return number;
    }

    function _artworkOwnership(uint256 tokenId) private view returns (TokenOwnership memory) {
        if (tokenId == 0 || tokenId >= _nextTokenId()) {
            return TokenOwnership(address(0), 0, false, 0);
        }
        unchecked {
            while (!_ownershipIsInitialized(tokenId)) --tokenId;
        }
        return _ownershipAt(tokenId);
    }

    function _mintSpotOnce(address recipient, uint256 tokenId) private {
        if (_ownershipIsInitialized(tokenId)) revert TokenAlreadyIssued();
        _safeMintSpot(recipient, tokenId);
    }

    function _mintCrateArtworks(uint256 tokenId, uint256 crateNumber) private {
        uint256 count = _crateContentsCount(crateNumber);
        uint256 firstToken = _nextTokenId();
        _safeMint(msg.sender, count);
        emit CrateUnboxed(tokenId, msg.sender, firstToken, count);
    }

    function _checkDeadline(uint256 deadline) private view {
        if (deadline < block.timestamp) revert AuthorizationExpired();
        if (deadline > block.timestamp + MAX_QUOTE_LIFETIME) revert AuthorizationTooLong();
    }

    function _crateContentsCount(uint256 crateNumber) private pure returns (uint256) {
        return crateNumber == MAX_CRATES ? 31 : 20;
    }

    function _tokenURI(uint256 tokenId) private view returns (string memory) {
        return string.concat(baseURI, tokenId.toString(), ".json");
    }

    function _metadataTokenId(uint8 kind, uint256 displayId) private pure returns (uint256) {
        if (displayId == 0) revert InvalidMetadataItem();
        if (kind == uint8(ItemKind.Artwork) && displayId <= MAX_ARTWORKS) return displayId;
        if (kind == uint8(ItemKind.Crate) && displayId <= MAX_CRATES) return CRATE_TOKEN_START + displayId - 1;
        if (kind == uint8(ItemKind.Warehouse) && displayId <= MAX_WAREHOUSES) {
            return WAREHOUSE_TOKEN_START + displayId - 1;
        }
        if (kind == uint8(ItemKind.Relic) && displayId <= MAX_RELICS) {
            return RELIC_TOKEN_START + displayId - 1;
        }
        if (kind == uint8(ItemKind.ArtworkReceipt) && displayId <= MAX_ARTWORK_RECEIPTS) {
            return ARTWORK_RECEIPT_OFFSET + displayId;
        }
        if (kind == uint8(ItemKind.CrateReceipt) && displayId <= MAX_CRATES) {
            return CRATE_RECEIPT_OFFSET + displayId;
        }
        if (kind == uint8(ItemKind.RelicReceipt) && displayId <= MAX_RELICS) {
            return RELIC_RECEIPT_OFFSET + displayId;
        }
        revert InvalidMetadataItem();
    }

    function _validateBaseURI(string memory baseURI_) private view {
        bytes memory value = bytes(baseURI_);
        if (value.length < 9 || value[value.length - 1] != "/") revert InvalidBaseURI();
        bool secure = bytes8(value) == bytes8("https://");
        bool local = block.chainid == 31337 && bytes7(value) == bytes7("http://");
        if ((!secure && !local) || value[secure ? 8 : 7] == "/") revert InvalidBaseURI();
        for (uint256 i; i < value.length; ++i) {
            bytes1 character = value[i];
            if (
                uint8(character) <= 32 || uint8(character) >= 127 || character == "?" || character == "#"
                    || character == "\\" || character == "@"
            ) revert InvalidBaseURI();
        }
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    function _sequentialUpTo() internal pure override returns (uint256) {
        return MAX_ARTWORKS;
    }
}
