pragma solidity 0.8.38;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Pre111K} from "../src/Pre111K.sol";
import {TestSupport} from "./TestSupport.sol";

contract Pre111KFixturesTest is TestSupport {
    using Strings for uint256;

    uint256 private constant KEY = 0xA11CE;
    address private constant VERIFYING_CONTRACT = 0x1111111111111111111111111111111111111111;
    address private constant WALLET = 0x2222222222222222222222222222222222222222;
    uint256 private constant NONCE = 3;
    uint256 private constant DEADLINE = 2_000_000_600;

    function testExportPre111KAuthorizationFixture() public {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("pre111k"),
                keccak256("1"),
                uint256(11155111),
                VERIFYING_CONTRACT
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ReserveRelic(address wallet,uint256 nonce,uint256 deadline)"), WALLET, NONCE, DEADLINE
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        string memory output = string.concat(
            '{"testPrivateKey":"', KEY.toHexString(32), '","signer":"', Strings.toHexString(vm.addr(KEY))
        );
        output = string.concat(
            output,
            '","chainId":11155111,"verifyingContract":"',
            Strings.toHexString(VERIFYING_CONTRACT),
            '","wallet":"',
            Strings.toHexString(WALLET),
            '","nonce":"3","deadline":2000000600,"domainName":"pre111k","domainVersion":"1"'
        );
        output = string.concat(
            output,
            ',"domainSeparator":"',
            uint256(domain).toHexString(32),
            '","structHash":"',
            uint256(structHash).toHexString(32),
            '","digest":"',
            uint256(digest).toHexString(32)
        );
        output = string.concat(
            output,
            '","signature":"',
            _hex(signature),
            '","calldata":"',
            _hex(abi.encodeCall(Pre111K.reserveRelic, (NONCE, DEADLINE, signature))),
            '"}\n'
        );
        vm.writeFile("fixtures/pre111k.json", output);
    }

    function _hex(bytes memory data) private pure returns (string memory) {
        bytes memory output = new bytes(data.length * 2 + 2);
        bytes16 digits = "0123456789abcdef";
        output[0] = "0";
        output[1] = "x";
        for (uint256 i; i < data.length; ++i) {
            output[i * 2 + 2] = digits[uint8(data[i]) >> 4];
            output[i * 2 + 3] = digits[uint8(data[i]) & 15];
        }
        return string(output);
    }
}
