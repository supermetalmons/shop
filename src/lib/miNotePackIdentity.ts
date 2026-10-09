import { PublicKey, type Connection } from '@solana/web3.js';
import type { FrontendDeploymentConfig } from '../config/deployment';
import { boxIdFromMetadataUri } from '../../shared/dropMetadataUri';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../shared/solanaProgramAddresses';

export async function fetchMiNotePackId(
  connection: Pick<Connection, 'getAccountInfo'>,
  drop: FrontendDeploymentConfig,
  assetId: string,
): Promise<string | undefined> {
  const account = await connection.getAccountInfo(new PublicKey(assetId), 'confirmed');
  if (!account || account.owner.toBase58() !== MPL_CORE_PROGRAM_ADDRESS) return undefined;
  const data = account.data;
  // AssetV1 stores key, owner, collection authority, then Borsh name and URI.
  if (data.length < 74 || data[0] !== 1 || data[33] !== 2) return undefined;
  if (new PublicKey(data.subarray(34, 66)).toBase58() !== drop.collectionMint) return undefined;
  const nameLength = data.readUInt32LE(66);
  const uriLengthOffset = 70 + nameLength;
  if (nameLength > 128 || uriLengthOffset + 4 > data.length) return undefined;
  const uriStart = uriLengthOffset + 4;
  const uriLength = data.readUInt32LE(uriLengthOffset);
  const uriEnd = uriStart + uriLength;
  if (uriLength > 256 || uriEnd > data.length) return undefined;
  const uri = data.subarray(uriStart, uriEnd).toString('utf8');
  const boxId = boxIdFromMetadataUri(uri);
  const id = Number(boxId);
  return Number.isSafeInteger(id) && id >= 1 && id <= drop.maxSupply && uri === `${drop.paths.boxesJsonBase}${id}.json`
    ? String(id)
    : undefined;
}
