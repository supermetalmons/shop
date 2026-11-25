import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { encodeAbi } from './abi.ts';
import { requireEthereumAddress, type Hex } from './protocol.ts';
import { dmxRedemptionReceiptTokenId, type DMXMintQuote, type DMXRedemptionQuote } from './dmx.ts';

function hash(bytes: Uint8Array): Hex { return `0x${bytesToHex(keccak_256(bytes))}`; }
function textHash(text: string): Hex { return hash(utf8ToBytes(text)); }

type Domain = { chainId: number; contractAddress: string };

function typedDigest(args: Domain, structHash: Hex): Hex {
  const domain = hash(hexToBytes(encodeAbi(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
    textHash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    textHash('divination machina x'), textHash('1'), args.chainId, requireEthereumAddress(args.contractAddress),
  ]).slice(2)));
  return hash(concatBytes(Uint8Array.of(0x19, 0x01), hexToBytes(domain.slice(2)), hexToBytes(structHash.slice(2))));
}

function structHash(types: string[], values: unknown[]): Hex {
  return hash(hexToBytes(encodeAbi(types, values).slice(2)));
}

export function tarotClaimDigest(args: Domain & {
  wallet: string; tokenId: number | bigint; deadline: number | bigint;
}): Hex {
  return typedDigest(args, structHash(['bytes32', 'address', 'uint256', 'uint256'], [
    textHash('TarotClaim(address wallet,uint256 tokenId,uint256 deadline)'),
    requireEthereumAddress(args.wallet), args.tokenId, args.deadline,
  ]));
}

export function dmxMintDigest(args: Domain & DMXMintQuote & { cardIds: readonly (number | bigint)[] }): Hex {
  return typedDigest(args, structHash(['bytes32', 'address', 'bytes32', 'bytes32', 'uint256'], [
    textHash('DMXMint(address recipient,bytes32 cardIdsHash,bytes32 authorizationId,uint256 deadline)'),
    requireEthereumAddress(args.recipient), structHash(['uint256[]'], [args.cardIds]), args.authorizationId, args.deadline,
  ]));
}

export function dmxRedemptionDigest(args: Domain & DMXRedemptionQuote & {
  inputCardIds: readonly (number | bigint)[]; outputCardIds: readonly (number | bigint)[];
}): Hex {
  return typedDigest(args, structHash(
    ['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256'], [
      textHash('DMXRedemption(address wallet,address recipient,bytes32 inputIdsHash,bytes32 outputIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline,uint256 configId)'),
      requireEthereumAddress(args.wallet), requireEthereumAddress(args.recipient),
      structHash(['uint256[]'], [args.inputCardIds]), structHash(['uint256[]'], [args.outputCardIds]),
      structHash(['uint256[]'], [args.inputCardIds.map(dmxRedemptionReceiptTokenId)]),
      args.orderId, args.fee, args.deadline, args.configId,
    ]));
}

export const TAROT_CLAIMED_TOPIC = textHash('TarotClaimed(address,uint256,uint256)');
