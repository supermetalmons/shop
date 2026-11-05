import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { encodeAbi } from './abi.ts';
import { requireEthereumAddress, type Hex } from './protocol.ts';

function hash(bytes: Uint8Array): Hex { return `0x${bytesToHex(keccak_256(bytes))}`; }
function textHash(text: string): Hex { return hash(utf8ToBytes(text)); }

export function pre111kReservationDigest(args: {
  chainId: number; contractAddress: string; wallet: string; nonce: number | bigint; deadline: number | bigint; priceWei: string;
}): Hex {
  const domain = hash(hexToBytes(encodeAbi(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
    textHash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    textHash('pre111k'), textHash('2'), args.chainId, requireEthereumAddress(args.contractAddress),
  ]).slice(2)));
  const reservation = hash(hexToBytes(encodeAbi(['bytes32', 'address', 'uint256', 'uint256', 'uint256'], [
    textHash('ReserveRelic(address wallet,uint256 nonce,uint256 deadline,uint256 priceWei)'),
    requireEthereumAddress(args.wallet), args.nonce, args.deadline, args.priceWei,
  ]).slice(2)));
  return hash(concatBytes(Uint8Array.of(0x19, 0x01), hexToBytes(domain.slice(2)), hexToBytes(reservation.slice(2))));
}

export const PRE111K_RESERVED_TOPIC = textHash('RelicReserved(address,uint256,uint256)');
