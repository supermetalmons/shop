pragma solidity 0.8.38;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

contract Pre111K is EIP712, ReentrancyGuardTransient {
    uint256 public constant MAX_RELICS = 18;
    uint256 public constant MAX_AUTHORIZATION_LIFETIME = 10 minutes;

    bytes32 private constant RESERVATION_TYPEHASH =
        keccak256("ReserveRelic(address wallet,uint256 nonce,uint256 deadline)");

    address public immutable admin;
    address payable public immutable treasury;
    uint256 public immutable price;
    address public quoteSigner;
    uint256 public totalReserved;
    mapping(address => uint256) public reservedRelics;

    error InvalidAddress();
    error InvalidPrice();
    error Unauthorized();
    error WrongPayment();
    error SoldOut();
    error InvalidNonce();
    error InvalidDeadline();
    error InvalidAuthorization();
    error WithdrawalFailed();

    event RelicReserved(address indexed wallet, uint256 indexed nonce, uint256 totalReserved);
    event QuoteSignerUpdated(address indexed signer);
    event Withdrawal(address indexed treasury, uint256 amount);

    constructor(address admin_, address treasury_, address signer_, uint256 price_) EIP712("pre111k", "1") {
        if (
            admin_ == address(0) || treasury_ == address(0) || signer_ == address(0) || admin_ == address(this)
                || treasury_ == address(this) || signer_ == address(this)
        ) revert InvalidAddress();
        if (price_ == 0) revert InvalidPrice();
        admin = admin_;
        treasury = payable(treasury_);
        quoteSigner = signer_;
        price = price_;
    }

    function reserveRelic(uint256 nonce, uint256 deadline, bytes calldata signature) external payable nonReentrant {
        if (msg.value != price) revert WrongPayment();
        if (totalReserved == MAX_RELICS) revert SoldOut();
        if (nonce != reservedRelics[msg.sender]) revert InvalidNonce();
        if (deadline <= block.timestamp || deadline - block.timestamp > MAX_AUTHORIZATION_LIFETIME) {
            revert InvalidDeadline();
        }
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RESERVATION_TYPEHASH, msg.sender, nonce, deadline)));
        if (ECDSA.recoverCalldata(digest, signature) != quoteSigner) revert InvalidAuthorization();
        reservedRelics[msg.sender] = nonce + 1;
        uint256 reserved = ++totalReserved;
        emit RelicReserved(msg.sender, nonce, reserved);
    }

    function setQuoteSigner(address signer) external {
        if (msg.sender != admin) revert Unauthorized();
        if (signer == address(0) || signer == address(this)) revert InvalidAddress();
        quoteSigner = signer;
        emit QuoteSignerUpdated(signer);
    }

    function withdraw() external nonReentrant {
        uint256 amount = address(this).balance;
        if (amount == 0) return;
        (bool success,) = treasury.call{value: amount}("");
        if (!success) revert WithdrawalFailed();
        emit Withdrawal(treasury, amount);
    }
}
