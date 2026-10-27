pragma solidity 0.8.30;

import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport} from "./TestSupport.sol";

interface SeaportForkVm {
    function activeFork() external view returns (uint256);
    function skip(bool skipTest) external;
}

interface SeaportV16 {
    enum ItemType {
        NATIVE,
        ERC20,
        ERC721,
        ERC1155,
        ERC721_WITH_CRITERIA,
        ERC1155_WITH_CRITERIA
    }

    enum OrderType {
        FULL_OPEN,
        PARTIAL_OPEN,
        FULL_RESTRICTED,
        PARTIAL_RESTRICTED,
        CONTRACT
    }

    struct OfferItem {
        ItemType itemType;
        address token;
        uint256 identifierOrCriteria;
        uint256 startAmount;
        uint256 endAmount;
    }

    struct ConsiderationItem {
        ItemType itemType;
        address token;
        uint256 identifierOrCriteria;
        uint256 startAmount;
        uint256 endAmount;
        address payable recipient;
    }

    struct OrderParameters {
        address offerer;
        address zone;
        OfferItem[] offer;
        ConsiderationItem[] consideration;
        OrderType orderType;
        uint256 startTime;
        uint256 endTime;
        bytes32 zoneHash;
        uint256 salt;
        bytes32 conduitKey;
        uint256 totalOriginalConsiderationItems;
    }

    struct OrderComponents {
        address offerer;
        address zone;
        OfferItem[] offer;
        ConsiderationItem[] consideration;
        OrderType orderType;
        uint256 startTime;
        uint256 endTime;
        bytes32 zoneHash;
        uint256 salt;
        bytes32 conduitKey;
        uint256 counter;
    }

    struct Order {
        OrderParameters parameters;
        bytes signature;
    }

    error InvalidSigner();

    function name() external view returns (string memory);
    function information() external view returns (string memory, bytes32, address);
    function getCounter(address offerer) external view returns (uint256);
    function getOrderHash(OrderComponents calldata order) external view returns (bytes32);
    function fulfillOrder(Order calldata order, bytes32 fulfillerConduitKey) external payable returns (bool);
}

contract NFT111KSeaportForkTest is TestSupport {
    SeaportV16 internal constant SEAPORT = SeaportV16(0x0000000000000068F116a894984e2DB1123eB395);
    uint256 internal constant SELLER_KEY = uint256(keccak256("111K.SeaportForkTest.seller"));
    uint256 internal constant BUYER_KEY = uint256(keccak256("111K.SeaportForkTest.buyer"));
    uint256 internal constant TOKEN_ID = 111112;
    uint256 internal constant PRICE = 0.01 ether;

    NFT111K internal token;
    address internal seller;
    address internal buyer;

    modifier onSeaportFork() {
        try SeaportForkVm(address(vm)).activeFork() returns (uint256) {}
        catch {
            SeaportForkVm(address(vm)).skip(true);
        }
        require(block.chainid == 1 || block.chainid == 11155111, "unsupported fork chain");
        require(address(SEAPORT).code.length > 0, "Seaport missing on fork");
        (string memory version,,) = SEAPORT.information();
        assertEq(version, "1.6");
        assertEq(SEAPORT.name(), "Seaport");
        seller = vm.addr(SELLER_KEY);
        buyer = vm.addr(BUYER_KEY);
        require(seller.code.length == 0 && buyer.code.length == 0, "fork wallets must be EOAs");
        vm.deal(seller, 1 ether);
        vm.deal(buyer, 1 ether);
        token = new NFT111K(
            address(this),
            vm.addr(0x5151),
            payable(address(0xBEEF)),
            "https://cdn.mons.shop/111k-sepolia/",
            bytes32(0),
            _proceedsRecipients(),
            _proceedsSharesBps()
        );
        vm.prank(seller);
        token.mintCrates{value: 0.0001 ether}(1);
        _;
    }

    function testForkSeaportFillsSignedOrderWithoutApprovalTransaction() public onSeaportFork {
        assertTrue(token.isApprovedForAll(seller, address(SEAPORT)));
        assertEq(token.getApproved(TOKEN_ID), address(0));
        SeaportV16.Order memory order = _signedOrder(SELLER_KEY);
        _fulfillAndCheck(order);
    }

    function testForkSeaportRejectsAnotherWalletsSignature() public onSeaportFork {
        SeaportV16.Order memory order = _signedOrder(BUYER_KEY);
        vm.prank(buyer);
        vm.expectRevert(SeaportV16.InvalidSigner.selector);
        SEAPORT.fulfillOrder{value: PRICE}(order, bytes32(0));
        assertEq(token.ownerOf(TOKEN_ID), seller);
        _fulfillAndCheck(_signedOrder(SELLER_KEY));
    }

    function testForkSeaportHonorsRevocationAndRestoredApproval() public onSeaportFork {
        SeaportV16.Order memory order = _signedOrder(SELLER_KEY);
        vm.prank(seller);
        token.setApprovalForAll(address(SEAPORT), false);
        assertFalse(token.isApprovedForAll(seller, address(SEAPORT)));
        vm.prank(buyer);
        vm.expectRevert();
        SEAPORT.fulfillOrder{value: PRICE}(order, bytes32(0));
        assertEq(token.ownerOf(TOKEN_ID), seller);
        vm.prank(seller);
        token.setApprovalForAll(address(SEAPORT), true);
        _fulfillAndCheck(order);
    }

    function _fulfillAndCheck(SeaportV16.Order memory order) internal {
        uint256 sellerBalance = seller.balance;
        uint256 buyerBalance = buyer.balance;
        vm.prank(buyer);
        assertTrue(SEAPORT.fulfillOrder{value: PRICE}(order, bytes32(0)));
        assertEq(token.ownerOf(TOKEN_ID), buyer);
        assertEq(seller.balance, sellerBalance + PRICE);
        assertEq(buyer.balance, buyerBalance - PRICE);
    }

    function _signedOrder(uint256 signingKey) internal returns (SeaportV16.Order memory order) {
        SeaportV16.OfferItem[] memory offer = new SeaportV16.OfferItem[](1);
        offer[0] = SeaportV16.OfferItem(SeaportV16.ItemType.ERC721, address(token), TOKEN_ID, 1, 1);
        SeaportV16.ConsiderationItem[] memory consideration = new SeaportV16.ConsiderationItem[](1);
        consideration[0] =
            SeaportV16.ConsiderationItem(SeaportV16.ItemType.NATIVE, address(0), 0, PRICE, PRICE, payable(seller));
        SeaportV16.OrderComponents memory components = SeaportV16.OrderComponents({
            offerer: seller,
            zone: address(0),
            offer: offer,
            consideration: consideration,
            orderType: SeaportV16.OrderType.FULL_OPEN,
            startTime: block.timestamp - 1,
            endTime: block.timestamp + 1 days,
            zoneHash: bytes32(0),
            salt: 111000,
            conduitKey: bytes32(0),
            counter: SEAPORT.getCounter(seller)
        });
        (, bytes32 domainSeparator,) = SEAPORT.information();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, SEAPORT.getOrderHash(components)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signingKey, digest);
        order = SeaportV16.Order({
            parameters: SeaportV16.OrderParameters({
                offerer: components.offerer,
                zone: components.zone,
                offer: components.offer,
                consideration: components.consideration,
                orderType: components.orderType,
                startTime: components.startTime,
                endTime: components.endTime,
                zoneHash: components.zoneHash,
                salt: components.salt,
                conduitKey: components.conduitKey,
                totalOriginalConsiderationItems: consideration.length
            }),
            signature: abi.encodePacked(r, s, v)
        });
    }
}
