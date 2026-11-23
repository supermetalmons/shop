import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { encodeAbi } from './abi.ts';
import { requireEthereumAddress, type Hex } from './protocol.ts';

function hash(bytes: Uint8Array): Hex { return `0x${bytesToHex(keccak_256(bytes))}`; }
function textHash(text: string): Hex { return hash(utf8ToBytes(text)); }

export function tarotClaimDigest(args: {
  chainId: number; contractAddress: string; wallet: string; tokenId: number | bigint; deadline: number | bigint;
}): Hex {
  const domain = hash(hexToBytes(encodeAbi(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
    textHash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    textHash('Tarot Cards'), textHash('1'), args.chainId, requireEthereumAddress(args.contractAddress),
  ]).slice(2)));
  const claim = hash(hexToBytes(encodeAbi(['bytes32', 'address', 'uint256', 'uint256'], [
    textHash('TarotClaim(address wallet,uint256 tokenId,uint256 deadline)'),
    requireEthereumAddress(args.wallet), args.tokenId, args.deadline,
  ]).slice(2)));
  return hash(concatBytes(Uint8Array.of(0x19, 0x01), hexToBytes(domain.slice(2)), hexToBytes(claim.slice(2))));
}

export const TAROT_CLAIMED_TOPIC = textHash('TarotClaimed(address,uint256,uint256)');
