pragma solidity 0.8.38;

import {Pre111K} from "../src/Pre111K.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

interface Pre111KForkVm {
    function activeFork() external view returns (uint256);
    function skip(bool skipTest) external;
}

interface Pre111KSafe {
    function VERSION() external view returns (string memory);
    function getThreshold() external view returns (uint256);
}

contract Pre111KSafeForkTest is TestSupport {
    address internal constant TREASURY = 0x72D0c5623A05033F9eE4495D408BC6c05DF8367d;

    function testForkPermissionlessWithdrawalReachesActualMainnetSafe() public {
        try Pre111KForkVm(address(vm)).activeFork() returns (uint256) {}
        catch {
            Pre111KForkVm(address(vm)).skip(true);
        }
        require(block.chainid == 1, "mainnet fork required");
        assertTrue(TREASURY.code.length > 0);
        assertEq(Pre111KSafe(TREASURY).VERSION(), "1.5.0");
        assertTrue(Pre111KSafe(TREASURY).getThreshold() > 0);
        Pre111K preorder = new Pre111K(TREASURY, TREASURY, vm.addr(0xA11CE));
        uint256 selloutBalance = preorder.MAX_RELICS() * 2.3 ether;
        uint256 balanceBefore = TREASURY.balance;
        vm.deal(address(preorder), selloutBalance);
        vm.recordLogs();
        vm.prank(address(0xB0B));
        preorder.withdraw();
        assertEq(TREASURY.balance, balanceBefore + selloutBalance);
        assertEq(address(preorder).balance, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].emitter, TREASURY);
        assertEq(logs[0].topics[0], keccak256("SafeReceived(address,uint256)"));
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(address(preorder)))));
        assertEq(abi.decode(logs[0].data, (uint256)), selloutBalance);
        assertEq(logs[1].emitter, address(preorder));
    }
}
