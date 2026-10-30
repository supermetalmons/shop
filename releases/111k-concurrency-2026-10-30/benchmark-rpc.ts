import { createServer } from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';
import { decodeReturn, encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../shared/ethereum/abi.ts';
import { ethereumHexQuantity, ETHEREUM_FUNCTIONS } from '../../shared/ethereum/protocol.ts';

const { count, profile, isolation } = workerData as { count: number; profile: string; isolation: string };
const CONTRACT = `0x${'11'.repeat(20)}`, WALLET = `0x${'22'.repeat(20)}`, ZERO = `0x${'00'.repeat(20)}`;
const BASE_URI = 'https://cdn.mons.shop/111k-sepolia/', HEAD = 1000;
const word = (value: number | string) => encodeAbi(['uint256'], [value]);
const address = (value: string) => encodeAbi(['address'], [value]);
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const blockHash = (number: number) => hash(1_000_000 + number);
const sleep = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));

function stableNumber(value: string): number {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

function fixture(index: number) {
  const transactionHash = hash(index + 1), crate = 111112 + index, first = index * 20 + 1;
  const log = (topics: string[], data: string, logIndex: number) => ({ address: CONTRACT, topics, data,
    blockNumber: ethereumHexQuantity(HEAD), blockHash: blockHash(HEAD), transactionHash,
    logIndex: ethereumHexQuantity(logIndex), removed: false });
  const logs = [log([ETHEREUM_EVENT_TOPICS.Transfer, address(WALLET), address(ZERO), word(crate)], '0x', index * 22),
    ...Array.from({ length: 20 }, (_, token) => log([ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(WALLET), word(first + token)], '0x', index * 22 + token + 1)),
    log([ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(crate), address(WALLET)], encodeAbi(['uint256', 'uint256'], [first, 20]), index * 22 + 21)];
  return { transactionHash, blockNumber: ethereumHexQuantity(HEAD), blockHash: blockHash(HEAD), status: '0x1', from: WALLET, to: CONTRACT, logs };
}

class HeaderSlots {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Array<() => void>>();
  peak = 0;
  waitingPeak = 0;
  private running = 0;
  private waiting = 0;
  async enter(key: string): Promise<() => void> {
    if ((this.active.get(key) ?? 0) >= 6) {
      this.waiting++;
      this.waitingPeak = Math.max(this.waitingPeak, this.waiting);
      await new Promise<void>(done => { const queue = this.queues.get(key) ?? []; queue.push(done); this.queues.set(key, queue); });
      this.waiting--;
    } else this.active.set(key, (this.active.get(key) ?? 0) + 1);
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    return () => {
      this.running--;
      const next = this.queues.get(key)?.shift();
      if (next) next();
      else this.active.set(key, (this.active.get(key) ?? 0) - 1);
    };
  }
}

const receipts = new Map(Array.from({ length: count }, (_, index) => { const receipt = fixture(index); return [receipt.transactionHash, receipt] as const; }));
const slots = new HeaderSlots();
let measuring = false, startedAtMs = 0, rpcActive = 0, rpcPeak = 0, throttleCount = 0;
const calls: Array<{ method: string; elapsedMs: number; delayMs: number; queuedMs: number; status: number; context: string }> = [];
const attempts = new Map<string, number>();
const errors: string[] = [];
const provider = createServer(async (request, response) => {
  let release: (() => void) | undefined, method = 'unparsed', delay = 0, status = 200, context = 'coordinator';
  const received = performance.now();
  let entered = received;
  const recorded = measuring;
  try {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    method = input.method;
    const params = input.params;
    context = String(request.headers['x-reveal-benchmark-context'] ?? 'coordinator');
    if (recorded) {
      release = await slots.enter(isolation === 'coordinator' ? 'coordinator' : context);
      entered = performance.now();
      rpcActive++; rpcPeak = Math.max(rpcPeak, rpcActive);
      const percentile = stableNumber(`${context}:${method}:${JSON.stringify(params)}`) % 100;
      delay = profile === 'slow' ? percentile < 90 ? 250 : percentile < 99 ? 1_000 : 5_000
        : percentile < 90 ? 100 : percentile < 99 ? 300 : 1_000;
      await sleep(delay);
    }
    const attemptKey = `${context}:${method}:${JSON.stringify(params)}`;
    const attempt = (attempts.get(attemptKey) ?? 0) + 1;
    if (recorded) attempts.set(attemptKey, attempt);
    if (recorded && profile === 'throttle' && method === 'eth_getTransactionReceipt' && attempt === 1 && stableNumber(context) % 5 === 0) {
      status = 429; throttleCount++;
      response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: 429, message: 'Fixture account throughput limit' } }));
      return;
    }
    const pending = profile === 'pending' && measuring && Date.now() - startedAtMs < 3_000;
    let result: unknown;
    if (method === 'eth_chainId') result = '0x7a69';
    else if (method === 'eth_blockNumber') result = ethereumHexQuantity(HEAD);
    else if (method === 'eth_getCode') result = (params[1] as { blockHash: string }).blockHash === blockHash(99) ? '0x' : '0x60006000';
    else if (method === 'eth_getTransactionReceipt') result = pending ? null : receipts.get(String(params[0])) ?? null;
    else if (method === 'eth_getTransactionByHash') {
      const index = Number(BigInt(String(params[0]))) - 1;
      result = receipts.has(String(params[0])) ? { hash: params[0], from: WALLET, to: CONTRACT, value: '0x0', blockNumber: null,
        input: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111112 + index]) } : null;
    } else if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'latest' ? HEAD : Number(BigInt(String(params[0])));
      result = { number: ethereumHexQuantity(number), hash: blockHash(number) };
    } else if (method === 'eth_call') {
      const data = String((params[0] as { data: string }).data);
      if (data.slice(0, 10) === encodeCall('baseURI()', [], [])) result = encodeAbi(['string'], [BASE_URI]);
      else if (data.slice(0, 10) === encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, [], [])) {
        const [ids] = decodeReturn(['uint256[]'], `0x${data.slice(10)}`) as [bigint[]];
        result = encodeAbi(['(uint8,uint256,address)[]'], [ids.map(id => [2, id - 111111n, WALLET])]);
      } else if (data.slice(0, 10) === encodeCall(ETHEREUM_FUNCTIONS.stats, [], [])) {
        result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256'],
          [5555, 0, pending ? 0 : count * 20, 1, 1, true, word(0), 1, 1, 0]);
      } else throw new Error(`Unexpected contract call ${data.slice(0, 10)}`);
    } else if (method === 'eth_getLogs') {
      const filter = params[0] as { fromBlock: string; toBlock: string; topics: Array<string | string[] | null> };
      result = pending ? [] : [...receipts.values()].flatMap(receipt => receipt.logs).filter(log =>
        BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock) &&
        filter.topics.every((topic, index) => topic === null || (Array.isArray(topic) ? topic.includes(log.topics[index]) : topic === log.topics[index])));
    } else throw new Error(`Unexpected RPC ${method}`);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  } catch (error) {
    errors.push(String(error)); status = 500;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: String(error) } }));
  } finally {
    release?.();
    if (recorded) { rpcActive--; calls.push({ method, elapsedMs: performance.now() - received, delayMs: delay, queuedMs: entered - received, status, context }); }
  }
});

await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
const providerAddress = provider.address();
if (!providerAddress || typeof providerAddress !== 'object') throw new Error('Provider failed to bind.');
parentPort!.postMessage({ port: providerAddress.port });
parentPort!.on('message', (message: { operation: 'start' | 'snapshot'; startedAtMs?: number }) => {
  if (message.operation === 'start') { measuring = true; startedAtMs = message.startedAtMs!; parentPort!.postMessage({ ready: true }); }
  else parentPort!.postMessage({ calls, rpcPeak, headerSlotPeak: slots.peak, headerQueuePeak: slots.waitingPeak, throttleCount, errors });
});
