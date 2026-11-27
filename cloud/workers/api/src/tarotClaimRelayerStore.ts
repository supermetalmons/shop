import { EthereumApiError } from './ethereumError.js';
import { validateTarotClaimScope, type TarotClaimAttempt, type TarotClaimInput, type TarotClaimInspection, type TarotClaimScope,
  type TarotSignedClaim } from './tarotClaimRelayer.js';
import { TarotClaimRejected, type TarotClaimFailure, type TarotClaimRejection, type TarotClaimRejectionInput } from './tarotClaimRejection.js';

export interface TarotClaimSql {
  exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>): { toArray(): T[] };
}

type Row = Record<string, string | number | null>;
export const TAROT_SPONSORSHIP_LIMIT_MESSAGE = 'This sponsored claim failed. Connect an Ethereum wallet to try again.';

function attempt(row: Row): TarotClaimAttempt {
  return {
    id: Number(row.id), chainId: Number(row.chain_id) as 1 | 11155111, contractAddress: String(row.contract_address),
    tokenId: Number(row.token_id), requestId: String(row.request_id), recipient: String(row.recipient), codeHash: String(row.code_hash),
    state: row.state as TarotClaimAttempt['state'], createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms),
    lastBroadcastAtMs: row.last_broadcast_at_ms === null ? null : Number(row.last_broadcast_at_ms),
    lastCheckedAtMs: row.last_checked_at_ms === null ? null : Number(row.last_checked_at_ms),
    broadcastAccepted: row.broadcast_accepted === 1, error: row.error === null ? null : String(row.error),
    receiptBlockNumber: row.receipt_block_number === null ? null : Number(row.receipt_block_number),
    receiptBlockHash: row.receipt_block_hash === null ? null : String(row.receipt_block_hash),
    finalized: row.finalized === 1, revision: Number(row.revision),
    signed: row.raw_transaction === null ? null : {
      rawTransaction: String(row.raw_transaction), transactionHash: String(row.transaction_hash), nonce: String(row.nonce),
      authorizationDeadline: Number(row.authorization_deadline), maximumFeeWei: String(row.maximum_fee_wei),
      relayerAddress: String(row.relayer_address),
    },
  };
}

