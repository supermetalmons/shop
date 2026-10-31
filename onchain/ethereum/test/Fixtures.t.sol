pragma solidity 0.8.30;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {NFT111K} from "../src/NFT111K.sol";
import {TestSupport} from "./TestSupport.sol";

contract FixturesTest is TestSupport {
    using Strings for uint256;

    struct AuthorizationFixture {
        uint256[] ids;
        uint256[] receiptIds;
        NFT111K.DeliveryQuote quote;
        bytes32 domain;
        bytes32 deliveryHash;
        bytes32 deliveryDigest;
        bytes deliverySignature;
        bytes32 claimId;
        bytes32 claimHash;
        bytes32 claimDigest;
        bytes claimSignature;
    }

    uint256 private constant KEY = 0xA11CE;
    address private constant VERIFYING_CONTRACT = address(0x1111111111111111111111111111111111111111);
    address private constant WALLET = address(0x2222222222222222222222222222222222222222);

    function testExportEip712AndCalldataFixtures() public {
        AuthorizationFixture memory f;
        f.ids = new uint256[](3);
        f.ids[0] = 111112;
        f.ids[1] = 17;
        f.ids[2] = 30;
        f.receiptIds = new uint256[](3);
        f.receiptIds[0] = 2_000_001;
        f.receiptIds[1] = 1_000_017;
        f.receiptIds[2] = 1_000_030;
        f.quote = NFT111K.DeliveryQuote(42, WALLET, 0.0001 ether, 2_000_000_600, keccak256(abi.encode(f.receiptIds)));
        f.domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("111K"),
                keccak256("2"),
                uint256(31337),
                VERIFYING_CONTRACT
            )
        );
        f.deliveryHash = keccak256(
            abi.encode(
                keccak256(
                    "Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)"
                ),
                WALLET,
                keccak256(abi.encode(f.ids)),
                f.quote.receiptIdsHash,
                f.quote.orderId,
                f.quote.fee,
                f.quote.deadline
            )
        );
        f.deliveryDigest = keccak256(abi.encodePacked(hex"1901", f.domain, f.deliveryHash));
        f.deliverySignature = _signature(KEY, f.deliveryDigest);
        f.claimId = keccak256("111k-test-crate-claim");
        f.claimHash = keccak256(
            abi.encode(
                keccak256("CrateClaim(address wallet,uint256 receiptId,bytes32 claimId,uint256 deadline)"),
                WALLET,
                uint256(2_000_042),
                f.claimId,
                f.quote.deadline
            )
        );
        f.claimDigest = keccak256(abi.encodePacked(hex"1901", f.domain, f.claimHash));
        f.claimSignature = _signature(KEY, f.claimDigest);
        string memory output = string.concat(
            '{"testPrivateKey":"', KEY.toHexString(32), '","signer":"', Strings.toHexString(vm.addr(KEY))
        );
        output =
            string.concat(output, '","chainId":31337,"verifyingContract":"', Strings.toHexString(VERIFYING_CONTRACT));
        output = string.concat(
            output,
            '","wallet":"',
            Strings.toHexString(WALLET),
            '","domainName":"111K","domainVersion":"2","domainSeparator":"',
            uint256(f.domain).toHexString(32)
        );
        output = string.concat(output, '",', _deliveryJson(f), ",", _claimJson(f));
        uint256[] memory crateIds = new uint256[](3);
        crateIds[0] = 111153;
        crateIds[1] = 111112;
        crateIds[2] = 116666;
        output = string.concat(
            output,
            ',"batchUnbox":{"tokenIds":[111153,111112,116666],"artworkCount":71,"tokenIdsHash":"',
            uint256(keccak256(abi.encode(crateIds))).toHexString(32),
            '"}'
        );
        output = string.concat(output, ',"calls":{"mintCrates3":"', _hex(abi.encodeCall(NFT111K.mintCrates, (3))));
        output = string.concat(output, '","mintWarehouses2":"', _hex(abi.encodeCall(NFT111K.mintWarehouses, (2))));
        output = string.concat(output, '","mintMonuments2":"', _hex(abi.encodeCall(NFT111K.mintMonuments, (2))));
        output = string.concat(output, '","unboxMonument18":"', _hex(abi.encodeCall(NFT111K.unboxMonument, (117189))));
        output = string.concat(output, '","unboxCrate42":"', _hex(abi.encodeCall(NFT111K.unboxCrate, (111153))));
        output = string.concat(output, '","unboxWarehouse42":"', _hex(abi.encodeCall(NFT111K.unboxWarehouse, (116708))));
        output =
            string.concat(output, '","unboxCratesUnsorted":"', _hex(abi.encodeCall(NFT111K.unboxCrates, (crateIds))));
        output = string.concat(output, _batchReadCallsJson(), '"}}');
        vm.writeFile("fixtures/eip712.json", output);
    }

    function _batchReadCallsJson() private pure returns (string memory) {
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 0;
        ids[2] = 111112;
        string memory output = string.concat('","getTokenInfos":"', _hex(abi.encodeCall(NFT111K.getTokenInfos, (ids))));
        uint8[] memory kinds = new uint8[](3);
        kinds[0] = 4;
        kinds[1] = 1;
        kinds[2] = 5;
        ids[0] = 111111;
        ids[1] = 42;
        ids[2] = 5555;
        return
            string.concat(
                output, '","previewTokenURIs":"', _hex(abi.encodeCall(NFT111K.previewTokenURIs, (kinds, ids)))
            );
    }

    function _deliveryJson(AuthorizationFixture memory f) private pure returns (string memory output) {
        output =
            '"delivery":{"tokenIds":[111112,17,30],"receiptIds":[2000001,1000017,1000030],"orderId":"42","fee":"100000000000000","deadline":2000000600,';
        output = string.concat(output, '"tokenIdsHash":"', uint256(keccak256(abi.encode(f.ids))).toHexString(32));
        output = string.concat(output, '","receiptIdsHash":"', uint256(f.quote.receiptIdsHash).toHexString(32));
        output = string.concat(
            output,
            '","structHash":"',
            uint256(f.deliveryHash).toHexString(32),
            '","digest":"',
            uint256(f.deliveryDigest).toHexString(32)
        );
        output = string.concat(output, '","signature":"', _hex(f.deliverySignature));
        output = string.concat(
            output,
            '","calldata":"',
            _hex(abi.encodeCall(NFT111K.redeemForDelivery, (f.ids, f.quote, f.deliverySignature))),
            '"}'
        );
    }

    function _claimJson(AuthorizationFixture memory f) private pure returns (string memory output) {
        output = string.concat('"claim":{"receiptId":"2000042","claimId":"', uint256(f.claimId).toHexString(32));
        output = string.concat(
            output,
            '","deadline":2000000600,"structHash":"',
            uint256(f.claimHash).toHexString(32),
            '","digest":"',
            uint256(f.claimDigest).toHexString(32)
        );
        output = string.concat(output, '","signature":"', _hex(f.claimSignature));
        output = string.concat(
            output,
            '","calldata":"',
            _hex(abi.encodeCall(NFT111K.claimCrateReceipt, (2_000_042, f.claimId, f.quote.deadline, f.claimSignature))),
            '"}'
        );
    }

    function _signature(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _hex(bytes memory value) private pure returns (string memory) {
        bytes16 alphabet = "0123456789abcdef";
        bytes memory encoded = new bytes(2 + value.length * 2);
        encoded[0] = "0";
        encoded[1] = "x";
        for (uint256 i; i < value.length; ++i) {
            encoded[2 + i * 2] = alphabet[uint8(value[i]) >> 4];
            encoded[3 + i * 2] = alphabet[uint8(value[i]) & 15];
        }
        return string(encoded);
    }
}
