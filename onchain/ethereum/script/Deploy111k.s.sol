pragma solidity 0.8.30;

import {Mons111k} from "../src/Mons111k.sol";
import {Mons111kRenderer} from "../src/Mons111kRenderer.sol";
import {Vm} from "../test/TestSupport.sol";

contract Deploy111k {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (Mons111k token, Mons111kRenderer renderer) {
        uint256 privateKey = vm.envUint("MONS_111K_DEPLOYER_KEY");
        address owner = vm.envAddress("MONS_111K_OWNER");
        address signer = vm.envAddress("MONS_111K_QUOTE_SIGNER");
        address payable treasury = payable(vm.envAddress("MONS_111K_TREASURY"));
        vm.startBroadcast(privateKey);
        renderer = new Mons111kRenderer();
        token = new Mons111k(owner, signer, treasury, address(renderer));
        vm.stopBroadcast();
    }
}
