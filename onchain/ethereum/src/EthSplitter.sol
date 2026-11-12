pragma solidity 0.8.38;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

contract EthSplitter is ReentrancyGuardTransient {
    uint256 public constant MAX_RECIPIENTS = 32;
    uint256 public constant PAYOUT_GAS_LIMIT = 100_000;

    string public name;
    address[] public recipients;
    mapping(address => uint256) public sharesBps;
    mapping(address => uint256) public released;
    uint256 public totalReleased;

    error InvalidSplit();
    error InvalidRecipient();
    error PaymentFailed();
    error InsufficientPayoutGas();

    event PaymentReleased(address indexed recipient, uint256 amount);
    event PaymentFailedInBatch(address indexed recipient, uint256 amount);

    constructor(string memory name_, address[] memory recipients_, uint256[] memory sharesBps_) {
        uint256 count = recipients_.length;
        if (bytes(name_).length == 0 || count < 2 || count > MAX_RECIPIENTS || sharesBps_.length != count) {
            revert InvalidSplit();
        }
        name = name_;
        uint256 totalShares;
        for (uint256 i; i < count; ++i) {
            address recipient = recipients_[i];
            if (recipient == address(0) || recipient == address(this) || sharesBps[recipient] != 0) {
                revert InvalidRecipient();
            }
            uint256 share = sharesBps_[i];
            if (share == 0 || share > 10_000) revert InvalidSplit();
            totalShares += share;
            recipients.push(recipient);
            sharesBps[recipient] = share;
        }
        if (totalShares != 10_000) revert InvalidSplit();
    }

    receive() external payable {}

    fallback() external payable {}

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    function totalReceived() public view returns (uint256) {
        return address(this).balance + totalReleased;
    }

    function releasable(address recipient) public view returns (uint256) {
        return _shareOf(totalReceived(), sharesBps[recipient]) - released[recipient];
    }

    function withdraw() external nonReentrant {
        uint256 received = totalReceived();
        uint256 count = recipients.length;
        for (uint256 i; i < count; ++i) {
            _release(recipients[i], received, true);
        }
    }

    function release(address recipient) external nonReentrant {
        if (sharesBps[recipient] == 0) revert InvalidRecipient();
        _release(recipient, totalReceived(), false);
    }

    function _release(address recipient, uint256 received, bool batch) private {
        uint256 previousReleased = released[recipient];
        uint256 entitlement = _shareOf(received, sharesBps[recipient]);
        uint256 amount = entitlement - previousReleased;
        if (amount == 0) return;
        released[recipient] = entitlement;
        uint256 previousTotal = totalReleased;
        totalReleased = previousTotal + amount;
        bool paid;
        if (batch) {
            if (gasleft() < PAYOUT_GAS_LIMIT + 50_000) revert InsufficientPayoutGas();
            assembly ("memory-safe") {
                paid := call(PAYOUT_GAS_LIMIT, recipient, amount, 0, 0, 0, 0)
            }
        } else {
            assembly ("memory-safe") {
                paid := call(gas(), recipient, amount, 0, 0, 0, 0)
            }
        }
        if (!paid) {
            if (!batch) revert PaymentFailed();
            released[recipient] = previousReleased;
            totalReleased = previousTotal;
            emit PaymentFailedInBatch(recipient, amount);
            return;
        }
        emit PaymentReleased(recipient, amount);
    }

    function _shareOf(uint256 total, uint256 share) private pure returns (uint256) {
        return (total / 10_000) * share + ((total % 10_000) * share) / 10_000;
    }
}
