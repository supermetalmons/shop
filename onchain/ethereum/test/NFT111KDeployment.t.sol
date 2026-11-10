pragma solidity 0.8.38;

import {Deploy111K} from "../script/Deploy111K.s.sol";
import {NFT111K} from "../src/NFT111K.sol";
import {DeliveryAccounting} from "./DeliveryAccounting.sol";
import {TestSupport, Vm, NFT111KStats} from "./TestSupport.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface DeploymentVm {
    function setEnv(string calldata name, string calldata value) external;
    function expectRevert(bytes calldata revertData) external;
}

contract DeploymentMetadataHarness is Deploy111K {
    function validate(string memory uri, uint256 chainId) external pure {
        _validateDeploymentMetadataBaseURI(uri, chainId);
    }

    function discountCap(string memory json, uint256 chainId) external pure returns (uint256) {
        return _discountCap(json, chainId);
    }

    function freeMints(string memory json, address collection)
        external
        view
        returns (NFT111K.FreeMintAllocation[] memory)
    {
        return _freeMintAllocations(json, collection);
    }
}

contract NFT111KDeploymentTest is TestSupport {
    uint256 private constant DEPLOYER_KEY = 0xD3110;
    address private constant BUYER = address(0xA110);
    address private constant NEXT_OWNER = address(0xB0B);
    address private constant SIGNER = address(0x5151);
    address private constant INITIAL_DELIVERY_RECEIVER = address(0xD311D);
    bytes32 private constant DISCOUNT_ROOT = keccak256("deployment-discounts");
    DeploymentMetadataHarness private harness;

    function setUp() public {
        harness = new DeploymentMetadataHarness();
        DeploymentVm(address(vm)).setEnv("ETHEREUM_111K_FREE_MINT_CONFIG", "config/free-mints.json");
        DeploymentVm(address(vm)).setEnv("ETHEREUM_111K_DISCOUNT_CAP_CONFIG", "config/discount-caps.json");
        DeploymentVm(address(vm))
            .setEnv("ETHEREUM_111K_INITIAL_DELIVERY_RECEIVER", Strings.toHexString(INITIAL_DELIVERY_RECEIVER));
    }

    function testDiscountCapConfigurationUsesNetworkDefaultsAndAcceptsBounds() public view {
        string memory config = vm.readFile("config/discount-caps.json");
        assertEq(harness.discountCap(config, 1), 500);
        assertEq(harness.discountCap(config, 11155111), 5555);
        assertEq(harness.discountCap(config, 31337), 5555);
        config = '{"mainnet":0,"sepolia":123,"local":5555}';
        assertEq(harness.discountCap(config, 1), 0);
        assertEq(harness.discountCap(config, 11155111), 123);
        assertEq(harness.discountCap(config, 31337), 5555);
    }

    function testDiscountCapConfigurationRejectsInvalidShapeAndUnsupportedChains() public {
        string[5] memory invalid = [
            '{"mainnet":500,"sepolia":5555}',
            '{"mainnet":500,"sepolia":5555,"unknown":5555}',
            '{"mainnet":500,"sepolia":5555,"local":5555,"extra":1}',
            "[]",
            "null"
        ];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert();
            harness.discountCap(invalid[i], 1);
        }
        vm.expectRevert(NFT111K.InvalidDiscountConfig.selector);
        harness.discountCap('{"mainnet":500,"sepolia":5555,"local":5555}', 10);
    }

    function testDiscountCapConfigurationMatchesSharedNormalizationFixture() public view {
        string memory config = vm.readFile("fixtures/discount-caps.json");
        assertEq(harness.discountCap(config, 1), 0);
        assertEq(harness.discountCap(config, 11155111), 500);
        assertEq(harness.discountCap(config, 31337), 5555);
    }

    function testDiscountCapConfigurationRejectsInvalidNumbersEvenOnAnotherNetwork() public {
        string[11] memory invalid = ["-1", "1.5", "5556", '"500"', "true", "false", "null", "[]", "{}", '"0x01"', "1e2"];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert();
            harness.discountCap(string.concat('{"mainnet":500,"sepolia":', invalid[i], ',"local":5555}'), 1);
        }
    }

    function testMaximumDeploymentConfigurationFitsRuntimeAndInitcodeLimits() public {
        address[] memory recipients = new address[](32);
        uint256[] memory shares = new uint256[](32);
        NFT111K.FreeMintAllocation[] memory allocations = new NFT111K.FreeMintAllocation[](32);
        bytes memory deploymentId = new bytes(64);
        for (uint256 i; i < deploymentId.length; ++i) {
            deploymentId[i] = "a";
        }
        string memory uri = string.concat("https://cdn.mons.shop/111k-sepolia/", string(deploymentId), "/");
        for (uint256 i; i < 32; ++i) {
            recipients[i] = address(uint160(0xC00001 + i));
            shares[i] = i < 16 ? 313 : 312;
            allocations[i] = NFT111K.FreeMintAllocation(address(uint160(0xD00001 + i)), 5555, 505, 18);
        }
        bytes memory arguments = abi.encode(
            address(this), SIGNER, address(0xBEEF), uri, DISCOUNT_ROOT, recipients, shares, allocations, 5555
        );
        assertEq(arguments.length, 6688);
        assertTrue(type(NFT111K).creationCode.length + arguments.length <= 49_152);
        NFT111K token = new NFT111K(
            address(this), SIGNER, address(0xBEEF), uri, DISCOUNT_ROOT, recipients, shares, allocations, 5555
        );
        assertTrue(address(token).code.length <= 24_576);
        assertEq(token.mintRecipientCount(), 32);
        assertEq(token.baseURI(), uri);
    }

    function testFreeMintConfigurationMatchesSharedFixture() public view {
        NFT111K.FreeMintAllocation[] memory allocations =
            harness.freeMints(vm.readFile("fixtures/free-mints.json"), address(0x123));
        assertEq(allocations.length, 4);
        assertEq(allocations[0].wallet, BUYER);
        assertEq(allocations[0].crateLimit, 100);
        assertEq(allocations[0].warehouseLimit, 1);
        assertEq(allocations[0].relicLimit, 0);
        assertEq(allocations[1].wallet, address(0xCA10));
        assertEq(allocations[1].crateLimit, 100);
        assertEq(allocations[2].wallet, NEXT_OWNER);
        assertEq(allocations[2].crateLimit, 5);
        assertEq(allocations[2].warehouseLimit, 0);
        assertEq(allocations[3].wallet, address(0xD00D));
        assertEq(allocations[3].relicLimit, 1);
        assertEq(harness.freeMints('{"groups":[]}', address(0x123)).length, 0);
        assertEq(harness.freeMints(_freeMintGroup("", "0", "0", "0"), address(0x123)).length, 0);
    }

    function testFreeMintConfigurationRejectsNonArrayGroupsAndWallets() public {
        string[7] memory invalid =
            ["null", "false", "0", '""', '"[]"', "{}", '"[0x000000000000000000000000000000000000a110]"'];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert();
            harness.freeMints(string.concat('{"groups":', invalid[i], "}"), address(0x123));
            vm.expectRevert();
            harness.freeMints(
                string.concat(
                    '{"groups":[{"name":"A","crates":0,"warehouses":1,"relics":1,"wallets":', invalid[i], "}]}"
                ),
                address(0x123)
            );
        }
    }

    function testFreeMintConfigurationAcceptsHexLookingGroupNames() public view {
        string[4] memory names = [
            "0x01",
            "0x000000000000000000000000000000000000a110",
            "0x0000000000000000000000000000000000000000000000000000000000000001",
            "0xnothex"
        ];
        for (uint256 i; i < names.length; ++i) {
            NFT111K.FreeMintAllocation[] memory allocations = harness.freeMints(
                string.concat(
                    '{"groups":[{"name":"',
                    names[i],
                    '","crates":100,"warehouses":1,"relics":0,"wallets":["0x000000000000000000000000000000000000a110"]}]}'
                ),
                address(0x123)
            );
            assertEq(allocations.length, 1);
            assertEq(allocations[0].wallet, BUYER);
            assertEq(allocations[0].crateLimit, 100);
            assertEq(allocations[0].warehouseLimit, 1);
            assertEq(allocations[0].relicLimit, 0);
        }
    }

    function testFreeMintConfigurationBoundsAndSharedInventoryOvercommit() public {
        string memory wallets;
        for (uint256 i; i < 33; ++i) {
            wallets = string.concat(wallets, i == 0 ? "" : ",", '"', Strings.toHexString(address(uint160(i + 1))), '"');
            if (i == 31) {
                NFT111K.FreeMintAllocation[] memory allocations =
                    harness.freeMints(_freeMintGroup(wallets, "5555", "505", "18"), address(0x123));
                assertEq(allocations.length, 32);
                assertEq(allocations[31].crateLimit, 5555);
            }
        }
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        harness.freeMints(_freeMintGroup(wallets, "1", "0", "0"), address(0x123));
    }

    function testFreeMintConfigurationRejectsInvalidLimitsAndGroups() public {
        string[12] memory limits = [
            "-1",
            "1.5",
            "5556",
            '"1"',
            "true",
            "false",
            "null",
            "65536",
            "[]",
            '"0x01"',
            '"0x0000000000000000000000000000000000000001"',
            '"0x0000000000000000000000000000000000000000000000000000000000000001"'
        ];
        for (uint256 i; i < limits.length; ++i) {
            vm.expectRevert();
            harness.freeMints(_freeMintGroup("", limits[i], "0", "0"), address(0x123));
        }
        vm.expectRevert();
        harness.freeMints(_freeMintGroup("", "0", "506", "0"), address(0x123));
        vm.expectRevert();
        harness.freeMints(_freeMintGroup("", "0", "0", "19"), address(0x123));
        vm.expectRevert();
        harness.freeMints(
            '{"groups":[{"name":"A","crates":0,"warehouses":0,"relics":0,"wallets":[],"extra":1}]}', address(0x123)
        );
        vm.expectRevert();
        harness.freeMints('{"groups":[{"name":"","crates":0,"warehouses":0,"relics":0,"wallets":[]}]}', address(0x123));
        vm.expectRevert();
        harness.freeMints(
            '{"groups":[{"name":"A","crates":0,"warehouses":0,"relics":0,"wallets":[]},{"name":"A","crates":0,"warehouses":0,"relics":0,"wallets":[]}]}',
            address(0x123)
        );
    }

    function testFreeMintConfigurationRejectsInvalidAddressesAndDuplicateMembership() public {
        string memory buyer = string.concat('"', Strings.toHexString(BUYER), '"');
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        harness.freeMints(_freeMintGroup(buyer, "1", "0", "0"), BUYER);
        vm.expectRevert(NFT111K.InvalidAddress.selector);
        harness.freeMints(_freeMintGroup('"0x0000000000000000000000000000000000000000"', "1", "0", "0"), address(0x123));
        vm.expectRevert();
        harness.freeMints(_freeMintGroup('"0x1234"', "1", "0", "0"), address(0x123));
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        harness.freeMints(_freeMintGroup(string.concat(buyer, ",", buyer), "1", "0", "0"), address(0x123));
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        harness.freeMints(
            '{"groups":[{"name":"A","crates":1,"warehouses":0,"relics":0,"wallets":["0x000000000000000000000000000000000000A110"]},{"name":"B","crates":2,"warehouses":0,"relics":0,"wallets":["0x000000000000000000000000000000000000a110"]}]}',
            address(0x123)
        );
    }

    function testFreeMintConfigurationRequiresDecimalIntegerLiterals() public {
        vm.expectRevert();
        harness.freeMints(_freeMintGroup("", "1.0", "0", "0"), address(0x123));
        vm.expectRevert();
        harness.freeMints(_freeMintGroup("", "1e2", "0", "0"), address(0x123));
    }

    function testSepoliaConfigurationAcceptsEitherRootKeyOrder() public {
        string memory groups =
            '[{"name":"A","crates":0,"warehouses":0,"relics":3,"wallets":["0x000000000000000000000000000000000000a110"]}]';
        string[2] memory configs = [
            string.concat('{"chainId":11155111,"groups":', groups, "}"),
            string.concat('{"groups":', groups, ',"chainId":11155111}')
        ];
        for (uint256 i; i < configs.length; ++i) {
            vm.chainId(11155111);
            NFT111K.FreeMintAllocation[] memory allocations = harness.freeMints(configs[i], address(0x123));
            assertEq(allocations.length, 1);
            assertEq(allocations[0].wallet, BUYER);
            assertEq(allocations[0].relicLimit, 3);
            vm.chainId(1);
            vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
            harness.freeMints(configs[i], address(0x123));
        }
    }

    function testSepoliaRelicPresetCannotBeUsedOnMainnetOrAnvil() public {
        string memory preset = vm.readFile("config/free-mints.sepolia.json");
        vm.chainId(1);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        harness.freeMints(preset, address(0x123));
        vm.chainId(31337);
        vm.expectRevert(NFT111K.InvalidFreeMintConfig.selector);
        harness.freeMints(preset, address(0x123));
        vm.chainId(11155111);
        NFT111K.FreeMintAllocation[] memory allocations = harness.freeMints(preset, address(0x123));
        address[7] memory wallets = [
            address(0xE26067c76fdbe877F48b0a8400cf5Db8B47aF0fE),
            0xE4790DD79c334e3f848904975272ec17f9F70366,
            0xE938eBB66B92692Ab01F76C99cFAc1928482e7b9,
            0x29f7a2cfe212492dDB343035479D062112284DDf,
            0x31CD63C73E74808793F134f8146a1E3AA1637B5d,
            0xf743b8e23d3FFcbdE398ABA9b9F83a98F56845f4,
            0x336C8E2ADd19149bfc934fb2557C6bdEffa8009B
        ];
        assertEq(allocations.length, wallets.length);
        uint256 relics;
        for (uint256 i; i < allocations.length; ++i) {
            assertEq(allocations[i].wallet, wallets[i]);
            assertEq(allocations[i].crateLimit, 0);
            assertEq(allocations[i].warehouseLimit, 0);
            assertEq(allocations[i].relicLimit, 1);
            relics += allocations[i].relicLimit;
        }
        assertEq(relics, 7);
        vm.chainId(1);
        assertEq(harness.freeMints(vm.readFile("config/free-mints.json"), address(0x123)).length, 0);
    }

    function testConfiguredFreeMintsDeployAtomicallyWithDistinctOwner() public {
        DeploymentVm env = DeploymentVm(address(vm));
        env.setEnv("ETHEREUM_111K_DEPLOYER_KEY", Strings.toString(DEPLOYER_KEY));
        env.setEnv("ETHEREUM_111K_OWNER", Strings.toHexString(address(this)));
        env.setEnv("ETHEREUM_111K_QUOTE_SIGNER", Strings.toHexString(SIGNER));
        env.setEnv("ETHEREUM_111K_DISCOUNT_ROOT", Strings.toHexString(uint256(DISCOUNT_ROOT), 32));
        env.setEnv("ETHEREUM_111K_METADATA_BASE_URI", "https://cdn.mons.shop/111k/free-mints-test/");
        env.setEnv("ETHEREUM_111K_FREE_MINT_CONFIG", "fixtures/free-mints.json");
        vm.chainId(1);
        address deployer = vm.addr(DEPLOYER_KEY);
        uint64 nonce = vm.getNonce(deployer);
        vm.recordLogs();
        NFT111K token = harness.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 registrations;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(token)
                    || logs[i].topics[0] != keccak256("DeliveryConfigRegistered(uint256,address,address,uint16)")
            ) continue;
            registrations++;
            assertEq(logs[i].topics[1], bytes32(uint256(1)));
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(INITIAL_DELIVERY_RECEIVER))));
            assertEq(logs[i].topics[3], bytes32(0));
            assertEq(abi.decode(logs[i].data, (uint16)), 0);
        }
        assertEq(registrations, 1);
        assertEq(token.deliveryConfigCount(), 1);
        assertEq(address(token), vm.computeCreateAddress(deployer, nonce));
        assertEq(vm.getNonce(deployer), nonce + 1);
        assertEq(token.owner(), address(this));
        assertTrue(deployer != token.owner());
        _assertZeroSupply(token);
        NFT111K.FreeMintAllocation[] memory allocations =
            harness.freeMints(vm.readFile("fixtures/free-mints.json"), address(token));
        for (uint256 i; i < allocations.length; ++i) {
            NFT111K.FreeMintAllocation memory allocation = allocations[i];
            (
                uint16 crates,
                uint16 warehouses,
                uint16 relics,
                uint16 cratesUsed,
                uint16 warehousesUsed,
                uint16 relicsUsed
            ) = token.freeMintAllowances(allocation.wallet);
            assertEq(crates, allocation.crateLimit);
            assertEq(warehouses, allocation.warehouseLimit);
            assertEq(relics, allocation.relicLimit);
            assertEq(cratesUsed + warehousesUsed + relicsUsed, 0);
        }
        _assertClosedUntilOwnerOpens(token, false);
        vm.prank(BUYER);
        token.mintFree(NFT111K.ItemKind.Crate, 15);
        assertEq(token.allocatedCrates(), 15);
        assertEq(token.totalMintReceived(), 0);
    }

    function _freeMintGroup(string memory wallets, string memory crates, string memory warehouses, string memory relics)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '{"groups":[{"name":"A","crates":',
            crates,
            ',"warehouses":',
            warehouses,
            ',"relics":',
            relics,
            ',"wallets":[',
            wallets,
            "]}]}"
        );
    }

    function testAcceptsMainnetRootAndDedicatedMetadataNamespaces() public view {
        harness.validate("https://cdn.mons.shop/111k/", 1);
        harness.validate("https://cdn.mons.shop/111k/mainnet-1/", 1);
        harness.validate("https://cdn.mons.shop/111k-sepolia/test-2/", 11155111);
        harness.validate("https://cdn.mons.shop/111k/1/", 1);
        harness.validate(
            "https://cdn.mons.shop/111k/abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz01/", 1
        );
    }

    function testRejectsSepoliaRootAndCrossNetworkPrefixes() public {
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

    function testFreshPublicNetworkDeploymentsStartClosedAndSupportRelicsAndReceipts() public {
        uint256[2] memory chains = [uint256(1), 11155111];
        string[2] memory prefixes = ["https://cdn.mons.shop/111k/", "https://cdn.mons.shop/111k-sepolia/v9/"];
        DeploymentVm env = DeploymentVm(address(vm));
        env.setEnv("ETHEREUM_111K_DEPLOYER_KEY", Strings.toString(DEPLOYER_KEY));
        env.setEnv("ETHEREUM_111K_OWNER", Strings.toHexString(address(this)));
        env.setEnv("ETHEREUM_111K_QUOTE_SIGNER", Strings.toHexString(SIGNER));
        env.setEnv("ETHEREUM_111K_DISCOUNT_ROOT", Strings.toHexString(uint256(DISCOUNT_ROOT), 32));
        address deployer = vm.addr(DEPLOYER_KEY);
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            env.setEnv("ETHEREUM_111K_METADATA_BASE_URI", prefixes[i]);
            address expected = vm.computeCreateAddress(deployer, uint256(vm.getNonce(deployer)));
            NFT111K token = harness.run();
            assertEq(address(token), expected);
            _assertDeployment(token, chains[i], prefixes[i]);
            _assertMetadataBoundaries(token, prefixes[i]);
            _assertClosedUntilOwnerOpens(token, true);
            _exerciseRelicSale(token, prefixes[i]);
        }
    }

    function _assertDeployment(NFT111K token, uint256 chainId, string memory prefix) private view {
        assertEq(token.owner(), address(this));
        assertEq(token.quoteSigner(), SIGNER);
        assertEq(token.deliveryConfigCount(), 1);
        NFT111K.DeliveryConfig memory initialConfig = DeliveryAccounting.config(token, 1);
        assertEq(initialConfig.receiver1, INITIAL_DELIVERY_RECEIVER);
        assertEq(initialConfig.receiver2, address(0));
        assertEq(initialConfig.receiver2Bps, 0);
        assertEq(initialConfig.totalReceived + initialConfig.released1 + initialConfig.released2, 0);
        assertEq(token.discountMerkleRoot(), DISCOUNT_ROOT);
        assertEq(token.maxDiscountedMints(), chainId == 1 ? 500 : 5555);
        assertEq(token.totalDiscountedMints(), 0);
        assertEq(token.baseURI(), prefix);
        assertTrue(address(token).code.length <= 24576);
        assertTrue(token.isApprovedForAll(BUYER, token.SEAPORT()));
        assertEq(token.CRATE_TOKEN_START(), 111112);
        assertEq(token.WAREHOUSE_TOKEN_START(), 116667);
        assertEq(token.RELIC_TOKEN_START(), 117172);
        assertEq(token.RELIC_RECEIPT_OFFSET(), 3000000);
        assertEq(token.MAX_RELICS(), 18);
        assertEq(token.CRATES_PER_RELIC(), 111);
        assertEq(token.cratePrice(), 0.0001 ether);
        assertEq(token.warehousePrice(), 0.0011 ether);
        assertEq(token.discountCratePrice(), 0.00005 ether);
        assertEq(token.relicsAllocated(), 0);
        (, string memory name, string memory version, uint256 domainChainId, address collection,,) =
            token.eip712Domain();
        assertEq(name, "111K");
        assertEq(version, "2");
        assertEq(domainChainId, chainId);
        assertEq(collection, address(token));
        address[14] memory recipients = [
            0x51Ec8729331E284c4B5e8EcA8e0D184FeD18632F,
            0x8B573abc736c82216D738Af3024F3a45fC3b18E3,
            0xE938eBB66B92692Ab01F76C99cFAc1928482e7b9,
            0x1B591f88d9bFcF7d057DF2c5a50b59Da2cBa349f,
            0x07d2d89b4A6E3fdA8858Da3510b76e2219eE6969,
            0x603C39B3D0E0f33772d79695A4F6819FCc987113,
            0xa07E7932f5C981aA769A1Cf9400B5c94AdB944c4,
            0x2236Fb6C35f78A092F0DdA655f3b49d0e8Bf6581,
            0x71d0318BB33d961f323C81a7a4Ca095b549F7E6E,
            0xc4275E6D4109e0288cDc9b064E32F3f54bcDA61F,
            0x72D0c5623A05033F9eE4495D408BC6c05DF8367d,
            0x0AdF7B78c952E038d4eA4B5bF84B9d3D22C60Ce9,
            0xB0B4EC16bE55af47109947F0dC84C4561A020A4B,
            0xd9488d6687d656a55B3F1a36998d149f9b1bE2Cc
        ];
        uint256[14] memory shares = [uint256(2750), 2600, 500, 500, 500, 500, 100, 100, 100, 100, 500, 583, 583, 584];
        assertEq(token.mintRecipientCount(), recipients.length);
        uint256 totalShares;
        for (uint256 i; i < recipients.length; ++i) {
            assertEq(token.mintRecipients(i), recipients[i]);
            assertEq(token.mintSharesBps(recipients[i]), shares[i]);
            totalShares += shares[i];
        }
        assertEq(totalShares, 10_000);
    }

    function _assertClosedUntilOwnerOpens(NFT111K token, bool allocate) private {
        assertFalse(token.saleActive());
        _assertZeroSupply(token);
        vm.deal(BUYER, 1 ether);
        vm.startPrank(BUYER);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintCrates{value: 0.0001 ether}(1);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintCratesDiscounted{value: 0.00005 ether}(1, new bytes32[](0));
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintWarehouses{value: 0.0011 ether}(1);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.claimRelic(1);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintFree(NFT111K.ItemKind.Crate, 1);
        vm.expectRevert(NFT111K.SaleInactive.selector);
        token.mintFree(NFT111K.ItemKind.Warehouse, 1);
        vm.expectRevert(NFT111K.WrongItemKind.selector);
        token.mintFree(NFT111K.ItemKind.Relic, 1);
        DeploymentVm(address(vm)).expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", BUYER));
        token.setSaleActive(true);
        vm.stopPrank();
        assertFalse(token.saleActive());
        _assertZeroSupply(token);
        if (allocate) {
            vm.deal(address(this), 1 ether);
            token.allocateRelics{value: 0.15 ether}(18);
            address[] memory wallets = new address[](1);
            wallets[0] = BUYER;
            token.setFreeMintAllowances(wallets, 0, 0, 18);
        }
        token.setSaleActive(true);
        assertTrue(token.saleActive());
        assertEq(token.relicsAllocated(), allocate ? 18 : 0);
        assertEq(token.totalSupply(), 0);
    }

    function _assertZeroSupply(NFT111K token) private view {
        assertEq(token.totalSupply(), 0);
        assertEq(token.allocatedCrates(), 0);
        assertEq(token.warehousesMinted(), 0);
        assertEq(token.relicsMinted(), 0);
        assertEq(token.remainingCrates(), 5555);
        uint256 artworks = NFT111KStats(address(token)).stats(BUYER).artworksMinted_;
        assertEq(artworks, 0);
        assertEq(token.discountUsed(BUYER), 0);
        assertEq(token.totalMintReceived(), 0);
        assertEq(token.totalMintReleased(), 0);
        assertEq(DeliveryAccounting.received(token), 0);
        assertEq(DeliveryAccounting.released(token), 0);
        assertEq(address(token).balance, 0);
    }

    function _assertMetadataBoundaries(NFT111K token, string memory prefix) private {
        uint256[7] memory firstTokens = [uint256(1), 111112, 116667, 1000001, 2000001, 117172, 3000001];
        uint256[7] memory maximumIds = [uint256(111111), 5555, 505, 222222, 5555, 18, 18];
        for (uint256 i; i < firstTokens.length; ++i) {
            assertEq(token.previewTokenURI(uint8(i + 1), 1), _uri(prefix, firstTokens[i]));
            assertEq(
                token.previewTokenURI(uint8(i + 1), maximumIds[i]), _uri(prefix, firstTokens[i] + maximumIds[i] - 1)
            );
        }
        vm.expectRevert(NFT111K.InvalidMetadataItem.selector);
        token.previewTokenURI(7, 19);
    }

    function _exerciseRelicSale(NFT111K token, string memory prefix) private {
        vm.deal(BUYER, 1 ether);
        vm.startPrank(BUYER);
        for (uint256 id = 1; id <= 15; ++id) {
            token.claimRelic(id);
        }
        vm.stopPrank();
        token.setPrices(0.0002 ether, 0.0033 ether, 0.00007 ether);
        vm.startPrank(BUYER);
        for (uint256 id = 16; id <= 18; ++id) {
            token.claimRelic(id);
        }
        vm.stopPrank();
        assertEq(token.allocatedCrates(), 1998);
        assertEq(token.remainingCrates(), 3557);
        assertEq(token.relicFirstCrate(18), 1888);
        NFT111KStats.Stats memory snapshot2 = NFT111KStats(address(token)).stats(BUYER);
        uint256 allocated = snapshot2.relicsAllocated_;
        uint256 minted = snapshot2.relicsMinted_;
        assertEq(minted, 18);
        assertEq(allocated, 18);
        _assertToken(token, 117189, 6, 18, BUYER);
        assertEq(token.tokenURI(117189), _uri(prefix, 117189));
        vm.prank(token.SEAPORT());
        token.transferFrom(BUYER, NEXT_OWNER, 117189);
        vm.prank(NEXT_OWNER);
        token.unboxRelic(117189);
        _assertToken(token, 117189, 0, 0, address(0));
        assertEq(token.balanceOf(NEXT_OWNER), 111);
        for (uint256 i; i < 111; ++i) {
            _assertToken(token, 112999 + i, 2, 1888 + i, NEXT_OWNER);
        }
        assertEq(token.tokenURI(112999), _uri(prefix, 112999));
        assertEq(token.tokenURI(113109), _uri(prefix, 113109));
        assertEq(token.allocatedCrates(), 1998);
        assertEq(token.relicsMinted(), 18);
        vm.prank(BUYER);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.claimRelic(1);
        _assertMintProceeds(token, 0.15 ether);
    }

    function _assertMintProceeds(NFT111K token, uint256 received) private {
        assertEq(token.totalMintReceived(), received);
        assertEq(DeliveryAccounting.received(token), 0);
        assertEq(DeliveryAccounting.pending(token, address(0xBEEF)), 0);
        uint256[] memory balances = new uint256[](token.mintRecipientCount());
        for (uint256 i; i < balances.length; ++i) {
            balances[i] = token.mintRecipients(i).balance;
        }
        vm.prank(BUYER);
        token.releaseAllMint();
        uint256 released;
        for (uint256 i; i < token.mintRecipientCount(); ++i) {
            address recipient = token.mintRecipients(i);
            uint256 amount = received * token.mintSharesBps(recipient) / 10000;
            assertEq(recipient.balance - balances[i], amount);
            assertEq(token.mintReleased(recipient), amount);
            assertEq(token.releasableMint(recipient), 0);
            token.releaseMint(recipient);
            assertEq(recipient.balance - balances[i], amount);
            released += amount;
        }
        assertEq(token.totalMintReleased(), released);
        assertEq(address(token).balance, received - released);
    }

    function _assertToken(NFT111K token, uint256 id, uint8 kind, uint256 number, address holder) private view {
        (uint8 actualKind, uint256 actualNumber, address actualHolder) = token.getTokenInfo(id);
        assertEq(actualKind, kind);
        assertEq(actualNumber, number);
        assertEq(actualHolder, holder);
    }

    function _uri(string memory prefix, uint256 tokenId) private pure returns (string memory) {
        return string.concat(prefix, Strings.toString(tokenId), ".json");
    }
}
