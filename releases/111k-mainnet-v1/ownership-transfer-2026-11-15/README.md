# 111k mainnet ownership transfer

The deployer nominated treasury Safe `0x72D0c5623A05033F9eE4495D408BC6c05DF8367d` as the new owner of collection `0x08cDed8258730bda384FF198001E47a1B50f7f9d` on 15 November 2026. The [nomination transaction](https://etherscan.io/tx/0xc364a46a53907c8aceb4e9a6c84d23abc38d313361cd3992caafe24c4e543fdb) succeeded in block **26420872** and was verified with **123 canonical confirmations** before committing these artifacts.

**Awaiting Safe acceptance.** At verification block **26420994**, `owner()` remains deployer `0xd58d143ca63d9baccc33fdf69ea203f59c58ae93`, and `pendingOwner()` is the Safe. The nomination alone does not complete the transfer.

## Accept through the Safe

The [accept-ownership.safe.json](accept-ownership.safe.json) file was imported into the [Ethereum mainnet Safe](https://app.safe.global/home?safe=eth:0x72D0c5623A05033F9eE4495D408BC6c05DF8367d) in Safari and advanced to the signing review with **Sign** enabled, Safe nonce **1**, and zero of two confirmations. The decoded review showed `acceptOwnership()` on `NFT111K`, no parameters, and no balance change. The file contains exactly one call:

| Field | Value |
| --- | --- |
| Chain | Ethereum mainnet, 1 |
| Sender | `0x72D0c5623A05033F9eE4495D408BC6c05DF8367d` |
| Target | `0x08cDed8258730bda384FF198001E47a1B50f7f9d` |
| Function | `acceptOwnership()` |
| ETH value | `0` |
| Calldata | `0x79ba5097` |
| Operation | Call, 0 |

The live Safe is version 1.5.0 with a two-of-three threshold. Two Safe owners must approve, then execute the transaction. The import file leaves Safe nonce selection to the Safe application and can be reimported into Transaction Builder if the prepared browser session is closed. The direct acceptance call simulated successfully after nomination.

After execution, verify the acceptance receipt and `OwnershipTransferred` event with at least three canonical confirmations, `owner()` equal to the Safe, and `pendingOwner()` equal to the zero address. The private operation's read-only `verify` command checks both nomination and acceptance evidence:

```sh
node --env-file=.env.local .operations/111k-mainnet-ownership-2026-11-15/operation.mjs verify
```

Update this record and [verification.json](verification.json) after acceptance. The agent stopped before clicking Sign; user signatures and execution are not evidenced by this record.

## Evidence

[Preparation](preparation.json) pins the collection runtime, current owner, Safe configuration, chain, nonce, exact nomination calldata, and fee limit. [Verification](verification.json) records the successful nomination receipt, resulting ownership state, and acceptance simulation. Nomination gas cost was **0.000026812824379956 ETH**. Signed transaction bytes remain in the private `.operations/111k-mainnet-ownership-2026-11-15/` journal; the temporary password directory was removed.

After acceptance, owner-only administration must execute through the Safe. Existing quote signing, payouts, delivery receivers, token ownership, and sale settings are independent of this handover. No application deployment is required. Original deployment manifests and closed-state verification remain historical evidence.
