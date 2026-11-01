pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {Vm} from "../test/TestSupport.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract Deploy111K {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct FreeMintGroup {
        uint256 crates;
        string name;
        uint256 relics;
        address[] wallets;
        uint256 warehouses;
    }

    function _rejectJsonScalar(string memory json, string memory path) private pure {
        // Foundry's typed array parser also accepts scalar strings such as "[]".
        try vm.parseJsonString(json, path) returns (string memory) {
            revert NFT111K.InvalidFreeMintConfig();
        } catch {}
    }

    function _freeMintLimit(string memory json, string memory path, uint256 maximum) private pure returns (uint16) {
        bytes memory encoded = vm.parseJson(json, path);
        uint256 value = vm.parseJsonUint(json, path);
        bytes memory text = bytes(vm.parseJsonString(json, path));
        if (encoded.length != 32 || value > maximum || keccak256(encoded) != keccak256(abi.encode(value))) {
            revert NFT111K.InvalidFreeMintConfig();
        }
        for (uint256 i; i < text.length; ++i) {
            if (text[i] < "0" || text[i] > "9") revert NFT111K.InvalidFreeMintConfig();
        }
        return uint16(value);
    }

    function _freeMintWallet(string memory json, string memory path) private pure returns (address) {
        bytes memory text = bytes(vm.parseJsonString(json, path));
        if (text.length != 42 || text[0] != "0" || text[1] != "x") revert NFT111K.InvalidAddress();
        for (uint256 i = 2; i < text.length; ++i) {
            if (
                (text[i] < "0" || text[i] > "9") && (text[i] < "a" || text[i] > "f") && (text[i] < "A" || text[i] > "F")
            ) revert NFT111K.InvalidAddress();
        }
        return vm.parseJsonAddress(json, path);
    }

    function _freeMintAllocations(string memory json, address collection)
        internal
        view
        returns (NFT111K.FreeMintAllocation[] memory allocations)
    {
        string[] memory keys = vm.parseJsonKeys(json, ".");
        if (keys.length == 1) {
            if (keccak256(bytes(keys[0])) != keccak256("groups")) revert NFT111K.InvalidFreeMintConfig();
        } else if (keys.length == 2) {
            bytes32 first = keccak256(bytes(keys[0]));
            bytes32 second = keccak256(bytes(keys[1]));
            if (
                !(first == keccak256("chainId") && second == keccak256("groups"))
                    && !(first == keccak256("groups") && second == keccak256("chainId"))
            ) {
                revert NFT111K.InvalidFreeMintConfig();
            }
            bytes memory encodedChain = vm.parseJson(json, ".chainId");
            uint256 chainId = vm.parseJsonUint(json, ".chainId");
            if (
                encodedChain.length != 32 || chainId != 11155111 || block.chainid != chainId
                    || keccak256(encodedChain) != keccak256(abi.encode(chainId))
            ) revert NFT111K.InvalidFreeMintConfig();
            bytes memory text = bytes(vm.parseJsonString(json, ".chainId"));
            for (uint256 i; i < text.length; ++i) {
                if (text[i] < "0" || text[i] > "9") revert NFT111K.InvalidFreeMintConfig();
            }
        } else {
            revert NFT111K.InvalidFreeMintConfig();
        }
        _rejectJsonScalar(json, ".groups");
        FreeMintGroup[] memory groups = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".groups",
                "FreeMintGroup(uint256 crates,string name,uint256 relics,address[] wallets,uint256 warehouses)"
            ),
            (FreeMintGroup[])
        );
        uint256 count;
        for (uint256 i; i < groups.length; ++i) {
            FreeMintGroup memory group = groups[i];
            string memory path = string.concat(".groups[", Strings.toString(i), "]");
            _rejectJsonScalar(json, string.concat(path, ".wallets"));
            keys = vm.parseJsonKeys(json, path);
            if (keys.length != 5 || bytes(group.name).length == 0) revert NFT111K.InvalidFreeMintConfig();
            for (uint256 j; j < keys.length; ++j) {
                bytes32 key = keccak256(bytes(keys[j]));
                if (
                    key != keccak256("crates") && key != keccak256("relics") && key != keccak256("name")
                        && key != keccak256("wallets") && key != keccak256("warehouses")
                ) revert NFT111K.InvalidFreeMintConfig();
            }
            group.crates = _freeMintLimit(json, string.concat(path, ".crates"), 5555);
            group.warehouses = _freeMintLimit(json, string.concat(path, ".warehouses"), 505);
            group.relics = _freeMintLimit(json, string.concat(path, ".relics"), 18);
            for (uint256 j; j < group.wallets.length; ++j) {
                group.wallets[j] = _freeMintWallet(json, string.concat(path, ".wallets[", Strings.toString(j), "]"));
            }
            for (uint256 j; j < i; ++j) {
                if (keccak256(bytes(group.name)) == keccak256(bytes(groups[j].name))) {
                    revert NFT111K.InvalidFreeMintConfig();
                }
            }
            count += group.wallets.length;
        }
        if (count > 32) revert NFT111K.InvalidFreeMintConfig();
        allocations = new NFT111K.FreeMintAllocation[](count);
        uint256 index;
        for (uint256 i; i < groups.length; ++i) {
            FreeMintGroup memory group = groups[i];
            for (uint256 j; j < group.wallets.length; ++j) {
                address wallet = group.wallets[j];
                if (wallet == address(0) || wallet == collection) revert NFT111K.InvalidAddress();
                for (uint256 k; k < index; ++k) {
                    if (allocations[k].wallet == wallet) revert NFT111K.InvalidFreeMintConfig();
                }
                allocations[index++] = NFT111K.FreeMintAllocation(
                    wallet, uint16(group.crates), uint16(group.warehouses), uint16(group.relics)
                );
            }
        }
    }

    function _metadataBaseURI() internal returns (string memory uri) {
        if (block.chainid == 31337) {
            return vm.envOr("ETHEREUM_111K_METADATA_BASE_URI", "https://cdn.mons.shop/111k-sepolia/v9/");
        }
        uri = vm.envString("ETHEREUM_111K_METADATA_BASE_URI");
        _validateDeploymentMetadataBaseURI(uri, block.chainid);
    }

    function _validateDeploymentMetadataBaseURI(string memory uri, uint256 chainId) internal pure {
        if (chainId != 1 && chainId != 11155111) revert NFT111K.InvalidBaseURI();
        bytes memory prefix =
            bytes(chainId == 1 ? "https://cdn.mons.shop/111k/" : "https://cdn.mons.shop/111k-sepolia/");
        bytes memory value = bytes(uri);
        if (value.length < prefix.length + 2 || value.length > prefix.length + 65 || value[value.length - 1] != "/") {
            revert NFT111K.InvalidBaseURI();
        }
        for (uint256 i; i < prefix.length; ++i) {
            if (value[i] != prefix[i]) revert NFT111K.InvalidBaseURI();
        }
        for (uint256 i = prefix.length; i < value.length - 1; ++i) {
            bool alphanumeric = (value[i] >= "a" && value[i] <= "z") || (value[i] >= "0" && value[i] <= "9");
            if (!alphanumeric && (i == prefix.length || value[i] != "-")) revert NFT111K.InvalidBaseURI();
        }
    }

    function run() external returns (NFT111K token) {
        uint256 privateKey = vm.envUint("ETHEREUM_111K_DEPLOYER_KEY");
        address owner = vm.envAddress("ETHEREUM_111K_OWNER");
        address signer = vm.envAddress("ETHEREUM_111K_QUOTE_SIGNER");
        address initialDeliveryReceiver = vm.envAddress("ETHEREUM_111K_INITIAL_DELIVERY_RECEIVER");
        bytes32 discountRoot = vm.envBytes32("ETHEREUM_111K_DISCOUNT_ROOT");
        string memory metadataBaseURI = _metadataBaseURI();
        string memory proceeds = vm.readFile("config/proceeds.json");
        address[] memory recipients = vm.parseJsonAddressArray(proceeds, ".mintRecipients");
        uint256[] memory shares = vm.parseJsonUintArray(proceeds, ".mintSharesBps");
        address deployer = vm.addr(privateKey);
        address collection = vm.computeCreateAddress(deployer, uint256(vm.getNonce(deployer)));
        if (
            owner == address(0) || signer == address(0) || initialDeliveryReceiver == address(0)
                || initialDeliveryReceiver == collection
        ) {
            revert NFT111K.InvalidAddress();
        }
        if (recipients.length < 2 || recipients.length > 32 || recipients.length != shares.length) {
            revert NFT111K.InvalidMintSplit();
        }
        uint256 totalShares;
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0) || recipients[i] == collection || recipients[i] == initialDeliveryReceiver)
            {
                revert NFT111K.InvalidAddress();
            }
            if (shares[i] == 0 || shares[i] > 10_000) revert NFT111K.InvalidMintSplit();
            for (uint256 j; j < i; ++j) {
                if (recipients[j] == recipients[i]) revert NFT111K.InvalidAddress();
            }
            totalShares += shares[i];
        }
        if (totalShares != 10_000) revert NFT111K.InvalidMintSplit();
        NFT111K.FreeMintAllocation[] memory freeMints = _freeMintAllocations(
            vm.readFile(vm.envOr("ETHEREUM_111K_FREE_MINT_CONFIG", "config/free-mints.json")), collection
        );
        vm.startBroadcast(privateKey);
        token = new NFT111K(
            owner, signer, initialDeliveryReceiver, metadataBaseURI, discountRoot, recipients, shares, freeMints
        );
        vm.stopBroadcast();
    }
}
