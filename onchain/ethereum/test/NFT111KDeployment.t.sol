pragma solidity 0.8.30;

import {Deploy111K} from "../script/Deploy111K.s.sol";
import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport} from "./TestSupport.sol";

contract DeploymentMetadataHarness is Deploy111K {
    function validate(string memory uri, uint256 chainId) external pure {
        _validateDeploymentMetadataBaseURI(uri, chainId);
    }
}

contract NFT111KDeploymentTest is TestSupport {
    DeploymentMetadataHarness private harness;

    function setUp() public {
        harness = new DeploymentMetadataHarness();
    }

    function testRequiresDedicatedMetadataNamespace() public view {
        harness.validate("https://cdn.mons.shop/111k/mainnet-1/", 1);
        harness.validate("https://cdn.mons.shop/111k-sepolia/test-2/", 11155111);
        harness.validate("https://cdn.mons.shop/111k/1/", 1);
        harness.validate("https://cdn.mons.shop/111k/abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz01/", 1);
    }

    function testRejectsLegacyRootsAndCrossNetworkPrefixes() public {
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        harness.validate("https://cdn.mons.shop/111k/", 1);
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        harness.validate("https://cdn.mons.shop/111k-sepolia/", 11155111);
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        harness.validate("https://cdn.mons.shop/111k/test/", 11155111);
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        harness.validate("https://cdn.mons.shop/111k-sepolia/test/", 1);
        vm.expectRevert(NFT111K.InvalidBaseURI.selector);
        harness.validate("https://cdn.mons.shop/111k/test/", 10);
    }

    function testRejectsMalformedOrNoncanonicalDeploymentIds() public {
        string[10] memory invalid = [
            "https://cdn.mons.shop/111k//",
            "https://cdn.mons.shop/111k/-test/",
            "https://cdn.mons.shop/111k/UPPER/",
            "https://cdn.mons.shop/111k/a/b/",
            "https://cdn.mons.shop/111k/test/?/",
            "https://cdn.mons.shop/111k/test/#/",
            "https://cdn.mons.shop/111k/%61/",
            "http://cdn.mons.shop/111k/test/",
            "https://cdn.mons.shop/111k/abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz012/",
            "https://cdn.mons.shop/111k/test"
        ];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(NFT111K.InvalidBaseURI.selector);
            harness.validate(invalid[i], 1);
        }
    }
}
