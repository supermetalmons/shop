import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { encodeAbi } from './abi.ts';
import { requireEthereumAddress, type Hex } from './protocol.ts';

function keccakHex(value: Uint8Array | Hex): Hex {
  return `0x${bytesToHex(keccak_256(typeof value === 'string' ? hexToBytes(value.slice(2)) : value))}`;
}

export function checksumEthereumAddress(value: string): Hex {
  const plain = requireEthereumAddress(value).slice(2);
  const checksum = bytesToHex(keccak_256(utf8ToBytes(plain)));
  return `0x${Array.from(plain, (char, index) => Number.parseInt(checksum[index], 16) >= 8 ? char.toUpperCase() : char).join('')}`;
}

export function personalMessageHash(message: string): Hex {
  const body = utf8ToBytes(message);
  return keccakHex(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), body));
}

export function recoverEthereumAddress(digest: string, signature: string): Hex | null {
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(digest) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
    const raw = hexToBytes(signature.slice(2));
    const recovery = raw[64] >= 27 ? raw[64] - 27 : raw[64];
    if (recovery !== 0 && recovery !== 1) return null;
    const recovered = secp256k1.Signature.fromCompact(raw.subarray(0, 64)).addRecoveryBit(recovery);
    if (recovered.hasHighS()) return null;
    const publicKey = recovered.recoverPublicKey(hexToBytes(digest.slice(2))).toRawBytes(false);
    return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
  } catch { return null; }
}

export function signDigest(privateKey: string, digest: string): Hex {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey) || !/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error('Invalid Ethereum signing input');
  const signed = secp256k1.sign(hexToBytes(digest.slice(2)), hexToBytes(privateKey.replace(/^0x/, '')), { lowS: true });
  return `0x${bytesToHex(signed.toCompactRawBytes())}${(signed.recovery + 27).toString(16)}`;
}

export function ethereumSignerAddress(privateKey: string): Hex {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Invalid Ethereum signing key');
  const publicKey = secp256k1.getPublicKey(hexToBytes(privateKey.replace(/^0x/, '')), false);
  return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

function hashText(value: string): Hex { return keccakHex(utf8ToBytes(value)); }

function typedDigest(chainId: number, contractAddress: string, structHash: Hex): Hex {
  const domain = keccakHex(encodeAbi(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
    hashText('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    hashText('111K'), hashText('2'), chainId, requireEthereumAddress(contractAddress),
  ]));
  return keccakHex(concatBytes(Uint8Array.of(0x19, 0x01), hexToBytes(domain.slice(2)), hexToBytes(structHash.slice(2))));
}

export function ethereumTokenIdsHash(tokenIds: readonly (string | bigint | number)[]): Hex {
  return keccakHex(encodeAbi(['uint256[]'], [tokenIds]));
}

export function ethereumReceiptIdsHash(receiptIds: readonly (string | bigint | number)[]): Hex {
  return ethereumTokenIdsHash(receiptIds);
}

export function deliveryDigest(args: {
  chainId: number; contractAddress: string; wallet: string; tokenIds: readonly (string | bigint | number)[];
  orderId: number | bigint | string; fee: string | bigint; deadline: number | bigint; receiptIdsHash: string;
}): Hex {
  const idsHash = ethereumTokenIdsHash(args.tokenIds);
  const structHash = keccakHex(encodeAbi(['bytes32', 'address', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256'], [
    hashText('Delivery(address wallet,bytes32 tokenIdsHash,bytes32 receiptIdsHash,uint256 orderId,uint256 fee,uint256 deadline)'),
    requireEthereumAddress(args.wallet), idsHash, args.receiptIdsHash, args.orderId, args.fee, args.deadline,
  ]));
  return typedDigest(args.chainId, args.contractAddress, structHash);
}

export function crateClaimDigest(args: {
  chainId: number; contractAddress: string; wallet: string; receiptId: string | bigint | number;
  claimId: string; deadline: number | bigint;
}): Hex {
  const structHash = keccakHex(encodeAbi(['bytes32', 'address', 'uint256', 'bytes32', 'uint256'], [
    hashText('CrateClaim(address wallet,uint256 receiptId,bytes32 claimId,uint256 deadline)'),
    requireEthereumAddress(args.wallet), args.receiptId, args.claimId, args.deadline,
  ]));
  return typedDigest(args.chainId, args.contractAddress, structHash);
}