export class TarotClaimRelayerStore {
  constructor(private readonly sql: TarotClaimSql, private readonly atomic: <T>(action: () => T) => T) {
    this.atomic(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS relayer_account (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), chain_id INTEGER NOT NULL,
        address TEXT NOT NULL, next_nonce TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS claim_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chain_id INTEGER NOT NULL, contract_address TEXT NOT NULL,
        token_id INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE, recipient TEXT NOT NULL, code_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('submitting','pending','confirmed','failed','recovery-required')),
        raw_transaction TEXT, transaction_hash TEXT, nonce TEXT, authorization_deadline INTEGER,
        maximum_fee_wei TEXT, relayer_address TEXT, broadcast_accepted INTEGER NOT NULL DEFAULT 0,
        last_broadcast_at_ms INTEGER, last_checked_at_ms INTEGER, error TEXT,
        receipt_block_number INTEGER, receipt_block_hash TEXT, finalized INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        CHECK((raw_transaction IS NULL AND transaction_hash IS NULL AND nonce IS NULL AND authorization_deadline IS NULL
          AND maximum_fee_wei IS NULL AND relayer_address IS NULL) OR
          (raw_transaction IS NOT NULL AND transaction_hash IS NOT NULL AND nonce IS NOT NULL AND authorization_deadline IS NOT NULL
          AND maximum_fee_wei IS NOT NULL AND relayer_address IS NOT NULL)))`);
      const columns = new Set(this.sql.exec('PRAGMA table_info(claim_attempts)').toArray().map(row => row.name));
      for (const [name, definition] of [
        ['receipt_block_number', 'INTEGER'], ['receipt_block_hash', 'TEXT'],
        ['finalized', 'INTEGER NOT NULL DEFAULT 0'], ['revision', 'INTEGER NOT NULL DEFAULT 0'],
      ]) {
        if (!columns.has(name)) this.sql.exec(`ALTER TABLE claim_attempts ADD COLUMN ${name} ${definition}`);
      }
      this.sql.exec('DROP INDEX IF EXISTS claim_active_token');
      this.sql.exec("UPDATE claim_attempts SET finalized=1 WHERE raw_transaction IS NULL AND state='failed' AND finalized=0");
      this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS claim_relayer_nonce ON claim_attempts(chain_id,relayer_address,nonce)
        WHERE nonce IS NOT NULL`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS claim_attempt_scope ON claim_attempts(chain_id,contract_address,token_id,id)');
      this.sql.exec(`CREATE TABLE IF NOT EXISTS claim_rejections (
        request_id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, contract_address TEXT NOT NULL,
        token_id INTEGER NOT NULL, code_hash TEXT NOT NULL, failure TEXT NOT NULL, created_at_ms INTEGER NOT NULL)`);
    });
  }

  pinAccount(chainId: number, address: string): void {
    this.atomic(() => {
      const current = this.sql.exec('SELECT * FROM relayer_account WHERE singleton=1').toArray()[0];
      if (!current) {
        this.sql.exec('INSERT INTO relayer_account(singleton,chain_id,address,next_nonce) VALUES(1,?,?,NULL)', chainId, address);
      } else if (current.chain_id !== chainId) {
        throw new EthereumApiError('invalid-argument', 'The claim network does not match this relayer.');
      } else if (current.address !== address) {
        if (this.unresolved().some(row => row.signed)) throw new EthereumApiError('unavailable', 'The claim relayer has unresolved transactions.');
        this.sql.exec('UPDATE relayer_account SET address=?,next_nonce=NULL WHERE singleton=1', address);
      }
    });
  }

  account(): { chainId: 1 | 11155111; address: string; nextNonce: string | null } | null {
    const row = this.sql.exec('SELECT * FROM relayer_account WHERE singleton=1').toArray()[0];
    return row ? { chainId: Number(row.chain_id) as 1 | 11155111, address: String(row.address),
      nextNonce: row.next_nonce === null ? null : String(row.next_nonce) } : null;
  }

  admit(input: TarotClaimInput, now: number): TarotClaimAttempt {
    const result = this.atomic(() => {
      const replay = this.sql.exec('SELECT * FROM claim_attempts WHERE request_id=?', input.requestId).toArray()[0];
      if (replay) {
        const existing = attempt(replay);
        if (existing.chainId !== input.chainId || existing.contractAddress !== input.contractAddress || existing.tokenId !== input.tokenId ||
          existing.recipient !== input.recipient || existing.codeHash !== input.codeHash) {
          throw new EthereumApiError('invalid-argument', 'This claim request identifies a different recipient or card.');
        }
        return existing;
      }
      const rejection = this.rejection(input);
      if (rejection) throw new TarotClaimRejected(rejection);
      const active = this.sql.exec(`SELECT * FROM claim_attempts WHERE chain_id=? AND contract_address=? AND token_id=?
        AND (state <> 'failed' OR raw_transaction IS NOT NULL AND finalized=0) ORDER BY id DESC LIMIT 1`,
      input.chainId, input.contractAddress, input.tokenId).toArray()[0];
      if (active) return attempt(active);
      if (this.sponsorshipExhausted(input)) {
        const failure: TarotClaimFailure = { code: 'failed-precondition', message: TAROT_SPONSORSHIP_LIMIT_MESSAGE,
          details: { kind: 'sponsorship-limit' } };
        this.insertRejection({ ...input, failure }, now);
        return { rejection: failure };
      }
      this.sql.exec(`INSERT INTO claim_attempts(chain_id,contract_address,token_id,request_id,recipient,code_hash,state,created_at_ms,updated_at_ms)
        VALUES(?,?,?,?,?,?,'submitting',?,?)`, input.chainId, input.contractAddress, input.tokenId, input.requestId,
      input.recipient, input.codeHash, now, now);
      return attempt(this.sql.exec('SELECT * FROM claim_attempts WHERE request_id=?', input.requestId).toArray()[0]);
    });
    if ('rejection' in result) throw new TarotClaimRejected(result.rejection);
    return result;
  }

  reject(input: TarotClaimRejectionInput, now: number): TarotClaimAttempt | TarotClaimRejection {
    validateTarotClaimScope(input);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId) ||
      !/^[0-9a-f]{64}$/.test(input.codeHash)) {
      throw new EthereumApiError('invalid-argument', 'Invalid sponsored claim request.');
    }
    return this.atomic(() => {
      const replay = this.sql.exec('SELECT * FROM claim_attempts WHERE request_id=?', input.requestId).toArray()[0];
      if (replay) {
        this.requireIdentity(replay, input);
        return attempt(replay);
      }
      const rejection = this.rejection(input);
      if (rejection) return { rejection };
      const active = this.sql.exec(`SELECT * FROM claim_attempts WHERE chain_id=? AND contract_address=? AND token_id=?
        AND (state <> 'failed' OR raw_transaction IS NOT NULL AND finalized=0) ORDER BY id DESC LIMIT 1`,
      input.chainId, input.contractAddress, input.tokenId).toArray()[0];
      if (active) return attempt(active);
      this.insertRejection(input, now);
      return { rejection: input.failure };
    });
  }

  private insertRejection(input: TarotClaimRejectionInput, now: number): void {
    this.sql.exec(`INSERT INTO claim_rejections(request_id,chain_id,contract_address,token_id,code_hash,failure,created_at_ms)
      VALUES(?,?,?,?,?,?,?)`, input.requestId, input.chainId, input.contractAddress, input.tokenId,
    input.codeHash, JSON.stringify(input.failure), now);
  }

  private rejection(input: TarotClaimScope & { requestId: string; codeHash: string }): TarotClaimFailure | null {
    const row = this.sql.exec('SELECT * FROM claim_rejections WHERE request_id=?', input.requestId).toArray()[0];
    if (!row) return null;
    this.requireIdentity(row, input);
    return JSON.parse(String(row.failure)) as TarotClaimFailure;
  }

  private requireIdentity(row: Row, input: TarotClaimScope & { codeHash: string }): void {
    if (row.chain_id !== input.chainId || row.contract_address !== input.contractAddress || row.token_id !== input.tokenId ||
      row.code_hash !== input.codeHash) {
      throw new EthereumApiError('invalid-argument', 'This claim request identifies different credentials or a different card.');
    }
  }

  get(id: number): TarotClaimAttempt {
    const row = this.sql.exec('SELECT * FROM claim_attempts WHERE id=?', id).toArray()[0];
    if (!row) throw new Error('Missing durable Tarot claim.');
    return attempt(row);
  }

  status(scope: TarotClaimScope & { requestId?: string }): TarotClaimAttempt | null {
    const row = this.sql.exec(`SELECT * FROM claim_attempts WHERE chain_id=? AND contract_address=? AND token_id=?
      ${scope.requestId ? 'AND request_id=?' : ''}
      ORDER BY (raw_transaction IS NOT NULL AND finalized=0) DESC,(raw_transaction IS NOT NULL) DESC,id DESC LIMIT 1`,
    scope.chainId, scope.contractAddress, scope.tokenId,
    ...(scope.requestId ? [scope.requestId] : [])).toArray()[0];
    return row ? attempt(row) : null;
  }

  unresolved(): TarotClaimAttempt[] {
    return this.sql.exec(`SELECT * FROM claim_attempts WHERE state='submitting'
      OR raw_transaction IS NOT NULL AND finalized=0 ORDER BY id`).toArray().map(attempt);
  }

  sponsorshipExhausted(scope: TarotClaimScope): boolean {
    return this.sql.exec(`SELECT 1 FROM claim_attempts WHERE chain_id=? AND contract_address=? AND token_id=?
      AND raw_transaction IS NOT NULL AND state='failed' AND finalized=1 LIMIT 1`,
    scope.chainId, scope.contractAddress, scope.tokenId).toArray().length > 0;
  }

  hasUnfinalizedClaim(scope: TarotClaimScope, exceptId: number): boolean {
    return this.sql.exec(`SELECT 1 FROM claim_attempts WHERE chain_id=? AND contract_address=? AND token_id=?
      AND id<>? AND raw_transaction IS NOT NULL AND finalized=0 LIMIT 1`,
    scope.chainId, scope.contractAddress, scope.tokenId, exceptId).toArray().length > 0;
  }

  outstandingFeeWei(): string {
    return this.unresolved().reduce((sum, row) => sum + BigInt(row.signed?.maximumFeeWei ?? '0'), 0n).toString();
  }

  persistSigned(id: number, signed: TarotSignedClaim, now: number): void {
    this.atomic(() => {
      const row = this.get(id);
      const account = this.account();
      if (row.state !== 'submitting' || row.signed || !account || account.address !== signed.relayerAddress ||
        account.nextNonce !== null && account.nextNonce !== signed.nonce) throw new Error('Tarot relayer nonce state changed.');
      if (this.sponsorshipExhausted(row)) throw new EthereumApiError('failed-precondition', TAROT_SPONSORSHIP_LIMIT_MESSAGE);
      if (this.hasUnfinalizedClaim(row, id)) throw new Error('This card has an unresolved sponsored claim.');
      this.sql.exec(`UPDATE claim_attempts SET state='pending',raw_transaction=?,transaction_hash=?,nonce=?,authorization_deadline=?,
        maximum_fee_wei=?,relayer_address=?,updated_at_ms=?,error=NULL,revision=revision+1 WHERE id=?`, signed.rawTransaction, signed.transactionHash,
      signed.nonce, signed.authorizationDeadline, signed.maximumFeeWei, signed.relayerAddress, now, id);
      this.sql.exec('UPDATE relayer_account SET next_nonce=? WHERE singleton=1', (BigInt(signed.nonce) + 1n).toString());
    });
  }

  recordBroadcast(id: number, now: number): void {
    this.sql.exec('UPDATE claim_attempts SET last_broadcast_at_ms=?,updated_at_ms=? WHERE id=?', now, now, id);
  }

  acceptBroadcast(id: number, now: number): void {
    this.sql.exec(`UPDATE claim_attempts SET broadcast_accepted=1,
      revision=revision+CASE WHEN state<>'pending' OR error IS NOT NULL THEN 1 ELSE 0 END,
      state='pending',updated_at_ms=?,error=NULL WHERE id=?`, now, id);
  }

  checked(id: number, now: number): void {
    this.sql.exec('UPDATE claim_attempts SET last_checked_at_ms=? WHERE id=?', now, id);
  }

  settle(id: number, state: 'confirmed' | 'failed' | 'recovery-required', error: string | null, now: number): void {
    this.sql.exec(`UPDATE claim_attempts SET revision=revision+CASE WHEN state<>? OR error IS NOT ? THEN 1 ELSE 0 END,
      state=?,error=?,updated_at_ms=?,finalized=CASE WHEN raw_transaction IS NULL AND ?='failed' THEN 1 ELSE finalized END WHERE id=?`,
    state, error, state, error, now, state, id);
  }

  observe(id: number, inspection: TarotClaimInspection, now: number): void {
    this.atomic(() => {
      const row = this.get(id);
      if (!row.signed || row.finalized) return;
      const orphaned = inspection.blockHash === null && (row.receiptBlockHash !== null || row.state === 'confirmed' || row.state === 'failed');
      const state = inspection.blockHash === null && row.state === 'recovery-required' ? row.state : inspection.status;
      const error = state === 'recovery-required' ? row.error : state === 'failed' && inspection.finalized ? TAROT_SPONSORSHIP_LIMIT_MESSAGE : null;
      if (row.state === state && row.error === error && row.finalized === inspection.finalized &&
        row.receiptBlockHash === inspection.blockHash && row.receiptBlockNumber === inspection.blockNumber) return;
      this.sql.exec(`UPDATE claim_attempts SET state=?,error=?,receipt_block_number=?,receipt_block_hash=?,finalized=?,
        revision=revision+1,updated_at_ms=?,broadcast_accepted=CASE WHEN ? THEN 0 ELSE broadcast_accepted END,
        last_broadcast_at_ms=CASE WHEN ? THEN NULL ELSE last_broadcast_at_ms END WHERE id=?`,
      state, error, inspection.blockNumber, inspection.blockHash, Number(inspection.finalized), now, Number(orphaned), Number(orphaned), id);
    });
  }
}
