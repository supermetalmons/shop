import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";

const PROGRAM_ID = "C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A";
const CONFIG_PDA = "2bYowarQZyoBjHmu1fzHDnWUfQRctLL4YHr7yhYjnVQq";
const ADMIN = "kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx";
const COLLECTION = "JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH";
const GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const CONFIG_DISCRIMINATOR = Buffer.from([62, 29, 116, 188, 219, 247, 48, 227]);
const heliusApiKey = process.env.HELIUS_API_KEY;

if (!heliusApiKey)
  throw new Error("HELIUS_API_KEY is required for the finalized DAS inventory");
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`;
const outputFlag = process.argv.indexOf("--out");
const requestedOutput = outputFlag >= 0 ? process.argv[outputFlag + 1] : null;
if (outputFlag >= 0 && !requestedOutput)
  throw new Error("--out requires a directory");

let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function accountData(response, address) {
  if (!response?.value) throw new Error(`Missing account ${address}`);
  return Buffer.from(response.value.data[0], "base64");
}

function decodeConfig(data) {
  if (data.length !== 307)
    throw new Error(`Config length is ${data.length}, expected 307`);
  if (!data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR))
    throw new Error("Config discriminator mismatch");
  let offset = 8;
  const pubkey = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };
  const u64 = () => {
    const value = data.readBigUInt64LE(offset).toString();
    offset += 8;
    return value;
  };
  const string = () => {
    const length = data.readUInt32LE(offset);
    offset += 4;
    const value = data.subarray(offset, offset + length).toString("utf8");
    offset += length;
    return value;
  };
  const decoded = {
    admin: pubkey(),
    treasury: pubkey(),
    coreCollection: pubkey(),
    priceLamports: u64(),
    discountPriceLamports: u64(),
    discountMerkleRoot: data.subarray(offset, offset + 32).toString("hex"),
  };
  offset += 32;
  Object.assign(decoded, {
    maxSupply: data.readUInt32LE(offset),
    maxPerTx: data[offset + 4],
    itemsPerBox: data[offset + 5],
    minted: data.readUInt32LE(offset + 6),
  });
  offset += 10;
  const namePrefix = string();
  const symbol = string();
  const uriBase = string();
  const started = data[offset] === 1;
  const bump = data[offset + 1];
  const discountMintsPerWallet = data[offset + 2];
  offset += 3;
  const figureNamePrefix = string();
  Object.assign(decoded, {
    namePrefix,
    symbol,
    uriBase,
    started,
    bump,
    discountMintsPerWallet,
    figureNamePrefix,
  });
  return decoded;
}

function compactAsset(asset) {
  return {
    id: asset.id,
    interface: asset.interface ?? null,
    jsonUri: asset.content?.json_uri ?? null,
    name: asset.content?.metadata?.name ?? null,
    grouping: asset.grouping ?? [],
    compressed: asset.compression?.compressed ?? false,
    compressionTree: asset.compression?.tree ?? null,
    burnt: asset.burnt ?? false,
    owner: asset.ownership?.owner ?? null,
  };
}

const genesisHash = await rpc("getGenesisHash");
if (genesisHash !== GENESIS_HASH)
  throw new Error(`Unexpected genesis hash ${genesisHash}`);

const [
  programResponse,
  configResponse,
  adminBalance,
  programBalance,
  configBalance,
] = await Promise.all([
  rpc("getAccountInfo", [
    PROGRAM_ID,
    { encoding: "base64", commitment: "finalized" },
  ]),
  rpc("getAccountInfo", [
    CONFIG_PDA,
    { encoding: "base64", commitment: "finalized" },
  ]),
  rpc("getBalance", [ADMIN, { commitment: "finalized" }]),
  rpc("getBalance", [PROGRAM_ID, { commitment: "finalized" }]),
  rpc("getBalance", [CONFIG_PDA, { commitment: "finalized" }]),
]);
const programData = accountData(programResponse, PROGRAM_ID);
const configData = accountData(configResponse, CONFIG_PDA);
if (
  programResponse.value.owner !== LOADER ||
  !programResponse.value.executable
) {
  throw new Error("Program owner or executable state mismatch");
}
if (programData.readUInt32LE(0) !== 2)
  throw new Error("Program account is not upgradeable-loader Program state");
const programDataAddress = new PublicKey(
  programData.subarray(4, 36),
).toBase58();
const programDataResponse = await rpc("getAccountInfo", [
  programDataAddress,
  { encoding: "base64", commitment: "finalized" },
]);
const rawProgramData = accountData(programDataResponse, programDataAddress);
if (
  programDataResponse.value.owner !== LOADER ||
  rawProgramData.readUInt32LE(0) !== 3
) {
  throw new Error("ProgramData account state mismatch");
}
const deploymentSlot = Number(rawProgramData.readBigUInt64LE(4));
const authority =
  rawProgramData[12] === 1
    ? new PublicKey(rawProgramData.subarray(13, 45)).toBase58()
    : null;
const elf = rawProgramData.subarray(45);
const decodedConfig = decodeConfig(configData);
if (decodedConfig.admin !== ADMIN)
  throw new Error(`Unexpected config admin ${decodedConfig.admin}`);
if (configResponse.value.owner !== PROGRAM_ID)
  throw new Error(`Unexpected config owner ${configResponse.value.owner}`);

const assets = [];
for (let page = 1; ; page += 1) {
  const result = await rpc("searchAssets", {
    grouping: ["collection", COLLECTION],
    page,
    limit: 1000,
    options: { showUnverifiedCollections: true, showCollectionMetadata: true },
  });
  assets.push(...result.items);
  if (assets.length >= result.total || result.items.length === 0) break;
}
const collectionAsset = await rpc("getAsset", { id: COLLECTION });
const inventory = {
  commitment: "finalized",
  collection: compactAsset(collectionAsset),
  total: assets.length,
  assets: assets
    .map(compactAsset)
    .sort((left, right) => left.id.localeCompare(right.id)),
};

const timestamp = new Date().toISOString();
const outputDirectory = resolve(
  requestedOutput ||
    `.cache/poncho-mainnet-archive/${deploymentSlot}-${timestamp.replaceAll(":", "-")}`,
);
await mkdir(outputDirectory, { recursive: true });
const snapshot = {
  capturedAt: timestamp,
  commitment: "finalized",
  genesisHash,
  program: {
    address: PROGRAM_ID,
    owner: programResponse.value.owner,
    executable: programResponse.value.executable,
    lamports: programBalance.value,
    programDataAddress,
    deploymentSlot,
    upgradeAuthority: authority,
    elfBytes: elf.length,
    elfSha256: sha256(elf),
    rawProgramDataBytes: rawProgramData.length,
    rawProgramDataSha256: sha256(rawProgramData),
  },
  config: {
    address: CONFIG_PDA,
    owner: configResponse.value.owner,
    lamports: configBalance.value,
    bytes: configData.length,
    sha256: sha256(configData),
    decoded: decodedConfig,
  },
  admin: { address: ADMIN, lamports: adminBalance.value },
  dasInventory: {
    collection: COLLECTION,
    assets: assets.length,
    file: "das-uri-inventory.json",
  },
};

await Promise.all([
  writeFile(`${outputDirectory}/programdata.bin`, rawProgramData),
  writeFile(`${outputDirectory}/program.so`, elf),
  writeFile(`${outputDirectory}/config.bin`, configData),
  writeFile(
    `${outputDirectory}/snapshot.json`,
    `${JSON.stringify(snapshot, null, 2)}\n`,
  ),
  writeFile(
    `${outputDirectory}/das-uri-inventory.json`,
    `${JSON.stringify(inventory, null, 2)}\n`,
  ),
]);
process.stdout.write(
  `${JSON.stringify({ outputDirectory, ...snapshot }, null, 2)}\n`,
);
