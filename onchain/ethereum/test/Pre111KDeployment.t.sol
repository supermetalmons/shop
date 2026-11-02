pragma solidity 0.8.38;

import {Pre111K} from "../src/Pre111K.sol";
import {DeployPre111K} from "../script/DeployPre111K.s.sol";
import {TestSupport} from "./TestSupport.sol";

interface Pre111KDeploymentVm {
    function setEnv(string calldata key, string calldata value) external;
}

contract Pre111KDeploymentHarness is DeployPre111K {
    function configuration(uint256 chainId) external pure returns (address, uint256) {
        return _configuration(chainId);
    }
}

contract Pre111KDeploymentTest is TestSupport {
    function testDeploymentPinsBothNetworkPricesAndImmutableRoles() public {
        Pre111KDeploymentHarness script = new Pre111KDeploymentHarness();
        (address admin, uint256 price) = script.configuration(1);
        assertEq(admin, script.TREASURY());
        assertEq(price, 2.3 ether);
        (admin, price) = script.configuration(11155111);
        assertEq(admin, script.SEPOLIA_ADMIN());
        assertEq(price, 0.0023 ether);
        vm.expectRevert();
        script.configuration(31337);
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
        assertEq(preorder.price(), 2.3 ether);
        assertEq(preorder.totalReserved(), 0);
        assertEq(address(preorder).balance, 0);
        vm.chainId(11155111);
        vm.expectRevert();
        script.run();
    }
}
