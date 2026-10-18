pragma solidity 0.8.30;

import {ERC721A} from "erc721a/contracts/ERC721A.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IMons111kRenderer} from "./IMons111kRenderer.sol";

contract Mons111k is ERC721A, Ownable2Step, ReentrancyGuardTransient, EIP712 {
    enum ItemKind {
        None,
        Artwork,
        Crate,
        Warehouse,
        ArtworkReceipt,
        CrateReceipt
    }

    struct DeliveryQuote {
        uint256 orderId;
        address wallet;
        uint256 fee;
        uint256 deadline;
        bytes32 receiptIdsHash;
    }

    uint256 public constant MAX_ARTWORKS = 111_111;
    uint256 public constant MAX_CRATES = 5_555;
    uint256 public constant MAX_WAREHOUSES = 505;
    uint256 public constant CRATES_PER_WAREHOUSE = 11;
    uint256 public constant MAX_PURCHASE_QUANTITY = 15;
    uint256 public constant MAX_DELIVERY_ITEMS = 50;
    uint256 public constant MAX_QUOTE_LIFETIME = 10 minutes;
    uint256 public constant CRATE_TOKEN_START = 111_112;
    uint256 public constant WAREHOUSE_TOKEN_START = 116_667;
    uint256 public constant ARTWORK_RECEIPT_OFFSET = 1_000_000;
    uint256 public constant CRATE_RECEIPT_OFFSET = 2_000_000;

    bytes32 private constant DELIVERY_TYPEHASH = keccak256(
        "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)"
    );
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("CrateClaim(address wallet,uint256 receiptId,bytes32 claimId,uint256 deadline)");

    uint256 public allocatedCrates;
    uint256 public warehousesMinted;
    uint256 public cratePrice = 0.0001 ether;
    uint256 public warehousePrice = 0.0011 ether;
    bool public saleActive = true;
    bool public redemptionsPaused;
    address public quoteSigner;
    address payable public treasury;
    IMons111kRenderer public renderer;
    mapping(uint256 => uint256) public warehouseFirstCrate;
    mapping(uint256 => bool) public usedDeliveryOrders;
    mapping(bytes32 => bool) public usedClaims;
    uint24 private transient pendingArtworkOffset;

    error InvalidQuantity();
    error SoldOut();
    error SaleInactive();
    error RedemptionsPaused();
    error WrongPayment();
    error WrongOwner();
    error WrongItemKind();
    error InvalidAuthorization();
    error AuthorizationExpired();
    error AuthorizationTooLong();
    error AuthorizationAlreadyUsed();
    error InvalidAddress();
    error TreasuryPaymentFailed();
    error TokenAlreadyIssued();
    error InvalidMetadataItem();

    event CratesPurchased(address indexed wallet, uint256 firstCrateToken, uint256 quantity, uint256 paid);
    event WarehousesPurchased(address indexed wallet, uint256 firstWarehouseToken, uint256 quantity, uint256 paid);
    event WarehouseUnboxed(
        uint256 indexed warehouseToken, address indexed owner, uint256 firstCrateToken, uint256 count
    );
    event CrateUnboxed(uint256 indexed crateToken, address indexed owner, uint256 firstArtToken, uint256 count);
    event DeliveryRedeemed(
        uint256 indexed orderId, address indexed wallet, uint256 fee, uint256[] tokenIds, uint256[] receiptIds
    );
    event CrateReceiptClaimed(
        bytes32 indexed claimId, address indexed wallet, uint256 indexed receiptId, uint256[] receiptIds
    );
    event PricesUpdated(uint256 cratePrice, uint256 warehousePrice);
    event SaleStatusUpdated(bool active);
    event RedemptionsPauseUpdated(bool paused);
    event QuoteSignerUpdated(address indexed signer);
    event TreasuryUpdated(address indexed treasury);
    event RendererUpdated(address indexed renderer);
    event Withdrawn(address indexed treasury, uint256 amount);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    constructor(address initialOwner, address signer, address payable treasury_, address renderer_)
        ERC721A("Mons 111k", "111K")
        Ownable(initialOwner)
        EIP712("Mons111k", "2")
    {
        if (signer == address(0) || treasury_ == address(0) || renderer_.code.length == 0) revert InvalidAddress();
        quoteSigner = signer;
        treasury = treasury_;
        renderer = IMons111kRenderer(renderer_);
    }

    function mintCrates(uint256 quantity) external payable nonReentrant {
        _checkPurchase(quantity, quantity, cratePrice);
        uint256 firstCrate = allocatedCrates + 1;
        allocatedCrates += quantity;
        for (uint256 i; i < quantity; ++i) {
            _mintSpotOnce(msg.sender, CRATE_TOKEN_START + firstCrate + i - 1);
        }
        emit CratesPurchased(msg.sender, CRATE_TOKEN_START + firstCrate - 1, quantity, msg.value);
    }

    function mintWarehouses(uint256 quantity) external payable nonReentrant {
        _checkPurchase(quantity, quantity * CRATES_PER_WAREHOUSE, warehousePrice);
        uint256 firstWarehouse = warehousesMinted + 1;
        uint256 firstCrate = allocatedCrates + 1;
        allocatedCrates += quantity * CRATES_PER_WAREHOUSE;
        warehousesMinted += quantity;
        for (uint256 i; i < quantity; ++i) {
            warehouseFirstCrate[firstWarehouse + i] = firstCrate + i * CRATES_PER_WAREHOUSE;
            _mintSpotOnce(msg.sender, WAREHOUSE_TOKEN_START + firstWarehouse + i - 1);
        }
        emit WarehousesPurchased(msg.sender, WAREHOUSE_TOKEN_START + firstWarehouse - 1, quantity, msg.value);
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
        uint256 count = _crateContentsCount(crateNumber);
        uint256 firstToken = _nextTokenId();
        uint256 firstDisplayId = (crateNumber - 1) * 20 + 1;
        _burn(tokenId);
        pendingArtworkOffset = uint24(MAX_ARTWORKS + firstDisplayId - firstToken);
        _safeMint(msg.sender, count);
        pendingArtworkOffset = 0;
        emit CrateUnboxed(tokenId, msg.sender, firstToken, count);
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
                    quote.deadline
                )
            )
        );
        if (ECDSA.recover(digest, signature) != quoteSigner) revert InvalidAuthorization();
        uint256[] memory receiptIds = new uint256[](tokenIds.length);
        for (uint256 i; i < tokenIds.length; ++i) {
            (uint8 kind, uint256 displayId, address holder) = getTokenInfo(tokenIds[i]);
            if (holder != msg.sender) revert WrongOwner();
            if (kind == uint8(ItemKind.Artwork)) receiptIds[i] = ARTWORK_RECEIPT_OFFSET + displayId;
            else if (kind == uint8(ItemKind.Crate)) receiptIds[i] = CRATE_RECEIPT_OFFSET + displayId;
            else revert WrongItemKind();
        }
        if (keccak256(abi.encode(receiptIds)) != quote.receiptIdsHash) revert InvalidAuthorization();
        usedDeliveryOrders[quote.orderId] = true;
        for (uint256 i; i < tokenIds.length; ++i) {
            if (ownerOf(tokenIds[i]) != msg.sender) revert WrongOwner();
            _burn(tokenIds[i]);
            _mintSpotOnce(msg.sender, receiptIds[i]);
        }
        emit DeliveryRedeemed(quote.orderId, msg.sender, quote.fee, tokenIds, receiptIds);
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
        if (ECDSA.recover(digest, signature) != quoteSigner) revert InvalidAuthorization();
        usedClaims[claimId] = true;
        _burn(receiptId);
        uint256 count = _crateContentsCount(crateNumber);
        uint256 firstDisplayId = (crateNumber - 1) * 20 + 1;
        uint256[] memory receiptIds = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            receiptIds[i] = ARTWORK_RECEIPT_OFFSET + firstDisplayId + i;
            _mintSpotOnce(msg.sender, receiptIds[i]);
        }
        emit CrateReceiptClaimed(claimId, msg.sender, receiptId, receiptIds);
    }

    function getTokenInfo(uint256 tokenId) public view returns (uint8 kind, uint256 displayId, address holder) {
        if (!_exists(tokenId)) return (0, 0, address(0));
        if (tokenId <= MAX_ARTWORKS) {
            TokenOwnership memory ownership = _ownershipOf(tokenId);
            return (uint8(ItemKind.Artwork), tokenId + ownership.extraData - MAX_ARTWORKS, ownership.addr);
        }
        holder = ownerOf(tokenId);
        if (tokenId >= CRATE_TOKEN_START && tokenId < CRATE_TOKEN_START + MAX_CRATES) {
            return (uint8(ItemKind.Crate), tokenId - CRATE_TOKEN_START + 1, holder);
        }
        if (tokenId >= WAREHOUSE_TOKEN_START && tokenId < WAREHOUSE_TOKEN_START + MAX_WAREHOUSES) {
            return (uint8(ItemKind.Warehouse), tokenId - WAREHOUSE_TOKEN_START + 1, holder);
        }
        if (tokenId > ARTWORK_RECEIPT_OFFSET && tokenId <= ARTWORK_RECEIPT_OFFSET + MAX_ARTWORKS) {
            return (uint8(ItemKind.ArtworkReceipt), tokenId - ARTWORK_RECEIPT_OFFSET, holder);
        }
        if (tokenId > CRATE_RECEIPT_OFFSET && tokenId <= CRATE_RECEIPT_OFFSET + MAX_CRATES) {
            return (uint8(ItemKind.CrateReceipt), tokenId - CRATE_RECEIPT_OFFSET, holder);
        }
        return (0, 0, address(0));
    }

    function stats()
        external
        view
        returns (
            uint256 allocatedCrates_,
            uint256 warehousesMinted_,
            uint256 artworksMinted_,
            uint256 cratePrice_,
            uint256 warehousePrice_,
            bool saleActive_
        )
    {
        return (allocatedCrates, warehousesMinted, _nextTokenId() - 1, cratePrice, warehousePrice, saleActive);
    }

    function remainingCrates() external view returns (uint256) {
        return MAX_CRATES - allocatedCrates;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        (uint8 kind, uint256 displayId,) = getTokenInfo(tokenId);
        if (kind == 0) revert URIQueryForNonexistentToken();
        return renderer.tokenURI(kind, displayId);
    }

    function previewTokenURI(uint8 kind, uint256 displayId) external view returns (string memory) {
        if (!_validMetadataItem(kind, displayId)) revert InvalidMetadataItem();
        return renderer.tokenURI(kind, displayId);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0x49064906 || super.supportsInterface(interfaceId);
    }

    function setPrices(uint256 cratePrice_, uint256 warehousePrice_) external onlyOwner {
        cratePrice = cratePrice_;
        warehousePrice = warehousePrice_;
        emit PricesUpdated(cratePrice_, warehousePrice_);
    }

    function setSaleActive(bool active) external onlyOwner {
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

    function setTreasury(address payable treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setRenderer(address renderer_) external onlyOwner {
        if (renderer_.code.length == 0) revert InvalidAddress();
        renderer = IMons111kRenderer(renderer_);
        emit RendererUpdated(renderer_);
        emit BatchMetadataUpdate(1, CRATE_RECEIPT_OFFSET + MAX_CRATES);
    }

    function withdraw() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        (bool paid,) = treasury.call{value: amount}("");
        if (!paid) revert TreasuryPaymentFailed();
        emit Withdrawn(treasury, amount);
    }

    function _checkPurchase(uint256 quantity, uint256 crateUnits, uint256 unitPrice) private view {
        if (!saleActive) revert SaleInactive();
        if (quantity == 0 || quantity > MAX_PURCHASE_QUANTITY) revert InvalidQuantity();
        if (crateUnits > MAX_CRATES - allocatedCrates) revert SoldOut();
        if (msg.value != quantity * unitPrice) revert WrongPayment();
    }

    function _requireOwnedKind(uint256 tokenId, ItemKind expected) private view returns (uint256 displayId) {
        (uint8 kind, uint256 number, address holder) = getTokenInfo(tokenId);
        if (holder != msg.sender) revert WrongOwner();
        if (kind != uint8(expected)) revert WrongItemKind();
        return number;
    }

    function _mintSpotOnce(address recipient, uint256 tokenId) private {
        if (_ownershipIsInitialized(tokenId)) revert TokenAlreadyIssued();
        _safeMintSpot(recipient, tokenId);
    }

    function _checkDeadline(uint256 deadline) private view {
        if (deadline < block.timestamp) revert AuthorizationExpired();
        if (deadline > block.timestamp + MAX_QUOTE_LIFETIME) revert AuthorizationTooLong();
    }

    function _crateContentsCount(uint256 crateNumber) private pure returns (uint256) {
        return crateNumber == MAX_CRATES ? 31 : 20;
    }

    function _validMetadataItem(uint8 kind, uint256 displayId) private pure returns (bool) {
        if (displayId == 0) return false;
        if (kind == uint8(ItemKind.Artwork) || kind == uint8(ItemKind.ArtworkReceipt)) {
            return displayId <= MAX_ARTWORKS;
        }
        if (kind == uint8(ItemKind.Crate) || kind == uint8(ItemKind.CrateReceipt)) return displayId <= MAX_CRATES;
        return kind == uint8(ItemKind.Warehouse) && displayId <= MAX_WAREHOUSES;
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    function _sequentialUpTo() internal pure override returns (uint256) {
        return MAX_ARTWORKS;
    }

    function _extraData(address from, address, uint24 previous) internal view override returns (uint24) {
        return from == address(0) ? pendingArtworkOffset : previous;
    }
}
