pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {NFT111KRenderer} from "../src/NFT111KRenderer.sol";
import {Vm} from "../test/TestSupport.sol";

contract Deploy111K {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (NFT111K token, NFT111KRenderer renderer) {
        uint256 privateKey = vm.envUint("ETHEREUM_111K_DEPLOYER_KEY");
        address owner = vm.envAddress("ETHEREUM_111K_OWNER");
        address signer = vm.envAddress("ETHEREUM_111K_QUOTE_SIGNER");
        address payable treasury = payable(vm.envAddress("ETHEREUM_111K_TREASURY"));
        vm.startBroadcast(privateKey);
        renderer = new NFT111KRenderer();
        token = new NFT111K(owner, signer, treasury, address(renderer));
        vm.stopBroadcast();
    }
}
