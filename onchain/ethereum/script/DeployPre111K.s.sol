pragma solidity 0.8.38;

import {Pre111K} from "../src/Pre111K.sol";
import {Vm} from "../test/TestSupport.sol";

contract DeployPre111K {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address public constant TREASURY = 0x72D0c5623A05033F9eE4495D408BC6c05DF8367d;
    address public constant SEPOLIA_ADMIN = 0xD58d143cA63D9BaCcc33fDF69Ea203F59c58aE93;

    function run() external returns (Pre111K preorder) {
        (address admin, uint256 price) = _configuration(block.chainid);
        uint256 deployerKey = vm.envUint("ETHEREUM_PRE111K_DEPLOYER_KEY");
        address signer = vm.envAddress("ETHEREUM_PRE111K_QUOTE_SIGNER");
        if (block.chainid == 11155111) require(vm.addr(deployerKey) == SEPOLIA_ADMIN, "unexpected Sepolia deployer");
        vm.startBroadcast(deployerKey);
        preorder = new Pre111K(admin, TREASURY, signer, price);
        vm.stopBroadcast();
    }

    function _configuration(uint256 chainId) internal pure returns (address admin, uint256 price) {
        require(chainId == 1 || chainId == 11155111, "unsupported deployment chain");
        return chainId == 1 ? (TREASURY, 2.3 ether) : (SEPOLIA_ADMIN, 0.0023 ether);
    }
}
