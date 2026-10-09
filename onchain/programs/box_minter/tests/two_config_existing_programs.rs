#![allow(deprecated)]

use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use box_minter::{
    BoxMinterConfig, CloseDeliveryArgs, DeliverArgs, DeliveryRecord, FinalizeOpenBoxArgs,
    InitializeArgs, MintReceiptsArgs, PendingOpenBox, SplitPaymentsV1Args,
};
use litesvm::{types::TransactionMetadata, LiteSVM};
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    system_instruction, system_program,
    transaction::Transaction,
};
use solana_sha256_hasher::hashv;
use std::{env, fs, path::PathBuf, str::FromStr};

const ADMIN: &str = "kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx";
const MPL_CORE: &str = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const BUBBLEGUM: &str = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
const COMPRESSION: &str = "mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW";
const MPL_NOOP: &str = "mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3";
const SPL_NOOP: &str = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
const CORE_CPI_SIGNER: &str = "CbNY3JiXdXNE9tPNEk1aRZVEkWdj2v7kfJLNQwZZgpXk";
const METADATA_BASE: &str = "https://cdn.lil.org/nft/mi_note_cards/json/pre";
const COLLECTION_URI: &str = "https://cdn.lil.org/nft/mi_note_cards/preorder/collection.json";

fn key(value: &str) -> Pubkey {
    Pubkey::from_str(value).unwrap()
}

