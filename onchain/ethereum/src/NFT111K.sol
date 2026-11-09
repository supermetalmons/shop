pragma solidity 0.8.38;

import {ERC721A} from "erc721a/contracts/ERC721A.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract NFT111K is ERC721A, Ownable2Step, ReentrancyGuardTransient, EIP712 {
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

    struct PublicRelicSale {
        uint256 priceWei;
        uint8 limit;
        uint8 minted;
        bool active;
    }

    struct PublicRelicFreeMintAllowance {
        uint16 limit;
        uint16 used;
    }

    struct Stats {
        uint256 allocatedCrates_;
        uint256 warehousesMinted_;
        uint256 artworksMinted_;
        uint256 cratePrice_;
        uint256 warehousePrice_;
        bool saleActive_;
        bytes32 discountMerkleRoot_;
        uint256 discountCratePrice_;
        uint256 discountAllowance_;
        uint256 discountUsed_;
        uint256 relicsAllocated_;
        uint256 relicsMinted_;
        uint256 maxDiscountedMints_;
        uint256 totalDiscountedMints_;
        uint256 publicRelicsMinted_;
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
    uint256 private constant METADATA_LIMITS = (MAX_ARTWORKS << 18) | (MAX_CRATES << 36) | (MAX_WAREHOUSES << 54)
        | (MAX_ARTWORK_RECEIPTS << 72) | (MAX_CRATES << 90) | (MAX_RELICS << 108) | (MAX_RELICS << 126);
    uint256 private constant METADATA_OFFSETS = ((CRATE_TOKEN_START - 1) << 44) | ((WAREHOUSE_TOKEN_START - 1) << 66)
        | (ARTWORK_RECEIPT_OFFSET << 88) | (CRATE_RECEIPT_OFFSET << 110) | ((RELIC_TOKEN_START - 1) << 132)
        | (RELIC_RECEIPT_OFFSET << 154);
    uint256 private constant URI_CHARACTERS = ((uint256(1) << 127) - (uint256(1) << 33))
        & ~((uint256(1) << 35) | (uint256(1) << 63) | (uint256(1) << 64) | (uint256(1) << 92));

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
    uint256 public maxDiscountedMints;
    uint256 public totalDiscountedMints;
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
    PublicRelicSale private publicRelicSale;
    mapping(address => PublicRelicFreeMintAllowance) private publicRelicFreeMintAllowances;

    error InvalidQuantity();
    error InvalidRelicAllocation();
    error InvalidRelicId();
    error InvalidPublicRelicConfig();
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
    error DiscountCapExceeded();
    error InvalidDiscountConfig();
    error InvalidFreeMintConfig();
    error FreeMintAllowanceExceeded();

    event CratesPurchased(address indexed wallet, uint256 firstCrateToken, uint256 quantity, uint256 paid);
    event WarehousesPurchased(address indexed wallet, uint256 firstWarehouseToken, uint256 quantity, uint256 paid);
    event RelicsAllocated(uint256 quantity, uint256 paid);
    event RelicClaimed(address indexed wallet, uint256 indexed relicId, uint256 tokenId);
    event PublicRelicSaleUpdated(uint256 limit, uint256 priceWei, bool active);
    event PublicRelicFreeMintAllowanceUpdated(address indexed wallet, uint16 limit);
    event PublicRelicMinted(
        address indexed wallet, uint256 indexed relicId, uint256 tokenId, uint256 paid, bool freeMint
    );
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
        FreeMintAllocation[] memory freeMintAllocations_,
        uint256 maxDiscountedMints_
    ) ERC721A("111K", "111K") Ownable(initialOwner) EIP712("111K", "2") {
        if (signer == address(0)) revert InvalidAddress();
        if (maxDiscountedMints_ > MAX_CRATES) revert InvalidDiscountConfig();
        maxDiscountedMints = maxDiscountedMints_;
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
        uint256 total = totalDiscountedMints + quantity;
        if (total > maxDiscountedMints) revert DiscountCapExceeded();
        discountUsed[msg.sender] = used;
        totalDiscountedMints = total;
        _mintCrates(quantity);
    }

    function mintWarehouses(uint256 quantity) external payable nonReentrant {
        _checkPurchase(quantity, quantity * CRATES_PER_WAREHOUSE, warehousePrice);
        _mintWarehouses(quantity);
    }

    function allocateRelics(uint256 quantity) external payable onlyOwner nonReentrant {
        unchecked {
            if (saleStarted || relicsAllocated != 0 || quantity - 1 >= MAX_RELICS - publicRelicSale.limit) {
                revert InvalidRelicAllocation();
            }
        }
        relicsAllocated = quantity;
        unchecked {
            allocatedCrates = quantity * CRATES_PER_RELIC;
        }
        if (msg.value != 0) totalMintReceived += msg.value;
        emit RelicsAllocated(quantity, msg.value);
    }

    function claimRelic(uint256 relicId) external nonReentrant {
        if (!saleActive) revert SaleInactive();
        unchecked {
            if (relicId - 1 >= MAX_RELICS) revert InvalidRelicId();
        }
        if (relicsMinted == relicsAllocated) revert SoldOut();
        FreeMintAllowance storage allowance = freeMintAllowances[msg.sender];
        allowance.relicsUsed = _consumeFreeMintAllowance(allowance.relicsUsed, allowance.relicLimit, 1);
        unchecked {
            relicFirstCrate[relicId] = relicsMinted * CRATES_PER_RELIC + 1;
            ++relicsMinted;
            uint256 tokenId = RELIC_TOKEN_START + relicId - 1;
            _mintSpotOnce(msg.sender, tokenId);
            emit RelicClaimed(msg.sender, relicId, tokenId);
        }
    }

    function mintRelic(uint256 relicId) external payable nonReentrant {
        _mintPublicRelic(relicId, false);
    }

    function mintFreeRelic(uint256 relicId) external nonReentrant {
        _mintPublicRelic(relicId, true);
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
        uint256 firstToken = _unboxContainer(tokenId, relicFirstCrate[number], CRATES_PER_RELIC);
        emit RelicUnboxed(tokenId, msg.sender, firstToken, CRATES_PER_RELIC);
    }

    function unboxWarehouse(uint256 tokenId) external nonReentrant {
        uint256 number = _requireOwnedKind(tokenId, ItemKind.Warehouse);
        uint256 firstToken = _unboxContainer(tokenId, warehouseFirstCrate[number], CRATES_PER_WAREHOUSE);
        emit WarehouseUnboxed(tokenId, msg.sender, firstToken, CRATES_PER_WAREHOUSE);
    }

    function unboxCrate(uint256 tokenId) external nonReentrant {
        uint256 crateNumber = _requireOwnedKind(tokenId, ItemKind.Crate);
        _burn(tokenId);
        _mintCrateArtworks(tokenId, crateNumber);
    }

    function unboxCrates(uint256[] calldata tokenIds) external nonReentrant {
        unchecked {
            if (tokenIds.length - 1 >= MAX_UNBOX_QUANTITY) revert InvalidQuantity();
        }
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
        unchecked {
            emit CratesUnboxed(
                msg.sender, keccak256(abi.encode(tokenIds)), firstArtToken, _nextTokenId() - firstArtToken
            );
        }
    }

    function redeemForDelivery(uint256[] calldata tokenIds, DeliveryQuote calldata quote, bytes calldata signature)
        external
        payable
        nonReentrant
    {
        if (redemptionsPaused) revert RedemptionsPaused();
        unchecked {
            if (tokenIds.length - 1 >= MAX_DELIVERY_ITEMS) revert InvalidQuantity();
        }
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
        _checkSignature(digest, signature);
        DeliveryConfig storage deliveryConfig = deliveryConfigs[quote.configId];
        if (deliveryConfig.receiver1 == address(0)) revert InvalidDeliveryConfig();
        uint256[] memory receiptIds = new uint256[](tokenIds.length);
        for (uint256 i; i < tokenIds.length; ++i) {
            (uint8 kind, uint256 displayId, address holder) = getTokenInfo(tokenIds[i]);
            if (holder != msg.sender) revert WrongOwner();
            unchecked {
                if (kind == uint8(ItemKind.Artwork)) receiptIds[i] = ARTWORK_RECEIPT_OFFSET + displayId;
                else if (kind == uint8(ItemKind.Crate)) receiptIds[i] = CRATE_RECEIPT_OFFSET + displayId;
                else if (kind == uint8(ItemKind.Relic)) receiptIds[i] = RELIC_RECEIPT_OFFSET + displayId;
                else revert WrongItemKind();
            }
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
        _checkSignature(digest, signature);
        usedClaims[claimId] = true;
        _burn(receiptId);
        uint256 count = _crateContentsCount(crateNumber);
        uint256 firstReceiptId;
        unchecked {
            firstReceiptId = ARTWORK_RECEIPT_OFFSET + MAX_ARTWORKS + (crateNumber - 1) * 20 + 1;
        }
        uint256[] memory receiptIds = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            unchecked {
                receiptIds[i] = firstReceiptId + i;
            }
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
        unchecked {
            if (tokenId < WAREHOUSE_TOKEN_START) {
                return (uint8(ItemKind.Crate), tokenId - CRATE_TOKEN_START + 1, holder);
            }
            if (tokenId < RELIC_TOKEN_START) {
                return (uint8(ItemKind.Warehouse), tokenId - WAREHOUSE_TOKEN_START + 1, holder);
            }
            if (tokenId < RELIC_TOKEN_START + MAX_RELICS) {
                return (uint8(ItemKind.Relic), tokenId - RELIC_TOKEN_START + 1, holder);
            }
            if (tokenId < CRATE_RECEIPT_OFFSET) {
                return (uint8(ItemKind.ArtworkReceipt), tokenId - ARTWORK_RECEIPT_OFFSET, holder);
            }
            if (tokenId < RELIC_RECEIPT_OFFSET) {
                return (uint8(ItemKind.CrateReceipt), tokenId - CRATE_RECEIPT_OFFSET, holder);
            }
            return (uint8(ItemKind.RelicReceipt), tokenId - RELIC_RECEIPT_OFFSET, holder);
        }
    }

    function getTokenInfos(uint256[] calldata tokenIds) external view returns (TokenInfo[] memory infos) {
        if (tokenIds.length > MAX_TOKEN_INFO_BATCH_SIZE) revert InvalidQuantity();
        infos = new TokenInfo[](tokenIds.length);
        for (uint256 i; i < tokenIds.length; ++i) {
            (uint8 kind, uint256 displayId, address holder) = getTokenInfo(tokenIds[i]);
            infos[i] = TokenInfo(kind, displayId, holder);
        }
    }

    function getRelicClaimedMask() external view returns (uint256 mask) {
        for (uint256 i; i < MAX_RELICS; ++i) {
            if (relicFirstCrate[i + 1] != 0) mask |= 1 << i;
        }
    }

    function stats(address wallet) external view returns (Stats memory snapshot) {
        snapshot.allocatedCrates_ = allocatedCrates;
        snapshot.warehousesMinted_ = warehousesMinted;
        snapshot.artworksMinted_ = _nextTokenId() - 1;
        snapshot.cratePrice_ = cratePrice;
        snapshot.warehousePrice_ = warehousePrice;
        snapshot.saleActive_ = saleActive;
        snapshot.discountMerkleRoot_ = discountMerkleRoot;
        snapshot.discountCratePrice_ = discountCratePrice;
        snapshot.discountAllowance_ = discountAllowance;
        snapshot.discountUsed_ = discountUsed[wallet];
        snapshot.relicsAllocated_ = relicsAllocated;
        snapshot.relicsMinted_ = relicsMinted;
        snapshot.maxDiscountedMints_ = maxDiscountedMints;
        snapshot.totalDiscountedMints_ = totalDiscountedMints;
        snapshot.publicRelicsMinted_ = publicRelicSale.minted;
        // Stats contains fifteen static ABI words, all initialized above.
        assembly ("memory-safe") {
            return(snapshot, 480)
        }
    }

    function publicRelicStats(address wallet)
        external
        view
        returns (
            uint256 limit,
            uint256 minted,
            uint256 priceWei,
            bool active,
            uint256 mintable,
            uint16 freeLimit,
            uint16 freeUsed
        )
    {
        PublicRelicSale storage sale = publicRelicSale;
        limit = sale.limit;
        minted = sale.minted;
        priceWei = sale.priceWei;
        active = sale.active;
        if (saleActive && active) {
            unchecked {
                uint256 capacity = (MAX_CRATES - allocatedCrates) / CRATES_PER_RELIC;
                mintable = limit - minted;
                if (capacity < mintable) mintable = capacity;
            }
        }
        PublicRelicFreeMintAllowance storage allowance = publicRelicFreeMintAllowances[wallet];
        freeLimit = allowance.limit;
        freeUsed = allowance.used;
    }

    function remainingCrates() external view returns (uint256) {
        unchecked {
            return MAX_CRATES - allocatedCrates;
        }
    }

    function contractURI() external pure returns (string memory) {
        return "https://cdn.mons.shop/111k/collection.json";
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
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
        unchecked {
            if (allowance - 1 >= MAX_DISCOUNT_ALLOWANCE) revert InvalidDiscountConfig();
        }
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
        _validateFreeMintWallets(wallets);
        for (uint256 i; i < wallets.length; ++i) {
            _setFreeMintAllowance(wallets[i], crateLimit, warehouseLimit, relicLimit);
        }
    }

    function setPublicRelicSale(uint256 limit, uint256 priceWei, bool active) external onlyOwner {
        if (limit < publicRelicSale.minted || limit > MAX_RELICS - relicsAllocated) {
            revert InvalidPublicRelicConfig();
        }
        publicRelicSale.limit = uint8(limit);
        publicRelicSale.priceWei = priceWei;
        publicRelicSale.active = active;
        emit PublicRelicSaleUpdated(limit, priceWei, active);
    }

    function setPublicRelicFreeMintAllowances(address[] calldata wallets, uint16 limit) external onlyOwner {
        if (limit > MAX_RELICS) revert InvalidFreeMintConfig();
        _validateFreeMintWallets(wallets);
        for (uint256 i; i < wallets.length; ++i) {
            _validateFreeMintWallet(wallets[i]);
            publicRelicFreeMintAllowances[wallets[i]].limit = limit;
            emit PublicRelicFreeMintAllowanceUpdated(wallets[i], limit);
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
        uint256 released = mintReleased[recipient];
        uint256 entitlement = _shareOf(totalMintReceived, mintSharesBps[recipient]);
        uint256 amount = entitlement - released;
        if (amount == 0) return;
        mintReleased[recipient] = entitlement;
        uint256 totalReleased = totalMintReleased;
        totalMintReleased = totalReleased + amount;
        if (!_payProceeds(recipient, amount, batch)) {
            if (!batch) revert ProceedsPaymentFailed();
            mintReleased[recipient] = released;
            totalMintReleased = totalReleased;
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
        if (!_payProceeds(receiver, amount, batch)) {
            if (!batch) revert ProceedsPaymentFailed();
            if (secondary) config.released2 -= amount;
            else config.released1 -= amount;
            emit DeliveryProceedsReleaseFailed(configId, receiver, amount);
            return;
        }
        emit DeliveryProceedsReleased(configId, receiver, amount);
    }

    function _shareOf(uint256 total, uint256 share) private pure returns (uint256) {
        unchecked {
            return (total / 10_000) * share + ((total % 10_000) * share) / 10_000;
        }
    }

    function _payWithBoundedGas(address receiver, uint256 amount) private returns (bool paid) {
        // Reserve gas for call overhead and failure accounting without underfunding the recipient call.
        if (gasleft() < MINT_PAYOUT_GAS_LIMIT + 50_000) revert InsufficientMintPayoutGas();
        assembly ("memory-safe") {
            paid := call(MINT_PAYOUT_GAS_LIMIT, receiver, amount, 0, 0, 0, 0)
        }
    }

    function _payProceeds(address receiver, uint256 amount, bool batch) private returns (bool paid) {
        if (batch) return _payWithBoundedGas(receiver, amount);
        (paid,) = payable(receiver).call{value: amount}("");
    }

    function _validateDeliveryPaymentReceiver(address receiver) private view {
        if (receiver == address(0) || receiver == address(this) || mintSharesBps[receiver] != 0) {
            revert InvalidAddress();
        }
    }

    function _checkPurchase(uint256 quantity, uint256 crateUnits, uint256 unitPrice) private view {
        if (!saleActive) revert SaleInactive();
        unchecked {
            if (quantity - 1 >= MAX_PURCHASE_QUANTITY) revert InvalidQuantity();
        }
        if (crateUnits > MAX_CRATES - allocatedCrates) revert SoldOut();
        if (msg.value != quantity * unitPrice) revert WrongPayment();
    }

    function _mintCrates(uint256 quantity) private {
        unchecked {
            uint256 firstCrate = allocatedCrates + 1;
            // Single-crate mints skip the shared allocator's container mapping.
            _mintAllocated(quantity, firstCrate, 1, CRATE_TOKEN_START, warehouseFirstCrate);
            emit CratesPurchased(msg.sender, CRATE_TOKEN_START + firstCrate - 1, quantity, msg.value);
        }
    }

    function _mintWarehouses(uint256 quantity) private {
        unchecked {
            uint256 firstWarehouse = warehousesMinted + 1;
            warehousesMinted += quantity;
            _mintAllocated(quantity, firstWarehouse, CRATES_PER_WAREHOUSE, WAREHOUSE_TOKEN_START, warehouseFirstCrate);
            emit WarehousesPurchased(msg.sender, WAREHOUSE_TOKEN_START + firstWarehouse - 1, quantity, msg.value);
        }
    }

    function _mintPublicRelic(uint256 relicId, bool freeMint) private {
        PublicRelicSale storage sale = publicRelicSale;
        if (!sale.active) revert SaleInactive();
        unchecked {
            if (relicId - 1 >= MAX_RELICS) revert InvalidRelicId();
        }
        if (sale.minted == sale.limit) revert SoldOut();
        _checkPurchase(1, CRATES_PER_RELIC, freeMint ? 0 : sale.priceWei);
        if (freeMint) {
            PublicRelicFreeMintAllowance storage allowance = publicRelicFreeMintAllowances[msg.sender];
            allowance.used = _consumeFreeMintAllowance(allowance.used, allowance.limit, 1);
        }
        unchecked {
            ++sale.minted;
        }
        _mintAllocated(1, relicId, CRATES_PER_RELIC, RELIC_TOKEN_START, relicFirstCrate);
        unchecked {
            emit PublicRelicMinted(msg.sender, relicId, RELIC_TOKEN_START + relicId - 1, msg.value, freeMint);
        }
    }

    function _mintAllocated(
        uint256 quantity,
        uint256 firstItem,
        uint256 crateUnits,
        uint256 tokenStart,
        mapping(uint256 => uint256) storage firstCrates
    ) private {
        uint256 firstCrate;
        unchecked {
            firstCrate = allocatedCrates + 1;
            allocatedCrates += quantity * crateUnits;
        }
        if (msg.value != 0) totalMintReceived += msg.value;
        // Purchase checks bound every allocation and token index below the collection limits.
        unchecked {
            for (uint256 i; i < quantity; ++i) {
                if (crateUnits != 1) firstCrates[firstItem + i] = firstCrate + i * crateUnits;
                _mintSpotOnce(msg.sender, tokenStart + firstItem + i - 1);
            }
        }
    }

    function _setFreeMintAllowance(address wallet, uint16 crates, uint16 warehouses, uint16 relics) private {
        _validateFreeMintWallet(wallet);
        if (crates > MAX_CRATES || warehouses > MAX_WAREHOUSES || relics > MAX_RELICS) {
            revert InvalidFreeMintConfig();
        }
        FreeMintAllowance storage allowance = freeMintAllowances[wallet];
        allowance.crateLimit = crates;
        allowance.warehouseLimit = warehouses;
        allowance.relicLimit = relics;
        emit FreeMintAllowanceUpdated(wallet, crates, warehouses, relics);
    }

    function _validateFreeMintWallet(address wallet) private view {
        if (wallet == address(0) || wallet == address(this)) revert InvalidAddress();
    }

    function _validateFreeMintWallets(address[] calldata wallets) private pure {
        unchecked {
            if (wallets.length - 1 >= 32) revert InvalidFreeMintConfig();
        }
        for (uint256 i; i < wallets.length; ++i) {
            address wallet = wallets[i];
            for (uint256 j; j < i; ++j) {
                if (wallets[j] == wallet) revert InvalidFreeMintConfig();
            }
        }
    }

    function _consumeFreeMintAllowance(uint16 used, uint16 limit, uint256 quantity) private pure returns (uint16) {
        unchecked {
            uint256 total = uint256(used) + quantity;
            if (total > limit) revert FreeMintAllowanceExceeded();
            return uint16(total);
        }
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

    function _unboxContainer(uint256 tokenId, uint256 firstCrate, uint256 count) private returns (uint256 firstToken) {
        unchecked {
            firstToken = CRATE_TOKEN_START + firstCrate - 1;
        }
        _burn(tokenId);
        unchecked {
            for (uint256 i; i < count; ++i) {
                _mintSpotOnce(msg.sender, firstToken + i);
            }
        }
    }

    function _checkDeadline(uint256 deadline) private view {
        if (deadline < block.timestamp) revert AuthorizationExpired();
        if (deadline > block.timestamp + MAX_QUOTE_LIFETIME) revert AuthorizationTooLong();
    }

    function _checkSignature(bytes32 digest, bytes calldata signature) private view {
        if (ECDSA.recoverCalldata(digest, signature) != quoteSigner) revert InvalidAuthorization();
    }

    function _crateContentsCount(uint256 crateNumber) private pure returns (uint256) {
        return crateNumber == MAX_CRATES ? 31 : 20;
    }

    function _tokenURI(uint256 tokenId) private view returns (string memory) {
        return string.concat(baseURI, _toString(tokenId), ".json");
    }

    function _metadataTokenId(uint8 kind, uint256 displayId) private pure returns (uint256) {
        unchecked {
            uint256 maximum = (METADATA_LIMITS >> (uint256(kind) * 18)) & 0x3ffff;
            if (displayId == 0 || displayId > maximum) {
                revert InvalidMetadataItem();
            }
            return ((METADATA_OFFSETS >> (uint256(kind) * 22)) & 0x3fffff) + displayId;
        }
    }

    function _validateBaseURI(string memory baseURI_) private view {
        bytes memory value = bytes(baseURI_);
        if (value.length < 9 || value[value.length - 1] != "/") revert InvalidBaseURI();
        bool secure = bytes8(value) == bytes8("https://");
        bool local = block.chainid == 31337 && bytes7(value) == bytes7("http://");
        if ((!secure && !local) || value[secure ? 8 : 7] == "/") revert InvalidBaseURI();
        for (uint256 i; i < value.length; ++i) {
            if ((URI_CHARACTERS >> uint8(value[i])) & 1 == 0) revert InvalidBaseURI();
        }
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    function _sequentialUpTo() internal pure override returns (uint256) {
        return MAX_ARTWORKS;
    }

    function _reentrancyGuardStorageSlot() internal pure override returns (bytes32) {
        // This non-proxy contract reserves transient slot 1 exclusively for the inherited guard.
        return bytes32(uint256(1));
    }
}
