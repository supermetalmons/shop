pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {NFT111KUrlRenderer} from "../src/NFT111KUrlRenderer.sol";
import {Vm} from "../test/TestSupport.sol";

contract Deploy111K {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (NFT111K token, NFT111KUrlRenderer renderer) {
        uint256 privateKey = vm.envUint("ETHEREUM_111K_DEPLOYER_KEY");
        address owner = vm.envAddress("ETHEREUM_111K_OWNER");
        address signer = vm.envAddress("ETHEREUM_111K_QUOTE_SIGNER");
        bytes32 discountRoot = vm.envBytes32("ETHEREUM_111K_DISCOUNT_ROOT");
        string memory metadataBaseURI = vm.envOr(
            "ETHEREUM_111K_METADATA_BASE_URI",
            block.chainid == 1 ? "https://cdn.mons.shop/111k/" : "https://cdn.mons.shop/111k-sepolia/"
        );
        string memory proceeds = vm.readFile("config/proceeds.json");
        address[] memory recipients = vm.parseJsonAddressArray(proceeds, ".mintRecipients");
        uint256[] memory shares = vm.parseJsonUintArray(proceeds, ".mintSharesBps");
        address payable deliveryReceiver = payable(vm.parseJsonAddress(proceeds, ".deliveryPaymentReceiver"));
        address deployer = vm.addr(privateKey);
        address collection = vm.computeCreateAddress(deployer, uint256(vm.getNonce(deployer)) + 1);
        if (
            owner == address(0) || signer == address(0) || deliveryReceiver == address(0)
                || deliveryReceiver == collection
        ) {
            revert NFT111K.InvalidAddress();
        }
        if (recipients.length < 2 || recipients.length > 8 || recipients.length != shares.length) {
            revert NFT111K.InvalidMintSplit();
        }
        uint256 totalShares;
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0) || recipients[i] == deliveryReceiver || recipients[i] == collection) {
                revert NFT111K.InvalidAddress();
            }
            if (shares[i] == 0 || shares[i] > 10_000) revert NFT111K.InvalidMintSplit();
            for (uint256 j; j < i; ++j) {
                if (recipients[j] == recipients[i]) revert NFT111K.InvalidAddress();
            }
            totalShares += shares[i];
        }
        if (totalShares != 10_000) revert NFT111K.InvalidMintSplit();
        vm.startBroadcast(privateKey);
        renderer = new NFT111KUrlRenderer(metadataBaseURI);
        token = new NFT111K(owner, signer, deliveryReceiver, address(renderer), discountRoot, recipients, shares);
        vm.stopBroadcast();
    }
}
