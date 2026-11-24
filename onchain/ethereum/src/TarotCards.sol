pragma solidity 0.8.38;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract TarotCards is ERC721, Ownable2Step, EIP712, ReentrancyGuardTransient {
    uint256 public constant MAX_CARDS = 777;
    uint256 public constant RECEIPT_OFFSET = 777;
    uint256 public constant MAX_AUTHORIZATION_LIFETIME = 10 minutes;
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("TarotClaim(address wallet,uint256 tokenId,uint256 deadline)");

    address public quoteSigner;
    string public baseURI;
    mapping(uint256 => bool) public claimed;

    error UnsupportedChain();
    error InvalidAddress();
    error InvalidTokenId();
    error AlreadyClaimed();
    error InvalidDeadline();
    error InvalidAuthorization();
    error InvalidBaseURI();
    error OwnershipRenunciationDisabled();

    event TarotClaimed(address indexed wallet, uint256 indexed tokenId, uint256 indexed receiptTokenId);
    event QuoteSignerUpdated(address indexed signer);

    constructor(address initialOwner, address signer, string memory baseURI_)
        ERC721("divination machina x", "DMX")
        Ownable(initialOwner)
        EIP712("divination machina x", "1")
    {
        if (block.chainid != 11155111 && block.chainid != 31337) revert UnsupportedChain();
        if (initialOwner == address(this) || signer == address(0) || signer == address(this)) revert InvalidAddress();
        if (keccak256(bytes(baseURI_)) != keccak256("https://cdn.mons.shop/tarot-sepolia/v1/")) revert InvalidBaseURI();
        quoteSigner = signer;
        baseURI = baseURI_;
    }

    function claim(uint256 tokenId, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (block.chainid != 11155111 && block.chainid != 31337) revert UnsupportedChain();
        uint256 receipt = receiptTokenId(tokenId);
        if (claimed[tokenId]) revert AlreadyClaimed();
        if (deadline <= block.timestamp || deadline - block.timestamp > MAX_AUTHORIZATION_LIFETIME) {
            revert InvalidDeadline();
        }
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, tokenId, deadline)));
        if (ECDSA.recoverCalldata(digest, signature) != quoteSigner) revert InvalidAuthorization();
        claimed[tokenId] = true;
        _safeMint(msg.sender, tokenId);
        _safeMint(msg.sender, receipt);
        emit TarotClaimed(msg.sender, tokenId, receipt);
    }

    function receiptTokenId(uint256 tokenId) public pure returns (uint256) {
        if (tokenId == 0 || tokenId > MAX_CARDS) revert InvalidTokenId();
        return tokenId + RECEIPT_OFFSET;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(baseURI, Strings.toString(tokenId), ".json");
    }

    function contractURI() external view returns (string memory) {
        return string.concat(baseURI, "collection.json");
    }

    function setQuoteSigner(address signer) external onlyOwner {
        if (signer == address(0) || signer == address(this)) revert InvalidAddress();
        quoteSigner = signer;
        emit QuoteSignerUpdated(signer);
    }

    function renounceOwnership() public override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }
}
