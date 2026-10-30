pragma solidity 0.8.30;

import {Deploy111K} from "../script/Deploy111K.s.sol";
import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport} from "./TestSupport.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface DeploymentVm {
    function setEnv(string calldata name, string calldata value) external;
    function expectRevert(bytes calldata revertData) external;
}

contract DeploymentMetadataHarness is Deploy111K {
    function validate(string memory uri, uint256 chainId) external pure {
        _validateDeploymentMetadataBaseURI(uri, chainId);
    }
}

contract NFT111KDeploymentTest is TestSupport {
    uint256 private constant DEPLOYER_KEY = 0xD3110;
    address private constant BUYER = address(0xA110);
    address private constant NEXT_OWNER = address(0xB0B);
    address private constant SIGNER = address(0x5151);
    bytes32 private constant DISCOUNT_ROOT = keccak256("deployment-discounts");
    DeploymentMetadataHarness private harness;

    function setUp() public {
        harness = new DeploymentMetadataHarness();
    }

    function testRequiresDedicatedMetadataNamespace() public view {
        harness.validate("https://cdn.mons.shop/111k/mainnet-1/", 1);
        harness.validate("https://cdn.mons.shop/111k-sepolia/test-2/", 11155111);
        harness.validate("https://cdn.mons.shop/111k/1/", 1);
        harness.validate(
            "https://cdn.mons.shop/111k/abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz01/", 1
        );
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

    function testFreshPublicNetworkDeploymentsStartClosedAndSupportReliquaries() public {
        uint256[2] memory chains = [uint256(1), 11155111];
        string[2] memory prefixes =
            ["https://cdn.mons.shop/111k/mainnet-reliquaries-v1/", "https://cdn.mons.shop/111k-sepolia/v7/"];
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
            _assertClosedUntilOwnerOpens(token);
            _exerciseReliquarySale(token, prefixes[i]);
        }
    }

    function _assertDeployment(NFT111K token, uint256 chainId, string memory prefix) private view {
        assertEq(token.owner(), address(this));
        assertEq(token.quoteSigner(), SIGNER);
        assertEq(token.discountMerkleRoot(), DISCOUNT_ROOT);
        assertEq(token.baseURI(), prefix);
        assertTrue(address(token).code.length <= 24576);
        assertTrue(token.isApprovedForAll(BUYER, token.SEAPORT()));
        assertEq(token.CRATE_TOKEN_START(), 111112);
        assertEq(token.WAREHOUSE_TOKEN_START(), 116667);
        assertEq(token.RELIQUARY_TOKEN_START(), 117172);
        assertEq(token.MAX_RELIQUARIES(), 30);
        assertEq(token.CRATES_PER_RELIQUARY(), 111);
        assertEq(token.cratePrice(), 0.0001 ether);
        assertEq(token.warehousePrice(), 0.0011 ether);
        assertEq(token.discountCratePrice(), 0.00005 ether);
        assertEq(token.reliquaryPrice(), 0.0088 ether);
        (, string memory name, string memory version, uint256 domainChainId, address collection,,) =
            token.eip712Domain();
        assertEq(name, "111K");
        assertEq(version, "2");
        assertEq(domainChainId, chainId);
        assertEq(collection, address(token));
        string memory proceeds = vm.readFile("config/proceeds.json");
        address[] memory recipients = vm.parseJsonAddressArray(proceeds, ".mintRecipients");
        uint256[] memory shares = vm.parseJsonUintArray(proceeds, ".mintSharesBps");
        assertEq(token.deliveryPaymentReceiver(), vm.parseJsonAddress(proceeds, ".deliveryPaymentReceiver"));
        assertEq(token.mintRecipientCount(), recipients.length);
        for (uint256 i; i < recipients.length; ++i) {
            assertEq(token.mintRecipients(i), recipients[i]);
            assertEq(token.mintSharesBps(recipients[i]), shares[i]);
        }
    }

    function _assertClosedUntilOwnerOpens(NFT111K token) private {
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
        token.mintReliquaries{value: 0.0088 ether}(1);
        DeploymentVm(address(vm)).expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", BUYER));
        token.setSaleActive(true);
        vm.stopPrank();
        assertFalse(token.saleActive());
        _assertZeroSupply(token);
        token.setSaleActive(true);
        assertTrue(token.saleActive());
        _assertZeroSupply(token);
    }

    function _assertZeroSupply(NFT111K token) private view {
        assertEq(token.totalSupply(), 0);
        assertEq(token.allocatedCrates(), 0);
        assertEq(token.warehousesMinted(), 0);
        assertEq(token.reliquariesMinted(), 0);
        assertEq(token.remainingCrates(), 5555);
        (,, uint256 artworks,,,,,,,,,) = token.stats(BUYER);
        assertEq(artworks, 0);
        assertEq(token.discountUsed(BUYER), 0);
        assertEq(token.totalMintReceived(), 0);
        assertEq(token.totalMintReleased(), 0);
        assertEq(token.totalDeliveryReceived(), 0);
        assertEq(token.totalDeliveryReleased(), 0);
        assertEq(address(token).balance, 0);
    }

    function _assertMetadataBoundaries(NFT111K token, string memory prefix) private view {
        uint256[6] memory firstTokens = [uint256(1), 111112, 116667, 1000001, 2000001, 117172];
        uint256[6] memory maximumIds = [uint256(111111), 5555, 505, 222222, 5555, 30];
        for (uint256 i; i < firstTokens.length; ++i) {
            assertEq(token.previewTokenURI(uint8(i + 1), 1), _uri(prefix, firstTokens[i]));
            assertEq(
                token.previewTokenURI(uint8(i + 1), maximumIds[i]), _uri(prefix, firstTokens[i] + maximumIds[i] - 1)
            );
        }
    }

    function _exerciseReliquarySale(NFT111K token, string memory prefix) private {
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        token.mintReliquaries{value: 15 * 0.0088 ether}(15);
        token.setPrices(0.0002 ether, 0.0033 ether, 0.00007 ether, 0.0077 ether);
        vm.prank(BUYER);
        token.mintReliquaries{value: 15 * 0.0077 ether}(15);
        assertEq(token.allocatedCrates(), 3330);
        assertEq(token.remainingCrates(), 2225);
        assertEq(token.reliquaryFirstCrate(30), 3220);
        (,,,,,,,,,, uint256 minted, uint256 price) = token.stats(BUYER);
        assertEq(minted, 30);
        assertEq(price, 0.0077 ether);
        _assertToken(token, 117201, 6, 30, BUYER);
        assertEq(token.tokenURI(117201), _uri(prefix, 117201));
        vm.prank(token.SEAPORT());
        token.transferFrom(BUYER, NEXT_OWNER, 117201);
        vm.prank(NEXT_OWNER);
        token.unboxReliquary(117201);
        _assertToken(token, 117201, 0, 0, address(0));
        assertEq(token.balanceOf(NEXT_OWNER), 111);
        for (uint256 i; i < 111; ++i) {
            _assertToken(token, 114331 + i, 2, 3220 + i, NEXT_OWNER);
        }
        assertEq(token.tokenURI(114331), _uri(prefix, 114331));
        assertEq(token.tokenURI(114441), _uri(prefix, 114441));
        assertEq(token.allocatedCrates(), 3330);
        assertEq(token.reliquariesMinted(), 30);
        vm.prank(BUYER);
        vm.expectRevert(NFT111K.SoldOut.selector);
        token.mintReliquaries{value: 0.0077 ether}(1);
        _assertMintProceeds(token, 15 * (0.0088 ether + 0.0077 ether));
    }

    function _assertMintProceeds(NFT111K token, uint256 received) private {
        assertEq(token.totalMintReceived(), received);
        assertEq(token.totalDeliveryReceived(), 0);
        assertEq(token.releasableDelivery(), 0);
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