fn push_string(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u32).to_le_bytes());
    out.extend_from_slice(value.as_bytes());
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8], offset: usize) -> Self {
        Self { data, offset }
    }

    fn take<const N: usize>(&mut self) -> [u8; N] {
        let bytes = self.data[self.offset..self.offset + N].try_into().unwrap();
        self.offset += N;
        bytes
    }

    fn byte(&mut self) -> u8 {
        self.take::<1>()[0]
    }

    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take())
    }

    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take())
    }

    fn key(&mut self) -> Pubkey {
        Pubkey::new_from_array(self.take())
    }

    fn string(&mut self) -> String {
        let length = self.u32() as usize;
        let value =
            String::from_utf8(self.data[self.offset..self.offset + length].to_vec()).unwrap();
        self.offset += length;
        value
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CoreAsset {
    owner: Pubkey,
    update_kind: u8,
    update_authority: Option<Pubkey>,
    name: String,
    uri: String,
}

fn core_asset(account: &Account) -> CoreAsset {
    assert_eq!(account.owner, key(MPL_CORE));
    let mut reader = Reader::new(&account.data, 0);
    assert_eq!(reader.byte(), 1);
    let owner = reader.key();
    let update_kind = reader.byte();
    let update_authority = if update_kind == 0 {
        None
    } else {
        Some(reader.key())
    };
    CoreAsset {
        owner,
        update_kind,
        update_authority,
        name: reader.string(),
        uri: reader.string(),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CollectionIdentity {
    authority: Pubkey,
    name: String,
    uri: String,
    royalties: Vec<u8>,
    delegates: Vec<Pubkey>,
}

fn collection_identity(account: &Account) -> CollectionIdentity {
    let mut reader = Reader::new(&account.data, 0);
    assert_eq!(reader.byte(), 5);
    let authority = reader.key();
    let name = reader.string();
    let uri = reader.string();
    reader.u32();
    reader.u32();
    assert_eq!(reader.byte(), 3);
    let registry = reader.u64() as usize;
    let mut reader = Reader::new(&account.data, registry);
    assert_eq!(reader.byte(), 4);
    let count = reader.u32();
    let mut royalties = Vec::new();
    let mut delegates = Vec::new();
    let mut bubblegum = false;
    for _ in 0..count {
        let plugin = reader.byte();
        let authority_kind = reader.byte();
        let plugin_authority = if authority_kind == 3 {
            Some(reader.key())
        } else {
            None
        };
        let offset = reader.u64() as usize;
        let mut data = Reader::new(&account.data, offset);
        assert_eq!(data.byte(), plugin);
        match plugin {
            0 => {
                assert_eq!(authority_kind, 2);
                data.take::<2>();
                let creators = data.u32();
                for _ in 0..creators {
                    data.key();
                    data.byte();
                }
                assert_eq!(data.byte(), 0);
                royalties = account.data[offset..data.offset].to_vec();
            }
            4 => {
                assert_eq!(authority_kind, 2);
                let count = data.u32();
                delegates = (0..count).map(|_| data.key()).collect();
            }
            15 => {
                assert_eq!(plugin_authority, Some(key(BUBBLEGUM)));
                bubblegum = true;
            }
            _ => panic!("Unexpected collection plugin {plugin}"),
        }
    }
    assert!(bubblegum);
    CollectionIdentity {
        authority,
        name,
        uri,
        royalties,
        delegates,
    }
}

fn collection_counts(account: &Account) -> (u32, u32) {
    let mut reader = Reader::new(&account.data, 0);
    assert_eq!(reader.byte(), 5);
    reader.key();
    reader.string();
    reader.string();
    (reader.u32(), reader.u32())
}

struct Harness {
    svm: LiteSVM,
    program: Pubkey,
    cluster: &'static str,
    admin: Pubkey,
    payer: Pubkey,
    collection: Pubkey,
    treasury: Pubkey,
    recipients: [Pubkey; 2],
    sales: Pubkey,
    operations: Pubkey,
    public_supply: u32,
}

impl Harness {
    fn new(cluster: &'static str, program: &str, public_supply: u32) -> Self {
        let root = PathBuf::from(
            env::var_os("TWO_CONFIG_FIXTURES_DIR").expect("TWO_CONFIG_FIXTURES_DIR is required"),
        );
        assert!(root.is_absolute());
        let program = key(program);
        let mut svm = LiteSVM::new()
            .with_sigverify(false)
            .with_transaction_history(0);
        for (name, address) in [
            ("box_minter", program),
            ("mpl_core", key(MPL_CORE)),
            ("bubblegum", key(BUBBLEGUM)),
            ("compression", key(COMPRESSION)),
            ("mpl_noop", key(MPL_NOOP)),
            ("spl_noop", key(SPL_NOOP)),
        ] {
            let path = root.join(cluster).join(format!("{name}.so"));
            let bytes = fs::read(&path).unwrap();
            assert_eq!(&bytes[..4], b"\x7fELF");
            svm.add_program(address, &bytes)
                .unwrap_or_else(|error| panic!("Load {path:?}: {error:?}"));
        }
        let admin = key(ADMIN);
        let payer = Pubkey::new_unique();
        let collection = Pubkey::new_unique();
        let treasury = Pubkey::new_unique();
        let recipients = [Pubkey::new_unique(), Pubkey::new_unique()];
        for address in [admin, payer, treasury, recipients[0], recipients[1]] {
            svm.set_account(
                address,
                Account {
                    lamports: 1_000_000_000_000,
                    data: Vec::new(),
                    owner: system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        }
        let drop_id = if cluster == "devnet" {
            "mi_note_cards_devnet"
        } else {
            "mi_note_cards"
        };
        let sales = config_pda(program, drop_id);
        let operations = config_pda(program, &format!("{drop_id}_operations"));
        Self {
            svm,
            program,
            cluster,
            admin,
            payer,
            collection,
            treasury,
            recipients,
            sales,
            operations,
            public_supply,
        }
    }

    fn ix<A: ToAccountMetas, D: InstructionData>(&self, accounts: A, data: D) -> Instruction {
        Instruction {
            program_id: self.program,
            accounts: accounts.to_account_metas(None),
            data: data.data(),
        }
    }

    fn transaction(&self, payer: Pubkey, instructions: Vec<Instruction>) -> Transaction {
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend(instructions);
        Transaction::new_unsigned(Message::new_with_blockhash(
            &all,
            Some(&payer),
            &self.svm.latest_blockhash(),
        ))
    }

    fn send(
        &mut self,
        label: &str,
        payer: Pubkey,
        instructions: Vec<Instruction>,
    ) -> TransactionMetadata {
        let tx = self.transaction(payer, instructions);
        let result = self
            .svm
            .send_transaction(tx)
            .unwrap_or_else(|error| panic!("{} {label}: {error:#?}", self.cluster));
        println!(
            "{} {label}: {} CU",
            self.cluster, result.compute_units_consumed
        );
        result
    }

    fn reject(&mut self, label: &str, payer: Pubkey, instruction: Instruction, expected: &str) {
        let tx = self.transaction(payer, vec![instruction]);
        let error = self.svm.send_transaction(tx).expect_err(label);
        assert!(
            error.meta.logs.iter().any(|log| log.contains(expected)),
            "{label}: expected {expected}, got {error:#?}"
        );
    }

    fn account(&self, address: Pubkey) -> Account {
        self.svm.get_account(&address).unwrap()
    }

    fn config(&self, address: Pubkey) -> BoxMinterConfig {
        BoxMinterConfig::try_deserialize(&mut self.account(address).data.as_slice()).unwrap()
    }

    fn create_collection(&mut self) {
        let mut data = vec![21];
        push_string(&mut data, "Mi Note Cards");
        push_string(&mut data, COLLECTION_URI);
        data.push(1);
        data.extend_from_slice(&3u32.to_le_bytes());
        data.push(0);
        data.extend_from_slice(&500u16.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(self.recipients[0].as_ref());
        data.extend_from_slice(&[100, 0, 0, 15, 0, 4]);
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(self.admin.as_ref());
        data.extend_from_slice(&[0, 1]);
        data.extend_from_slice(&0u32.to_le_bytes());
        let ix = Instruction {
            program_id: key(MPL_CORE),
            accounts: vec![
                AccountMeta::new(self.collection, true),
                AccountMeta::new_readonly(self.admin, false),
                AccountMeta::new(self.admin, true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data,
        };
        self.send("create real collection", self.admin, vec![ix]);
        assert_eq!(
            collection_identity(&self.account(self.collection)).delegates,
            vec![self.admin]
        );
    }

    fn create_preorder(&mut self) -> Pubkey {
        let asset = Pubkey::new_unique();
        let mut data = vec![0, 0];
        push_string(&mut data, "Preorder #1");
        push_string(
            &mut data,
            "https://cdn.lil.org/nft/mi_note_cards/preorder/json/1.json",
        );
        data.push(0);
        let ix = Instruction {
            program_id: key(MPL_CORE),
            accounts: vec![
                AccountMeta::new(asset, true),
                AccountMeta::new(self.collection, false),
                AccountMeta::new_readonly(self.admin, true),
                AccountMeta::new(self.admin, true),
                AccountMeta::new_readonly(self.payer, false),
                AccountMeta::new_readonly(key(MPL_CORE), false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(key(MPL_CORE), false),
            ],
            data,
        };
        self.send("create unchanged preorder fixture", self.admin, vec![ix]);
        asset
    }

    fn initialize(&mut self, operations: bool) {
        let drop_id = if self.cluster == "devnet" {
            "mi_note_cards_devnet"
        } else {
            "mi_note_cards"
        };
        let seed_id = if operations {
            format!("{drop_id}_operations")
        } else {
            drop_id.to_string()
        };
        let args = InitializeArgs {
            price_lamports: 250_000_000,
            discount_price_lamports: 250_000_000,
            discount_merkle_root: hashv(&[Pubkey::default().as_ref()]).to_bytes(),
            max_supply: if operations { 715 } else { self.public_supply },
            max_per_tx: 15,
            items_per_box: if operations { 2 } else { 0 },
            name_prefix: "pack".into(),
            symbol: "minote".into(),
            uri_base: METADATA_BASE.into(),
            discount_mints_per_wallet: 1,
            figure_name_prefix: "card".into(),
            mint_variant_kind: 0,
            mint_variant_start_ids: [0; 3],
            mint_variant_end_ids: [0; 3],
            mint_variant_next_ids: [0; 3],
            drop_seed: hashv(&[seed_id.as_bytes()]).to_bytes(),
        };
        let config = if operations {
            self.operations
        } else {
            self.sales
        };
        let ix = self.ix(
            box_minter::accounts::Initialize {
                config,
                admin: self.admin,
                treasury: self.treasury,
                core_collection: self.collection,
                system_program: system_program::ID,
            },
            box_minter::instruction::InitializeSplitPaymentsV1 {
                args,
                split_args: SplitPaymentsV1Args {
                    recipient_count: 2,
                    recipients: [self.recipients[0], self.recipients[1], Pubkey::default()],
                    percentages: [50, 50, 0],
                },
            },
        );
        self.send(
            if operations {
                "initialize B"
            } else {
                "initialize A"
            },
            self.admin,
            vec![ix],
        );
        assert_eq!(self.account(config).data.len(), 488);
        assert!(!self.config(config).started);
        assert_eq!(self.config(config).minted, 0);
        assert_eq!(self.config(config).price_lamports, 250_000_000);
        assert_eq!(self.config(config).discount_price_lamports, 250_000_000);
        assert_eq!(
            self.config(config).discount_merkle_root,
            hashv(&[Pubkey::default().as_ref()]).to_bytes()
        );
    }

    fn delegate_configs(&mut self) {
        let mut before = collection_identity(&self.account(self.collection));
        let mut data = vec![7, 4];
        data.extend_from_slice(&3u32.to_le_bytes());
        for delegate in [self.admin, self.sales, self.operations] {
            data.extend_from_slice(delegate.as_ref());
        }
        let ix = Instruction {
            program_id: key(MPL_CORE),
            accounts: vec![
                AccountMeta::new(self.collection, false),
                AccountMeta::new(self.admin, true),
                AccountMeta::new_readonly(self.admin, true),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(key(SPL_NOOP), false),
            ],
            data,
        };
        self.send(
            "preserve and extend collection delegates",
            self.admin,
            vec![ix],
        );
        before.delegates = vec![self.admin, self.sales, self.operations];
        assert_eq!(collection_identity(&self.account(self.collection)), before);
    }

    fn mint_ix(&self, config: Pubkey, mint_id: u64) -> (Instruction, Pubkey) {
        let (asset, bump) = Pubkey::find_program_address(
            &[
                b"box",
                config.as_ref(),
                self.payer.as_ref(),
                &mint_id.to_le_bytes(),
                &[0],
            ],
            &self.program,
        );
        let mut ix = self.ix(
            box_minter::accounts::MintBoxes {
                config,
                payer: self.payer,
                treasury: self.treasury,
                core_collection: self.collection,
                mpl_core_program: key(MPL_CORE),
                system_program: system_program::ID,
            },
            box_minter::instruction::MintBoxes {
                quantity: 1,
                mint_id,
                box_bumps: vec![bump],
            },
        );
        ix.accounts.push(AccountMeta::new(asset, false));
        ix.accounts.extend(
            self.recipients
                .map(|recipient| AccountMeta::new(recipient, false)),
        );
        (ix, asset)
    }

    fn open_ix(&self, config: Pubkey, asset: Pubkey) -> (Instruction, Pubkey, [Pubkey; 2]) {
        let (pending, _) = Pubkey::find_program_address(&[b"open", asset.as_ref()], &self.program);
        let dudes = [0u8, 1].map(|index| {
            Pubkey::find_program_address(&[b"pdude", pending.as_ref(), &[index]], &self.program).0
        });
        let mut ix = self.ix(
            box_minter::accounts::StartOpenBox {
                config,
                payer: self.payer,
                box_asset: asset,
                vault: self.admin,
                core_collection: self.collection,
                mpl_core_program: key(MPL_CORE),
                system_program: system_program::ID,
                log_wrapper: key(SPL_NOOP),
                pending,
            },
            box_minter::instruction::StartOpenBox {},
        );
        ix.accounts
            .extend(dudes.map(|dude| AccountMeta::new(dude, false)));
        (ix, pending, dudes)
    }

    fn finalize_ix(
        &self,
        config: Pubkey,
        asset: Pubkey,
        pending: Pubkey,
        dudes: [Pubkey; 2],
        ids: Vec<u16>,
    ) -> Instruction {
        let mut ix = self.ix(
            box_minter::accounts::FinalizeOpenBox {
                config,
                cosigner: self.admin,
                box_asset: asset,
                core_collection: self.collection,
                mpl_core_program: key(MPL_CORE),
                system_program: system_program::ID,
                log_wrapper: key(SPL_NOOP),
                pending,
                user: self.payer,
            },
            box_minter::instruction::FinalizeOpenBox {
                args: FinalizeOpenBoxArgs { dude_ids: ids },
            },
        );
        ix.accounts
            .extend(dudes.map(|dude| AccountMeta::new(dude, false)));
        ix
    }

    fn create_tree(&mut self) -> (Pubkey, Pubkey) {
        let tree = Pubkey::new_unique();
        let tree_config = Pubkey::find_program_address(&[tree.as_ref()], &key(BUBBLEGUM)).0;
        let depth = 14u32;
        let buffer = 64u32;
        let space = 2 + 54 + 24 + (buffer as usize + 1) * (40 + 32 * depth as usize);
        let create = system_instruction::create_account(
            &self.admin,
            &tree,
            self.svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &key(COMPRESSION),
        );
        let mut data = vec![55, 99, 95, 215, 142, 203, 227, 205];
        data.extend_from_slice(&depth.to_le_bytes());
        data.extend_from_slice(&buffer.to_le_bytes());
        data.push(0);
        let configure = Instruction {
            program_id: key(BUBBLEGUM),
            accounts: vec![
                AccountMeta::new(tree_config, false),
                AccountMeta::new(tree, false),
                AccountMeta::new(self.admin, true),
                AccountMeta::new_readonly(self.admin, true),
                AccountMeta::new_readonly(key(MPL_NOOP), false),
                AccountMeta::new_readonly(key(COMPRESSION), false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data,
        };
        self.send(
            "create real Bubblegum receipt tree",
            self.admin,
            vec![create, configure],
        );
        assert_eq!(self.account(tree).owner, key(COMPRESSION));
        assert_eq!(Reader::new(&self.account(tree_config).data, 80).u64(), 0);
        (tree, tree_config)
    }

    fn receipts_ix(
        &self,
        config: Pubkey,
        tree: Pubkey,
        tree_config: Pubkey,
        box_ids: Vec<u32>,
        dude_ids: Vec<u16>,
    ) -> Instruction {
        self.ix(
            box_minter::accounts::MintReceipts {
                config,
                cosigner: self.admin,
                user: self.payer,
                merkle_tree: tree,
                tree_config,
                core_collection: self.collection,
                bubblegum_program: key(BUBBLEGUM),
                log_wrapper: key(MPL_NOOP),
                compression_program: key(COMPRESSION),
                mpl_core_program: key(MPL_CORE),
                mpl_core_cpi_signer: key(CORE_CPI_SIGNER),
                system_program: system_program::ID,
            },
            box_minter::instruction::MintReceipts {
                args: MintReceiptsArgs { box_ids, dude_ids },
            },
        )
    }
}

fn config_pda(program: Pubkey, name: &str) -> Pubkey {
    Pubkey::find_program_address(&[b"config", hashv(&[name.as_bytes()]).as_ref()], &program).0
}

fn assert_missing_or_closed(harness: &Harness, address: Pubkey) {
    assert!(
        harness
            .svm
            .get_account(&address)
            .is_none_or(|account| account.lamports == 0),
        "account remains: {:?}",
        harness.svm.get_account(&address)
    );
}

fn run_gate(cluster: &'static str, program: &str, public_supply: u32) {
    let mut h = Harness::new(cluster, program, public_supply);
    h.create_collection();
    let preorder = h.create_preorder();
    let preorder_before = h.account(preorder);
    h.initialize(false);
    h.initialize(true);
    h.delegate_configs();
    assert_eq!(h.account(preorder), preorder_before);
    let start_a = h.ix(
        box_minter::accounts::StartMint {
            config: h.sales,
            admin: h.admin,
        },
        box_minter::instruction::StartMint {},
    );
    h.send("start A only", h.admin, vec![start_a]);
    let (paused, _) = h.mint_ix(h.operations, 1);
    h.reject("B mint remains disabled", h.payer, paused, "MintNotStarted");

    let before = h.recipients.map(|recipient| h.account(recipient).lamports);
    let (mint, asset) = h.mint_ix(h.sales, 2);
    h.send("mint pack using A", h.payer, vec![mint]);
    assert_eq!(
        h.recipients.map(|recipient| h.account(recipient).lamports),
        before.map(|amount| amount + 125_000_000)
    );
    assert_eq!(
        core_asset(&h.account(asset)),
        CoreAsset {
            owner: h.payer,
            update_kind: 2,
            update_authority: Some(h.collection),
            name: "pack 1".into(),
            uri: format!("{METADATA_BASE}/b1.json"),
        }
    );
    let (wrong_open, pending, _) = h.open_ix(h.sales, asset);
    h.reject(
        "opening under A is disabled",
        h.payer,
        wrong_open,
        "OpeningDisabled",
    );
    assert_missing_or_closed(&h, pending);
    let (mut wrong_owner, _, _) = h.open_ix(h.operations, asset);
    wrong_owner.accounts[1].pubkey = h.recipients[0];
    h.reject(
        "only the pack owner may open",
        h.recipients[0],
        wrong_owner,
        "InvalidAssetOwner",
    );
    assert_missing_or_closed(&h, pending);
    let (mut wrong_collection, _, _) = h.open_ix(h.operations, asset);
    wrong_collection.accounts[4].pubkey = Pubkey::new_unique();
    h.reject(
        "opening collection must match B",
        h.payer,
        wrong_collection,
        "ConstraintAddress",
    );
    assert_missing_or_closed(&h, pending);
    let (preorder_open, preorder_pending, _) = h.open_ix(h.operations, preorder);
    h.reject(
        "preorder cannot be opened as pack",
        h.payer,
        preorder_open,
        "InvalidAssetMetadata",
    );
    assert_missing_or_closed(&h, preorder_pending);
    assert_eq!(h.account(preorder), preorder_before);

    let (open, pending, dudes) = h.open_ix(h.operations, asset);
    h.send("open A pack using B", h.payer, vec![open]);
    let pending_state =
        PendingOpenBox::try_deserialize(&mut h.account(pending).data.as_slice()).unwrap();
    assert_eq!(pending_state.config, h.operations);
    assert_eq!(pending_state.owner, h.payer);
    assert_eq!(pending_state.dudes, dudes);
    for dude in dudes {
        assert_eq!(
            core_asset(&h.account(dude)),
            CoreAsset {
                owner: h.admin,
                update_kind: 1,
                update_authority: Some(h.operations),
                name: String::new(),
                uri: String::new(),
            }
        );
    }
    let (repeat, _, _) = h.open_ix(h.operations, asset);
    h.reject(
        "duplicate open rejected",
        h.payer,
        repeat,
        "PendingAlreadyExists",
    );
    let pending_before = h.account(pending);
    let box_before = h.account(asset);
    for ids in [vec![0, 1409], vec![1431, 1409], vec![1430, 1430]] {
        let expected = if ids[0] == ids[1] {
            "DuplicateDudeId"
        } else {
            "InvalidDudeId"
        };
        let invalid = h.finalize_ix(h.operations, asset, pending, dudes, ids);
        h.reject(
            "invalid reveal IDs rejected atomically",
            h.admin,
            invalid,
            expected,
        );
        assert_eq!(h.account(pending), pending_before);
        assert_eq!(h.account(asset), box_before);
    }
    let wrong = h.finalize_ix(h.sales, asset, pending, dudes, vec![1430, 1409]);
    h.reject(
        "finalize cannot switch to A",
        h.admin,
        wrong,
        "OpeningDisabled",
    );
    let wrong_seed = hashv(&[b"wrong_operations_config"]).to_bytes();
    let (wrong_config, wrong_bump) =
        Pubkey::find_program_address(&[b"config", &wrong_seed], &h.program);
    let mut wrong_account = h.account(h.operations);
    let mut wrong_state = h.config(h.operations);
    wrong_state.drop_seed = wrong_seed;
    wrong_state.bump = wrong_bump;
    wrong_state
        .try_serialize(&mut wrong_account.data.as_mut_slice())
        .unwrap();
    h.svm.set_account(wrong_config, wrong_account).unwrap();
    let wrong = h.finalize_ix(wrong_config, asset, pending, dudes, vec![1430, 1409]);
    h.reject(
        "pending open is bound to exact B config",
        h.admin,
        wrong,
        "InvalidPendingRecord",
    );
    let finalize = h.finalize_ix(h.operations, asset, pending, dudes, vec![1430, 1409]);
    h.send(
        "finalize B with original IDs 1430 and 1409",
        h.admin,
        vec![finalize],
    );
    let burned = h.account(asset);
    assert_eq!(burned.owner, key(MPL_CORE));
    assert_eq!(burned.data, [0]);
    assert_missing_or_closed(&h, pending);
    for (dude, id) in dudes.into_iter().zip([1430, 1409]) {
        assert_eq!(
            core_asset(&h.account(dude)),
            CoreAsset {
                owner: h.payer,
                update_kind: 2,
                update_authority: Some(h.collection),
                name: format!("card {id}"),
                uri: format!("{METADATA_BASE}/f{id}.json"),
            }
        );
    }

    let collection_before_receipts = collection_counts(&h.account(h.collection));
    let (tree, tree_config) = h.create_tree();
    let receipt = h.receipts_ix(h.operations, tree, tree_config, vec![1], vec![1430, 1409]);
    let tx = h.transaction(h.admin, vec![receipt]);
    let account_keys = tx.message.account_keys.clone();
    let metadata = h
        .svm
        .send_transaction(tx)
        .unwrap_or_else(|error| panic!("{cluster} receipt CPI: {error:#?}"));
    println!(
        "{cluster} mint B receipts: {} CU",
        metadata.compute_units_consumed
    );
    println!(
        "{cluster} collection counters (num_minted, current_size): before receipts {:?}, after receipts {:?}",
        collection_before_receipts,
        collection_counts(&h.account(h.collection))
    );
    assert_eq!(
        collection_counts(&h.account(h.collection)),
        (
            collection_before_receipts.0 + 3,
            collection_before_receipts.1 + 3
        )
    );
    assert_eq!(Reader::new(&h.account(tree_config).data, 80).u64(), 3);
    let mut receipts = Vec::new();
    for inner in metadata.inner_instructions.iter().flatten() {
        let ix = &inner.instruction;
        if account_keys[ix.program_id_index as usize] == key(BUBBLEGUM) {
            let mut data = Reader::new(&ix.data, 8);
            let name = data.string();
            assert_eq!(data.string(), "");
            let uri = data.string();
            data.take::<2>();
            assert_eq!(data.take::<4>(), [0, 1, 1, 0]);
            assert_eq!(data.u32(), 0);
            assert_eq!(data.byte(), 1);
            assert_eq!(data.key(), h.collection);
            receipts.push((name, uri));
        }
    }
    assert_eq!(
        receipts,
        vec![
            (
                "receipt · pack 1".into(),
                format!("{METADATA_BASE}/rb1.json")
            ),
            (
                "receipt · card 1430".into(),
                format!("{METADATA_BASE}/rf1430.json")
            ),
            (
                "receipt · card 1409".into(),
                format!("{METADATA_BASE}/rf1409.json")
            ),
        ]
    );
    let invalid_receipt = h.receipts_ix(h.operations, tree, tree_config, vec![], vec![1431]);
    h.reject(
        "receipt upper bound",
        h.admin,
        invalid_receipt,
        "InvalidDudeId",
    );
    assert_eq!(Reader::new(&h.account(tree_config).data, 80).u64(), 3);
    let sales_receipt = h.receipts_ix(h.sales, tree, tree_config, vec![], vec![1430]);
    h.reject(
        "card receipts require operations config",
        h.admin,
        sales_receipt,
        "InvalidDudeId",
    );
    let mut unauthorized_receipt =
        h.receipts_ix(h.operations, tree, tree_config, vec![], vec![1430]);
    unauthorized_receipt.accounts[1].pubkey = h.payer;
    h.reject(
        "receipts require the configured admin",
        h.payer,
        unauthorized_receipt,
        "InvalidCosigner",
    );
    assert_eq!(Reader::new(&h.account(tree_config).data, 80).u64(), 3);

    let (sealed_mint, sealed_pack) = h.mint_ix(h.sales, 3);
    h.send(
        "mint sealed pack for physical delivery",
        h.payer,
        vec![sealed_mint],
    );
    let delivery_id = 1u32;
    let (delivery, delivery_bump) = Pubkey::find_program_address(
        &[
            b"delivery",
            h.operations.as_ref(),
            &delivery_id.to_le_bytes(),
        ],
        &h.program,
    );
    let before = h.account(h.treasury).lamports;
    let mut deliver = h.ix(
        box_minter::accounts::Deliver {
            config: h.operations,
            cosigner: h.admin,
            payer: h.payer,
            treasury: h.treasury,
            core_collection: h.collection,
            mpl_core_program: key(MPL_CORE),
            system_program: system_program::ID,
            log_wrapper: key(SPL_NOOP),
            delivery,
        },
        box_minter::instruction::Deliver {
            args: DeliverArgs {
                delivery_id,
                delivery_fee_lamports: 1_000_000,
                delivery_bump,
            },
        },
    );
    deliver.accounts.push(AccountMeta::new(dudes[0], false));
    deliver.accounts.push(AccountMeta::new(sealed_pack, false));
    h.send(
        "deliver A pack and revealed card using B",
        h.payer,
        vec![deliver],
    );
    assert_eq!(h.account(h.treasury).lamports, before + 1_000_000);
    assert_eq!(core_asset(&h.account(dudes[0])).owner, h.admin);
    assert_eq!(core_asset(&h.account(sealed_pack)).owner, h.admin);
    let record = DeliveryRecord::try_deserialize(&mut h.account(delivery).data.as_slice()).unwrap();
    assert_eq!(record.item_count, 2);
    let close = h.ix(
        box_minter::accounts::CloseDelivery {
            config: h.operations,
            cosigner: h.admin,
            delivery,
            system_program: system_program::ID,
        },
        box_minter::instruction::CloseDelivery {
            _args: CloseDeliveryArgs {
                delivery_id,
                delivery_bump,
            },
        },
    );
    h.send("close B delivery record", h.admin, vec![close]);
    assert_missing_or_closed(&h, delivery);

    let mut account = h.account(h.sales);
    let mut config = h.config(h.sales);
    config.minted = public_supply - 1;
    config
        .try_serialize(&mut account.data.as_mut_slice())
        .unwrap();
    h.svm.set_account(h.sales, account).unwrap();
    let (last, last_asset) = h.mint_ix(h.sales, 4);
    h.send("last allowed A pack", h.payer, vec![last]);
    assert_eq!(
        core_asset(&h.account(last_asset)).uri,
        format!("{METADATA_BASE}/b{public_supply}.json")
    );
    let (over_supply, _) = h.mint_ix(h.sales, 5);
    h.reject("A supply cap", h.payer, over_supply, "SoldOut");
    assert_eq!(h.config(h.sales).minted, public_supply);
    assert_eq!(h.config(h.operations).minted, 0);
    assert!(!h.config(h.operations).started);
    assert_eq!(h.account(preorder), preorder_before);
    println!("{cluster}: real deployed binary two-config gate passed");
}

#[test]
fn deployed_devnet_two_config_gate() {
    run_gate("devnet", "8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6", 704);
}

#[test]
fn deployed_mainnet_two_config_gate() {
    run_gate(
        "mainnet-beta",
        "7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU",
        627,
    );
}
