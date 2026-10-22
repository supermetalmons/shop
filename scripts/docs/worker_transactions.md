# One-off Solana transactions with the Worker signer

Import `runWorkerTransaction` from `scripts/ops/worker-transaction/index.ts` in a
TypeScript operation script. Supply its instructions and domain checks; the helper
handles simulation, signing, submission, confirmation, journals, and Worker cleanup.

The operation argument has these fields:

```ts
import type { Connection, SimulatedTransactionResponse, TransactionInstruction } from '@solana/web3.js';

type Operation = {
  id: string;
  cluster: 'devnet' | 'mainnet-beta';
  authority: string;
  instructions: TransactionInstruction[];
  simulationAccounts: string[];
  preflight: (connection: Connection) => Promise<void>;
  validateSimulation: (result: SimulatedTransactionResponse) => void | Promise<void>;
  verify: (connection: Connection, finalizedSlot: number) => Promise<void>;
  maxFeeLamports?: number;
};
```

`preflight` checks the operation's current prerequisites. `validateSimulation`
checks the expected effects on the requested accounts. `verify` checks finalized
state at or after the supplied slot. Keep these checks in the operation script;
the helper does not infer whether a program's effects match the intended change.
Transaction inputs are copied before callbacks run and remain fixed for the attempt.

For a Metaplex Core collection URI change, `buildCollectionUriUpdate` from
`scripts/ops/worker-transaction/transaction.ts` builds the instruction from
`{ collection, authority, uri }`. Keep collection identity, metadata, and preserved
plugin checks in the operation's callbacks.

Call `runWorkerTransaction(operation, options)`. Options are:

- `write`: defaults to `false`, for read-only preparation and simulation. Set it
  to `true` only for an authorized operation.
- `root`: optional project root.
- `cloudflare`: optional `{ accountId, workerName }`; otherwise use the API
  Worker's Wrangler configuration.
- `signerBinding`: defaults to `COSIGNER_SECRET`.

The default fee cap is 10,000 lamports. The Worker key must be the authority,
sole signer, and fee payer. Transactions use a v0 message without lookup tables
or durable nonces. Additional signers are not supported.

The private key stays in Cloudflare. A temporary authenticated Worker version
contains the exact unsigned message and accepts only an empty POST to sign it.
It accepts no caller-provided transaction or target. The runner validates the
returned signature and message before recording and broadcasting the transaction.
Temporary versions receive no production traffic. Cleanup preserves production
routing and removes the signer version, restoring the previously latest uploaded
version, including staged changes, when Cloudflare requires a newer version before
deletion. A separate production deployment is recorded without invalidating
verified removal of the signer.
The temporary signer uses its own tested runtime settings; restoration retains
the source Worker's original compatibility date and flags.

State is saved under `.cache/worker-transactions/<id>/`: `journal.json` retains
recovery evidence and `receipt.json` records success. Locks live under
`.cache/worker-transactions/locks` for each Worker, with an `operation.lock` in
each operation directory. After completion, copy the public receipt to the
relevant release folder when the operation needs lasting project history.

Unresolved cleanup for a Worker blocks new operation IDs on that same Worker;
resume the original operation to finish cleanup first. A definitively rejected
upload that created no version does not block other operations. Temporary signer
versions cannot serve as restoration sources, and Workers with Durable Object
bindings or lifecycle/migration state are rejected before upload.

Resume an interrupted operation with the same ID and instructions. Preserve its
journal and resolve any uncertain upload or transaction outcome before starting
another attempt. An expired signed transaction requires inspection and journal
resolution; do not blindly create a replacement. If a lock remains, confirm its
owning process has stopped before removing only that lock. Never delete journals
to bypass unresolved work.
