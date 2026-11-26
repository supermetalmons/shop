pragma solidity 0.8.38;

import {DMXOffchainRenderer} from "../src/DMXOffchainRenderer.sol";
import {IDMXRenderer} from "../src/IDMXRenderer.sol";
import {DMXTestSupport} from "./DMXTestSupport.sol";
import {TestSupport, Vm} from "./TestSupport.sol";

contract DMXOffchainRendererTest is TestSupport {
    DMXOffchainRenderer private renderer;

    function setUp() public {
        renderer = new DMXOffchainRenderer();
    }

    function testTokenKindBoundariesUseErc721TokenIds() public view {
        assertEq(renderer.tokenURI(address(0), 1), "https://cdn.mons.shop/dmx/1.json");
        assertEq(renderer.tokenURI(address(0), 777), "https://cdn.mons.shop/dmx/777.json");
        assertEq(renderer.tokenURI(address(0), 778), "https://cdn.mons.shop/dmx/778.json");
        assertEq(renderer.tokenURI(address(0), 999_999), "https://cdn.mons.shop/dmx/999999.json");
        assertEq(renderer.tokenURI(address(0), 1_000_000), "https://cdn.mons.shop/dmx/1000000.json");
        assertEq(renderer.tokenURI(address(0), 1_000_776), "https://cdn.mons.shop/dmx/1000776.json");
        assertEq(renderer.tokenURI(address(0), 1_000_777), "https://cdn.mons.shop/dmx/1000777.json");
        assertEq(renderer.tokenURI(address(0), 2_000_775), "https://cdn.mons.shop/dmx/2000775.json");
    }

    function testMetadataLocationsAreSharedAcrossCollectionsAndNetworks() public {
        vm.chainId(1);
        string memory mainnet = renderer.tokenURI(address(1), 1_000_000);
        vm.chainId(11155111);
        assertEq(renderer.tokenURI(address(2), 1_000_000), mainnet);
        assertEq(renderer.contractURI(address(1)), "https://cdn.mons.shop/dmx/collection.json");
        assertEq(renderer.contractURI(address(2)), renderer.contractURI(address(1)));
    }

    function testRendererSupportsRequiredInterfaces() public view {
        assertTrue(renderer.supportsInterface(type(IDMXRenderer).interfaceId));
        assertTrue(renderer.supportsInterface(0x01ffc9a7));
        assertFalse(renderer.supportsInterface(0xffffffff));
    }
}

contract DMXOffchainRendererIntegrationTest is DMXTestSupport {
    function testSwapPreservesExistingClaimsAndEmitsRefreshEvents() public {
        _claim(ALICE, 1);
        DMXOffchainRenderer next = new DMXOffchainRenderer();
        vm.recordLogs();
        token.setRenderer(address(next));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        assertEq(logs[0].topics[0], keccak256("RendererUpdated(address,address)"));
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(address(renderer)))));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(address(next)))));
        assertEq(logs[1].topics[0], keccak256("BatchMetadataUpdate(uint256,uint256)"));
        (uint256 first, uint256 last) = abi.decode(logs[1].data, (uint256, uint256));
        assertEq(first, 1);
        assertEq(last, 2_000_775);
        assertEq(logs[2].topics[0], keccak256("ContractURIUpdated()"));
        assertEq(token.ownerOf(1), ALICE);
        assertEq(token.ownerOf(1_000_000), ALICE);
        assertEq(token.tokenURI(1), "https://cdn.mons.shop/dmx/1.json");
        assertEq(token.tokenURI(1_000_000), "https://cdn.mons.shop/dmx/1000000.json");
        assertEq(token.contractURI(), "https://cdn.mons.shop/dmx/collection.json");
        _claim(BOB, 777);
        assertEq(token.tokenURI(777), "https://cdn.mons.shop/dmx/777.json");
        assertEq(token.tokenURI(1_000_776), "https://cdn.mons.shop/dmx/1000776.json");
    }

    function testCollectionStillRejectsUnissuedAndBurnedTokens() public {
        token.setRenderer(address(new DMXOffchainRenderer()));
        vm.expectRevert();
        token.tokenURI(0);
        vm.expectRevert();
        token.tokenURI(1);
        vm.expectRevert();
        token.tokenURI(1_000_000);
        _claim(ALICE, 1);
        token.setRedemptionsPaused(false);
        _redeem(_one(1), _one(778), _quote(ALICE, BOB, 7, 0, 0));
        vm.expectRevert();
        token.tokenURI(1);
        assertEq(token.tokenURI(778), "https://cdn.mons.shop/dmx/778.json");
        assertEq(token.tokenURI(1_000_777), "https://cdn.mons.shop/dmx/1000777.json");
        assertEq(token.tokenURI(1_000_000), "https://cdn.mons.shop/dmx/1000000.json");
        assertEq(token.generation(778), 1);
        assertEq(token.createdByOrder(778), 7);
        assertEq(token.redeemedByOrder(1), 7);
        assertEq(token.ownerOf(1_000_000), ALICE);
        assertEq(token.ownerOf(1_000_777), BOB);
    }

    function testMaximumFutureCardAndItsRedemptionReceiptKeepExactUrls() public {
        token.setRenderer(address(new DMXOffchainRenderer()));
        token.mintTo(ALICE, _one(999_999));
        assertEq(token.tokenURI(999_999), "https://cdn.mons.shop/dmx/999999.json");
        token.setRedemptionsPaused(false);
        _redeem(_one(999_999), new uint256[](0), _quote(ALICE, BOB, type(uint256).max, 0, 0));
        assertEq(token.tokenURI(2_000_775), "https://cdn.mons.shop/dmx/2000775.json");
        assertEq(token.redeemedByOrder(999_999), type(uint256).max);
        vm.expectRevert();
        token.tokenURI(999_999);
    }
}
