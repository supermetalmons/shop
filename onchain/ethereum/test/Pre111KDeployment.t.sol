pragma solidity 0.8.38;

import {Pre111K} from "../src/Pre111K.sol";
import {DeployPre111K} from "../script/DeployPre111K.s.sol";
import {TestSupport} from "./TestSupport.sol";

interface Pre111KDeploymentVm {
    function setEnv(string calldata key, string calldata value) external;
}

contract Pre111KDeploymentHarness is DeployPre111K {
    function adminForChain(uint256 chainId) external pure returns (address) {
        return _admin(chainId);
    }
}

contract Pre111KDeploymentTest is TestSupport {
    function testDeploymentPinsAdminForSupportedNetworks() public {
        Pre111KDeploymentHarness script = new Pre111KDeploymentHarness();
        assertEq(script.adminForChain(1), script.TREASURY());
        assertEq(script.adminForChain(11155111), script.SEPOLIA_ADMIN());
        vm.expectRevert();
        script.adminForChain(31337);
    }

    function testMainnetDeploymentScriptUsesSafeAdminAndTreasuryInLocalEVM() public {
        Pre111KDeploymentVm(address(vm)).setEnv("ETHEREUM_PRE111K_DEPLOYER_KEY", "1");
        Pre111KDeploymentVm(address(vm))
            .setEnv("ETHEREUM_PRE111K_QUOTE_SIGNER", "0x2222222222222222222222222222222222222222");
        vm.chainId(1);
        DeployPre111K script = new DeployPre111K();
        Pre111K preorder = script.run();
        assertEq(preorder.admin(), script.TREASURY());
        assertEq(preorder.treasury(), script.TREASURY());
        assertEq(preorder.quoteSigner(), 0x2222222222222222222222222222222222222222);
        assertEq(preorder.MAX_RELICS(), 17);
        assertEq(preorder.totalReserved(), 0);
        assertEq(address(preorder).balance, 0);
        vm.chainId(11155111);
        vm.expectRevert();
        script.run();
    }
}
