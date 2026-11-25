pragma solidity 0.8.38;

import {TarotCards} from "../src/TarotCards.sol";
import {DMXTestSupport, DMXFixtureRenderer} from "./DMXTestSupport.sol";

contract DMXGasTest is DMXTestSupport {
    function setUp() public override {
        vm.chainId(1);
        vm.warp(2_000_000_000);
        renderer = new DMXFixtureRenderer();
        token = new TarotCards(address(this), vm.addr(SIGNER_KEY), address(renderer));
        token.setRedemptionsPaused(false);
    }

    function testGasClaimFirst() public {
        _claim(ALICE, 1);
        vm.snapshotGasLastCall("claimFirst");
        assertEq(token.ownerOf(1), ALICE);
        assertEq(token.ownerOf(1_000_000), ALICE);
    }

    function testGasClaimPopulatedBucket() public {
        _claim(BOB, 1);
        _claim(ALICE, 2);
        vm.snapshotGasLastCall("claimPopulatedBucket");
        assertEq(token.ownerOf(2), ALICE);
        assertEq(token.ownerOf(1_000_001), ALICE);
    }

    function testGasMintInitial50() public {
        token.mintTo(ALICE, _range(1, 50));
        vm.snapshotGasLastCall("mintInitial50");
        assertEq(token.balanceOf(ALICE), 100);
    }

    function testGasMintFuture50() public {
        token.mintTo(ALICE, _range(778, 50));
        vm.snapshotGasLastCall("mintFuture50");
        assertEq(token.balanceOf(ALICE), 50);
    }

    function testGasMintSparseFuture50() public {
        uint256[] memory ids = new uint256[](50);
        for (uint256 i; i < ids.length; ++i) ids[i] = 778 + 256 * i;
        token.mintTo(ALICE, ids);
        vm.snapshotGasLastCall("mintSparseFuture50");
        assertEq(token.balanceOf(ALICE), 50);
        assertEq(token.ownerOf(ids[49]), ALICE);
    }

    function testGasRedeemInitial1() public {
        _redeemInitial(1);
        vm.snapshotGasLastCall("redeemInitial1");
        assertEq(token.ownerOf(778), ALICE);
        assertEq(token.generation(778), 1);
    }

    function testGasRedeemInitial50() public {
        _redeemInitial(50);
        vm.snapshotGasLastCall("redeemInitial50");
        assertEq(token.ownerOf(827), ALICE);
        assertEq(token.generation(827), 1);
    }

    function testGasGetRedemption1() public {
        _getRedemption(1, "getRedemption1");
    }

    function testGasGetRedemption50() public {
        _getRedemption(50, "getRedemption50");
    }

    function _redeemInitial(uint256 quantity) private returns (uint256[] memory inputs, uint256[] memory outputs) {
        inputs = _range(1, quantity);
        outputs = _range(778, quantity);
        token.mintTo(ALICE, inputs);
        _redeem(inputs, outputs, _quote(ALICE, ALICE, 1, 0, 0));
    }

    function _getRedemption(uint256 quantity, string memory snapshot) private {
        (uint256[] memory inputs, uint256[] memory outputs) = _redeemInitial(quantity);
        (address wallet, address recipient, uint256[] memory storedInputs, uint256[] memory storedOutputs) =
            token.getRedemption(1);
        vm.snapshotGasLastCall(snapshot);
        assertEq(wallet, ALICE);
        assertEq(recipient, ALICE);
        _sameIds(storedInputs, inputs);
        _sameIds(storedOutputs, outputs);
    }
}
