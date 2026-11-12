// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

contract ArtistsSplitV2 is ReentrancyGuardTransient {
    string public constant name = "artistssplit";
    IERC20 public constant WETH = IERC20(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    uint256 public constant PAYOUT_GAS_LIMIT = 100_000;

    address[] public recipients;
    mapping(address => uint256) public sharesBps;
    mapping(address => uint256) public released;
    mapping(address => uint256) public wethReleased;
    uint256 public totalReleased;
    uint256 public totalWethReleased;

    error WrongNetwork();
    error InvalidRecipient();
    error InsufficientPayoutGas();
    error PaymentFailed();
    error WethPaymentFailed();

    event PaymentReleased(address indexed recipient, uint256 amount);
    event PaymentFailedInBatch(address indexed recipient, uint256 amount);
    event WethPaymentReleased(address indexed recipient, uint256 amount);

    constructor() {
        if (block.chainid != 1 || address(WETH).code.length == 0) revert WrongNetwork();
        _addRecipient(0x51Ec8729331E284c4B5e8EcA8e0D184FeD18632F, 3549);
        _addRecipient(0x8B573abc736c82216D738Af3024F3a45fC3b18E3, 3355);
        _addRecipient(0xE938eBB66B92692Ab01F76C99cFAc1928482e7b9, 645);
        _addRecipient(0x1B591f88d9bFcF7d057DF2c5a50b59Da2cBa349f, 645);
        _addRecipient(0x07d2d89b4A6E3fdA8858Da3510b76e2219eE6969, 645);
        _addRecipient(0x603C39B3D0E0f33772d79695A4F6819FCc987113, 645);
        _addRecipient(0xa07E7932f5C981aA769A1Cf9400B5c94AdB944c4, 129);
        _addRecipient(0x2236Fb6C35f78A092F0DdA655f3b49d0e8Bf6581, 129);
        _addRecipient(0x71d0318BB33d961f323C81a7a4Ca095b549F7E6E, 129);
        _addRecipient(0xc4275E6D4109e0288cDc9b064E32F3f54bcDA61F, 129);
    }

    receive() external payable {}

    fallback() external payable {}

    function _addRecipient(address recipient, uint256 share) private {
        if (recipient == address(this)) revert InvalidRecipient();
        recipients.push(recipient);
        sharesBps[recipient] = share;
    }

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    function totalReceived() public view returns (uint256) {
        return address(this).balance + totalReleased;
    }

    function totalWethReceived() public view returns (uint256) {
        return WETH.balanceOf(address(this)) + totalWethReleased;
    }

    function releasable(address recipient) external view returns (uint256) {
        return _shareOf(totalReceived(), sharesBps[recipient]) - released[recipient];
    }

    function releasableWeth(address recipient) external view returns (uint256) {
        return _shareOf(totalWethReceived(), sharesBps[recipient]) - wethReleased[recipient];
    }

    function withdraw() external nonReentrant {
        uint256 ethReceived = totalReceived();
        uint256 wethReceived = totalWethReceived();
        uint256 count = recipients.length;
        for (uint256 i; i < count; ++i) {
            address recipient = recipients[i];
            uint256 share = sharesBps[recipient];
            _releaseWeth(recipient, _shareOf(wethReceived, share));
            _releaseEth(recipient, _shareOf(ethReceived, share), true);
        }
    }

    function release(address recipient) external nonReentrant {
        uint256 share = sharesBps[recipient];
        if (share == 0) revert InvalidRecipient();
        _releaseEth(recipient, _shareOf(totalReceived(), share), false);
    }

    function _releaseWeth(address recipient, uint256 entitlement) private {
        uint256 amount = entitlement - wethReleased[recipient];
        if (amount == 0) return;
        wethReleased[recipient] = entitlement;
        totalWethReleased += amount;
        if (!WETH.transfer(recipient, amount)) revert WethPaymentFailed();
        emit WethPaymentReleased(recipient, amount);
    }

    function _releaseEth(address recipient, uint256 entitlement, bool batch) private {
        uint256 previouslyReleased = released[recipient];
        uint256 amount = entitlement - previouslyReleased;
        if (amount == 0) return;
        released[recipient] = entitlement;
        totalReleased += amount;
        uint256 gasForPayment = gasleft();
        if (batch) {
            if (gasForPayment < PAYOUT_GAS_LIMIT + 50_000) revert InsufficientPayoutGas();
            gasForPayment = PAYOUT_GAS_LIMIT;
        }
        bool paid;
        assembly ("memory-safe") {
            paid := call(gasForPayment, recipient, amount, 0, 0, 0, 0)
        }
        if (!paid) {
            if (!batch) revert PaymentFailed();
            released[recipient] = previouslyReleased;
            totalReleased -= amount;
            emit PaymentFailedInBatch(recipient, amount);
            return;
        }
        emit PaymentReleased(recipient, amount);
    }

    function _shareOf(uint256 received, uint256 share) private pure returns (uint256) {
        return (received / 10_000) * share + ((received % 10_000) * share) / 10_000;
    }
}
