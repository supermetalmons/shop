#![allow(deprecated)]

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use box_minter::{
    BoxMinterConfig, DeliverArgs, DeliveryRecord, InitializeArgs, SplitPaymentsV1Args,
};
use litesvm::{types::FailedTransactionMetadata, LiteSVM};
use solana_program_runtime::declare_process_instruction;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    message::Message,
    native_loader,
    pubkey::Pubkey,
    system_program,
    transaction::Transaction,
};
use solana_sha256_hasher::hashv;
use std::{env, path::PathBuf, str::FromStr};

const CONFIG_SPACE: usize = 376;
const SPLIT_CONFIG_SPACE: usize = 488;
const SPLIT_TAIL_SPACE: usize = 112;
const TREASURY_OFFSET: usize = 40;
const MPL_CORE_ID: Pubkey = Pubkey::new_from_array([
    175, 84, 171, 16, 189, 151, 165, 66, 160, 158, 247, 179, 152, 137, 221, 12, 211, 148, 164, 204,
    233, 223, 166, 205, 201, 126, 190, 45, 35, 91, 167, 72,
]);
const SPL_NOOP_ID: Pubkey = Pubkey::new_from_array([
    11, 188, 15, 192, 187, 71, 202, 47, 116, 196, 17, 46, 148, 171, 19, 207, 163, 198, 52, 229,
    220, 23, 234, 203, 3, 205, 26, 35, 205, 126, 120, 124,
]);

declare_process_instruction!(MockMplCore, 1, |invoke_context| {
    let transaction_context = &invoke_context.transaction_context;
    let instruction_context = transaction_context.get_current_instruction_context()?;
    let data = instruction_context.get_instruction_data();
    if data.len() >= 6 && data[0] == 0 && data[1] == 0 {
        let name_len = u32::from_le_bytes(
            data[2..6]
                .try_into()
                .map_err(|_| InstructionError::InvalidInstructionData)?,
        ) as usize;
        if data.get(6..6 + name_len) == Some(b"rollback 2") {
            return Err(InstructionError::Custom(0x5242));
        }
    }
    Ok(())
});

struct Harness {
    svm: LiteSVM,
    admin: Pubkey,
    collection: Pubkey,
    delivery_receiver: Pubkey,
    recipients: [Pubkey; 3],
    payer: Pubkey,
}

#[derive(Clone, Copy)]
struct ConfigFixture {
    key: Pubkey,
    drop_seed: [u8; 32],
}

fn system_account(lamports: u64) -> Account {
    Account {
        lamports,
        data: Vec::new(),
        owner: system_program::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn account_with_owner(lamports: u64, owner: Pubkey) -> Account {
    Account {
        lamports,
        data: vec![0],
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

fn program_path() -> PathBuf {
    let path =
        PathBuf::from(env::var_os("BOX_MINTER_SBF_PATH").expect("BOX_MINTER_SBF_PATH must be set"));
    assert!(path.is_absolute(), "BOX_MINTER_SBF_PATH must be absolute");
    assert!(path.is_file(), "SBF program does not exist: {path:?}");
    path
}

fn new_harness() -> Harness {
    let mut svm = LiteSVM::new()
        .with_sigverify(false)
        .with_transaction_history(0);
    svm.add_program_from_file(box_minter::ID, program_path())
        .expect("load box_minter SBF program");
    svm.add_builtin(MPL_CORE_ID, MockMplCore::vm);
    svm.set_account(
        MPL_CORE_ID,
        Account {
            lamports: 1,
            data: b"mock_mpl_core".to_vec(),
            owner: native_loader::ID,
            executable: true,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let admin = Pubkey::from_str("kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx").unwrap();
    let collection = Pubkey::new_unique();
    let recipients = [
        Pubkey::from_str("AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE").unwrap(),
        Pubkey::from_str("A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz").unwrap(),
        Pubkey::new_unique(),
    ];
    let delivery_receiver =
        Pubkey::from_str("AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq").unwrap();
    let payer = Pubkey::new_unique();

    svm.set_account(admin, system_account(100_000_000_000))
        .unwrap();
    svm.set_account(collection, account_with_owner(1_000_000, MPL_CORE_ID))
        .unwrap();
    svm.set_account(SPL_NOOP_ID, system_account(1_000_000))
        .unwrap();
    svm.set_account(payer, system_account(100_000_000_000))
        .unwrap();
    for recipient in recipients {
        svm.set_account(recipient, system_account(1_000_000))
            .unwrap();
    }
    svm.set_account(delivery_receiver, system_account(1_000_000))
        .unwrap();

    Harness {
        svm,
        admin,
        collection,
        delivery_receiver,
        recipients,
        payer,
    }
}

fn instruction<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction {
        program_id: box_minter::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

fn transaction(svm: &LiteSVM, payer: Pubkey, instructions: &[Instruction]) -> Transaction {
    Transaction::new_unsigned(Message::new_with_blockhash(
        instructions,
        Some(&payer),
        &svm.latest_blockhash(),
    ))
}

fn send(harness: &mut Harness, payer: Pubkey, ix: Instruction) {
    let tx = transaction(&harness.svm, payer, &[ix]);
    harness.svm.send_transaction(tx).unwrap();
}

fn send_admin(harness: &mut Harness, ix: Instruction) {
    let admin = harness.admin;
    send(harness, admin, ix);
}

fn send_payer(harness: &mut Harness, ix: Instruction) {
    let payer = harness.payer;
    send(harness, payer, ix);
}

fn send_error(harness: &mut Harness, payer: Pubkey, ix: Instruction) -> FailedTransactionMetadata {
    let tx = transaction(&harness.svm, payer, &[ix]);
    harness.svm.send_transaction(tx).unwrap_err()
}

fn assert_error_contains(error: &FailedTransactionMetadata, expected: &str) {
    assert!(
        error.meta.logs.iter().any(|line| line.contains(expected)),
        "missing {expected:?} in logs: {:#?}",
        error.meta.logs
    );
}

fn balance(harness: &Harness, key: Pubkey) -> u64 {
    harness.svm.get_account(&key).unwrap().lamports
}

fn config_account(harness: &Harness, config: Pubkey) -> Account {
    harness.svm.get_account(&config).unwrap()
}

fn config_state(harness: &Harness, config: Pubkey) -> BoxMinterConfig {
    let account = config_account(harness, config);
    BoxMinterConfig::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn initialize_args(
    drop_seed: [u8; 32],
    discount_payer: Pubkey,
    variant: bool,
    name_prefix: &str,
) -> InitializeArgs {
    InitializeArgs {
        price_lamports: 69_000_000,
        discount_price_lamports: 10_000_000,
        discount_merkle_root: hashv(&[discount_payer.as_ref()]).to_bytes(),
        max_supply: if variant { 6 } else { 10 },
        max_per_tx: 3,
        items_per_box: if variant { 0 } else { 1 },
        name_prefix: name_prefix.to_string(),
        symbol: "MONS".to_string(),
        uri_base: "https://assets.mons.link/runtime".to_string(),
        discount_mints_per_wallet: 3,
        figure_name_prefix: "dude".to_string(),
        mint_variant_kind: u8::from(variant),
        mint_variant_start_ids: if variant { [1, 3, 5] } else { [0; 3] },
        mint_variant_end_ids: if variant { [2, 4, 6] } else { [0; 3] },
        mint_variant_next_ids: if variant { [1, 3, 5] } else { [0; 3] },
        drop_seed,
    }
}

fn clear_cards_split_args(recipients: [Pubkey; 3]) -> SplitPaymentsV1Args {
    SplitPaymentsV1Args {
        recipient_count: 2,
        recipients: [recipients[0], recipients[1], Pubkey::default()],
        percentages: [70, 30, 0],
    }
}

fn three_recipient_split_args(recipients: [Pubkey; 3]) -> SplitPaymentsV1Args {
    SplitPaymentsV1Args {
        recipient_count: 3,
        recipients,
        percentages: [70, 20, 10],
    }
}

fn initialize_split_with_args(
    harness: &mut Harness,
    seed_byte: u8,
    variant: bool,
    name_prefix: &str,
    discount_payer: Pubkey,
    split_args: SplitPaymentsV1Args,
) -> ConfigFixture {
    let drop_seed = [seed_byte; 32];
    let (key, _) = Pubkey::find_program_address(
        &[BoxMinterConfig::SEED, drop_seed.as_ref()],
        &box_minter::ID,
    );
    let ix = instruction(
        box_minter::accounts::Initialize {
            config: key,
            admin: harness.admin,
            treasury: harness.delivery_receiver,
            core_collection: harness.collection,
            system_program: system_program::ID,
        },
        box_minter::instruction::InitializeSplitPaymentsV1 {
            args: initialize_args(drop_seed, discount_payer, variant, name_prefix),
            split_args,
        },
    );
    send(harness, harness.admin, ix);
    ConfigFixture { key, drop_seed }
}

fn initialize_split(
    harness: &mut Harness,
    seed_byte: u8,
    variant: bool,
    name_prefix: &str,
    discount_payer: Pubkey,
) -> ConfigFixture {
    initialize_split_with_args(
        harness,
        seed_byte,
        variant,
        name_prefix,
        discount_payer,
        clear_cards_split_args(harness.recipients),
    )
}

fn initialize_legacy(harness: &mut Harness, seed_byte: u8, treasury: Pubkey) -> ConfigFixture {
    let drop_seed = [seed_byte; 32];
    let (key, _) = Pubkey::find_program_address(
        &[BoxMinterConfig::SEED, drop_seed.as_ref()],
        &box_minter::ID,
    );
    let ix = instruction(
        box_minter::accounts::Initialize {
            config: key,
            admin: harness.admin,
            treasury,
            core_collection: harness.collection,
            system_program: system_program::ID,
        },
        box_minter::instruction::Initialize {
            args: initialize_args(drop_seed, harness.payer, false, "box"),
        },
    );
    send(harness, harness.admin, ix);
    ConfigFixture { key, drop_seed }
}

fn start_mint(harness: &mut Harness, config: ConfigFixture) {
    let ix = instruction(
        box_minter::accounts::StartMint {
            config: config.key,
            admin: harness.admin,
        },
        box_minter::instruction::StartMint {},
    );
    send(harness, harness.admin, ix);
}

fn set_treasury_ix(harness: &Harness, config: Pubkey, treasury: Pubkey) -> Instruction {
    instruction(
        box_minter::accounts::SetTreasury {
            config,
            admin: harness.admin,
        },
        box_minter::instruction::SetTreasury { treasury },
    )
}

fn asset(config: Pubkey, payer: Pubkey, mint_id: u64, index: u8) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"box",
            config.as_ref(),
            payer.as_ref(),
            &mint_id.to_le_bytes(),
            &[index],
        ],
        &box_minter::ID,
    )
}

fn discount_record(config: Pubkey, payer: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"discount", config.as_ref(), payer.as_ref()],
        &box_minter::ID,
    )
    .0
}

fn append_remaining(ix: &mut Instruction, assets: &[Pubkey], recipients: &[(Pubkey, bool)]) {
    ix.accounts
        .extend(assets.iter().map(|key| AccountMeta::new(*key, false)));
    ix.accounts.extend(recipients.iter().map(|(key, writable)| {
        if *writable {
            AccountMeta::new(*key, false)
        } else {
            AccountMeta::new_readonly(*key, false)
        }
    }));
}

fn split_recipient_metas(harness: &Harness) -> Vec<(Pubkey, bool)> {
    harness
        .recipients
        .iter()
        .take(2)
        .copied()
        .map(|key| (key, true))
        .collect()
}

fn three_recipient_metas(harness: &Harness) -> Vec<(Pubkey, bool)> {
    harness
        .recipients
        .iter()
        .copied()
        .map(|key| (key, true))
        .collect()
}

fn mint_boxes_ix(
    harness: &Harness,
    config: Pubkey,
    payer: Pubkey,
    quantity: u8,
    mint_id: u64,
    recipients: &[(Pubkey, bool)],
) -> Instruction {
    let assets: Vec<(Pubkey, u8)> = (0..quantity)
        .map(|index| asset(config, payer, mint_id, index))
        .collect();
    let mut ix = instruction(
        box_minter::accounts::MintBoxes {
            config,
            payer,
            treasury: harness.delivery_receiver,
            core_collection: harness.collection,
            mpl_core_program: MPL_CORE_ID,
            system_program: system_program::ID,
        },
        box_minter::instruction::MintBoxes {
            quantity,
            mint_id,
            box_bumps: assets.iter().map(|(_, bump)| *bump).collect(),
        },
    );
    append_remaining(
        &mut ix,
        &assets.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
        recipients,
    );
    ix
}

fn mint_variant_ix(
    harness: &Harness,
    config: Pubkey,
    payer: Pubkey,
    variant_index: u8,
    mint_id: u64,
) -> Instruction {
    let (asset, bump) = asset(config, payer, mint_id, 0);
    let mut ix = instruction(
        box_minter::accounts::MintBoxes {
            config,
            payer,
            treasury: harness.delivery_receiver,
            core_collection: harness.collection,
            mpl_core_program: MPL_CORE_ID,
            system_program: system_program::ID,
        },
        box_minter::instruction::MintVariantBox {
            variant_index,
            mint_id,
            box_bump: bump,
        },
    );
    append_remaining(&mut ix, &[asset], &split_recipient_metas(harness));
    ix
}

fn mint_discounted_ix(
    harness: &Harness,
    config: Pubkey,
    payer: Pubkey,
    quantity: u8,
    mint_id: u64,
) -> Instruction {
    let assets: Vec<(Pubkey, u8)> = (0..quantity)
        .map(|index| asset(config, payer, mint_id, index))
        .collect();
    let mut ix = instruction(
        box_minter::accounts::MintDiscountedBox {
            config,
            payer,
            discount_record: discount_record(config, payer),
            treasury: harness.delivery_receiver,
            core_collection: harness.collection,
            mpl_core_program: MPL_CORE_ID,
            system_program: system_program::ID,
        },
        box_minter::instruction::MintDiscountedBox {
            mint_id,
            box_bumps: assets.iter().map(|(_, bump)| *bump).collect(),
            proof: Vec::new(),
        },
    );
    append_remaining(
        &mut ix,
        &assets.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
        &split_recipient_metas(harness),
    );
    ix
}

fn mint_discounted_variant_ix(
    harness: &Harness,
    config: Pubkey,
    payer: Pubkey,
    variant_index: u8,
    mint_id: u64,
) -> Instruction {
    let (asset, bump) = asset(config, payer, mint_id, 0);
    let mut ix = instruction(
        box_minter::accounts::MintDiscountedBox {
            config,
            payer,
            discount_record: discount_record(config, payer),
            treasury: harness.delivery_receiver,
            core_collection: harness.collection,
            mpl_core_program: MPL_CORE_ID,
            system_program: system_program::ID,
        },
        box_minter::instruction::MintDiscountedVariantBox {
            variant_index,
            mint_id,
            box_bump: bump,
            proof: Vec::new(),
        },
    );
    append_remaining(&mut ix, &[asset], &split_recipient_metas(harness));
    ix
}

fn assert_recipient_delta(harness: &Harness, before: [u64; 3], expected: [u64; 3]) {
    let after = harness.recipients.map(|key| balance(harness, key));
    assert_eq!(
        [
            after[0] - before[0],
            after[1] - before[1],
            after[2] - before[2],
        ],
        expected
    );
}

fn expected_tail(split_args: &SplitPaymentsV1Args) -> Vec<u8> {
    let mut tail = vec![0; SPLIT_TAIL_SPACE];
    tail[..8].copy_from_slice(b"MONSPAY\0");
    tail[8] = 1;
    tail[9] = split_args.recipient_count;
    for (index, recipient) in split_args.recipients.iter().enumerate() {
        let start = 10 + index * 32;
        tail[start..start + 32].copy_from_slice(recipient.as_ref());
    }
    tail[106..109].copy_from_slice(&split_args.percentages);
    tail
}

#[test]
fn split_initialize_setter_delivery_and_legacy_compatibility() {
    let mut harness = new_harness();
    let payer = harness.payer;
    let split = initialize_split(&mut harness, 1, false, "box", payer);
    let initial_account = config_account(&harness, split.key);
    assert_eq!(initial_account.data.len(), SPLIT_CONFIG_SPACE);
    assert_eq!(
        initial_account.lamports,
        harness
            .svm
            .minimum_balance_for_rent_exemption(SPLIT_CONFIG_SPACE)
    );
    assert_eq!(
        &initial_account.data[CONFIG_SPACE..],
        expected_tail(&clear_cards_split_args(harness.recipients)).as_slice()
    );
    let state = config_state(&harness, split.key);
    assert_eq!(state.drop_seed, split.drop_seed);
    assert_eq!(state.treasury, harness.delivery_receiver);

    let tail_before = initial_account.data[CONFIG_SPACE..].to_vec();
    let default_ix = set_treasury_ix(&harness, split.key, Pubkey::default());
    let admin = harness.admin;
    let default_error = send_error(&mut harness, admin, default_ix);
    assert_error_contains(&default_error, "InvalidDeliveryReceiver");
    assert_eq!(
        config_state(&harness, split.key).treasury,
        harness.delivery_receiver
    );

    let replacement = Pubkey::new_unique();
    harness
        .svm
        .set_account(replacement, system_account(1_000_000))
        .unwrap();
    let replacement_ix = set_treasury_ix(&harness, split.key, replacement);
    send_admin(&mut harness, replacement_ix);
    assert_eq!(config_state(&harness, split.key).treasury, replacement);
    assert_eq!(
        &config_account(&harness, split.key).data[CONFIG_SPACE..],
        tail_before.as_slice()
    );

    let mut frozen = config_account(&harness, split.key);
    frozen.data[TREASURY_OFFSET..TREASURY_OFFSET + 32].fill(0);
    frozen.data[SPLIT_CONFIG_SPACE - 1] = 9;
    let malformed_tail = frozen.data[CONFIG_SPACE..].to_vec();
    harness.svm.set_account(split.key, frozen).unwrap();
    assert_eq!(
        config_state(&harness, split.key).treasury,
        Pubkey::default()
    );
    let recovery_ix = set_treasury_ix(&harness, split.key, replacement);
    send_admin(&mut harness, recovery_ix);
    assert_eq!(config_state(&harness, split.key).treasury, replacement);
    assert_eq!(
        &config_account(&harness, split.key).data[CONFIG_SPACE..],
        malformed_tail.as_slice()
    );

    let delivery_split = initialize_split(&mut harness, 8, false, "box", payer);
    let delivery_tail = config_account(&harness, delivery_split.key).data[CONFIG_SPACE..].to_vec();
    let delivery_payer = Pubkey::new_unique();
    harness
        .svm
        .set_account(delivery_payer, system_account(10_000_000_000))
        .unwrap();
    let delivered_asset = Pubkey::new_unique();
    harness
        .svm
        .set_account(delivered_asset, system_account(1_000_000))
        .unwrap();
    let delivery_id = 77u32;
    let (delivery, delivery_bump) = Pubkey::find_program_address(
        &[
            b"delivery",
            delivery_split.key.as_ref(),
            &delivery_id.to_le_bytes(),
        ],
        &box_minter::ID,
    );
    let delivery_fee = 25_000_000u64;
    let delivery_before = balance(&harness, harness.delivery_receiver);
    let recipient_before = harness.recipients.map(|key| balance(&harness, key));
    let mut deliver_ix = instruction(
        box_minter::accounts::Deliver {
            config: delivery_split.key,
            cosigner: harness.admin,
            payer: delivery_payer,
            treasury: harness.delivery_receiver,
            core_collection: harness.collection,
            mpl_core_program: MPL_CORE_ID,
            system_program: system_program::ID,
            log_wrapper: SPL_NOOP_ID,
            delivery,
        },
        box_minter::instruction::Deliver {
            args: DeliverArgs {
                delivery_id,
                delivery_fee_lamports: delivery_fee,
                delivery_bump,
            },
        },
    );
    deliver_ix
        .accounts
        .push(AccountMeta::new(delivered_asset, false));
    send(&mut harness, delivery_payer, deliver_ix);
    assert_eq!(
        balance(&harness, harness.delivery_receiver) - delivery_before,
        delivery_fee
    );
    assert_eq!(
        harness.recipients.map(|key| balance(&harness, key)),
        recipient_before
    );
    let delivery_account = harness.svm.get_account(&delivery).unwrap();
    let record = DeliveryRecord::try_deserialize(&mut delivery_account.data.as_slice()).unwrap();
    assert_eq!(record.payer, delivery_payer);
    assert_eq!(record.delivery_fee_lamports, delivery_fee);
    assert_eq!(record.item_count, 1);
    assert_eq!(
        &config_account(&harness, delivery_split.key).data[CONFIG_SPACE..],
        delivery_tail.as_slice()
    );

    let legacy_treasury = Pubkey::new_unique();
    harness
        .svm
        .set_account(legacy_treasury, system_account(1_000_000))
        .unwrap();
    let legacy = initialize_legacy(&mut harness, 2, legacy_treasury);
    assert_eq!(
        config_account(&harness, legacy.key).data.len(),
        CONFIG_SPACE
    );
    let legacy_default_ix = set_treasury_ix(&harness, legacy.key, Pubkey::default());
    send_admin(&mut harness, legacy_default_ix);
    assert_eq!(
        config_state(&harness, legacy.key).treasury,
        Pubkey::default()
    );
}

#[test]
fn all_four_mint_paths_route_current_clear_cards_allocations() {
    let mut harness = new_harness();
    let payer = harness.payer;
    let standard = initialize_split(&mut harness, 3, false, "box", payer);
    let variant = initialize_split(&mut harness, 4, true, "box", payer);
    start_mint(&mut harness, standard);
    start_mint(&mut harness, variant);

    let mint_before = harness.recipients.map(|key| balance(&harness, key));
    let mint_ix = mint_boxes_ix(
        &harness,
        standard.key,
        harness.payer,
        1,
        1001,
        &split_recipient_metas(&harness),
    );
    send_payer(&mut harness, mint_ix);
    assert_recipient_delta(&harness, mint_before, [48_300_000, 20_700_000, 0]);

    let discounted_before = harness.recipients.map(|key| balance(&harness, key));
    let discounted_ix = mint_discounted_ix(&harness, standard.key, harness.payer, 1, 1002);
    send_payer(&mut harness, discounted_ix);
    assert_recipient_delta(&harness, discounted_before, [7_000_000, 3_000_000, 0]);

    let variant_before = harness.recipients.map(|key| balance(&harness, key));
    let variant_ix = mint_variant_ix(&harness, variant.key, harness.payer, 0, 1003);
    send_payer(&mut harness, variant_ix);
    assert_recipient_delta(&harness, variant_before, [48_300_000, 20_700_000, 0]);

    let discounted_variant_before = harness.recipients.map(|key| balance(&harness, key));
    let discounted_variant_ix =
        mint_discounted_variant_ix(&harness, variant.key, harness.payer, 1, 1004);
    send_payer(&mut harness, discounted_variant_ix);
    assert_recipient_delta(
        &harness,
        discounted_variant_before,
        [7_000_000, 3_000_000, 0],
    );

    assert_eq!(config_state(&harness, standard.key).minted, 2);
    assert_eq!(config_state(&harness, variant.key).minted, 2);
}

#[test]
fn three_recipient_split_route_remains_supported() {
    let mut harness = new_harness();
    let payer = harness.payer;
    let split_args = three_recipient_split_args(harness.recipients);
    let split =
        initialize_split_with_args(&mut harness, 9, false, "box", payer, split_args.clone());
    assert_eq!(
        &config_account(&harness, split.key).data[CONFIG_SPACE..],
        expected_tail(&split_args).as_slice()
    );
    start_mint(&mut harness, split);

    let before = harness.recipients.map(|key| balance(&harness, key));
    let mint_ix = mint_boxes_ix(
        &harness,
        split.key,
        harness.payer,
        1,
        4001,
        &three_recipient_metas(&harness),
    );
    send_payer(&mut harness, mint_ix);
    assert_recipient_delta(&harness, before, [48_300_000, 13_800_000, 6_900_000]);
}

#[test]
fn split_mints_fail_closed_on_missing_wrong_and_readonly_recipients() {
    let mut harness = new_harness();
    let payer = harness.payer;
    let split = initialize_split(&mut harness, 5, false, "box", payer);
    start_mint(&mut harness, split);
    let initial_balances = harness.recipients.map(|key| balance(&harness, key));

    let old_client = mint_boxes_ix(&harness, split.key, harness.payer, 1, 2000, &[]);
    let old_client_error = send_error(&mut harness, payer, old_client);
    assert_error_contains(&old_client_error, "InvalidRemainingAccounts");

    let missing = mint_boxes_ix(
        &harness,
        split.key,
        harness.payer,
        1,
        2001,
        &split_recipient_metas(&harness)[..1],
    );
    let missing_error = send_error(&mut harness, payer, missing);
    assert_error_contains(&missing_error, "InvalidRemainingAccounts");

    let mut wrong = split_recipient_metas(&harness);
    wrong.swap(0, 1);
    let wrong_ix = mint_boxes_ix(&harness, split.key, harness.payer, 1, 2002, &wrong);
    let wrong_error = send_error(&mut harness, payer, wrong_ix);
    assert_error_contains(&wrong_error, "InvalidSplitPaymentsRecipients");

    let mut readonly = split_recipient_metas(&harness);
    readonly[0].1 = false;
    let readonly_ix = mint_boxes_ix(&harness, split.key, harness.payer, 1, 2003, &readonly);
    let readonly_error = send_error(&mut harness, payer, readonly_ix);
    assert_error_contains(&readonly_error, "InvalidSplitPaymentsRecipients");

    assert_eq!(
        harness.recipients.map(|key| balance(&harness, key)),
        initial_balances
    );
    assert_eq!(config_state(&harness, split.key).minted, 0);

    let legacy_treasury = Pubkey::new_unique();
    harness
        .svm
        .set_account(legacy_treasury, system_account(1_000_000))
        .unwrap();
    let legacy = initialize_legacy(&mut harness, 6, legacy_treasury);
    start_mint(&mut harness, legacy);
    let treasury_before = balance(&harness, legacy_treasury);
    let (legacy_asset, legacy_bump) = asset(legacy.key, harness.payer, 2004, 0);
    let mut legacy_ix = instruction(
        box_minter::accounts::MintBoxes {
            config: legacy.key,
            payer: harness.payer,
            treasury: legacy_treasury,
            core_collection: harness.collection,
            mpl_core_program: MPL_CORE_ID,
            system_program: system_program::ID,
        },
        box_minter::instruction::MintBoxes {
            quantity: 1,
            mint_id: 2004,
            box_bumps: vec![legacy_bump],
        },
    );
    legacy_ix
        .accounts
        .push(AccountMeta::new(legacy_asset, false));
    send_payer(&mut harness, legacy_ix);
    assert_eq!(
        balance(&harness, legacy_treasury) - treasury_before,
        69_000_000
    );
}

#[test]
fn late_second_mint_failure_rolls_back_payments_config_record_and_prefund_sweep() {
    let mut harness = new_harness();
    let payer = harness.payer;
    let rollback = initialize_split(&mut harness, 7, false, "rollback", payer);
    start_mint(&mut harness, rollback);
    let mint_id = 3001u64;
    let (prefunded_asset, _) = asset(rollback.key, harness.payer, mint_id, 0);
    harness
        .svm
        .set_account(prefunded_asset, system_account(2_000_000))
        .unwrap();

    let config_before = config_account(&harness, rollback.key);
    let payer_before = balance(&harness, harness.payer);
    let recipients_before = harness.recipients.map(|key| balance(&harness, key));
    let delivery_before = balance(&harness, harness.delivery_receiver);
    let discount = discount_record(rollback.key, harness.payer);
    assert!(harness.svm.get_account(&discount).is_none());

    let rollback_ix = mint_discounted_ix(&harness, rollback.key, harness.payer, 2, mint_id);
    let error = send_error(&mut harness, payer, rollback_ix);
    assert!(matches!(
        error.err,
        solana_sdk::transaction::TransactionError::InstructionError(
            _,
            InstructionError::Custom(0x5242)
        )
    ));

    let config_after = config_account(&harness, rollback.key);
    assert_eq!(config_after.data, config_before.data);
    assert_eq!(config_after.lamports, config_before.lamports);
    assert_eq!(payer_before - balance(&harness, harness.payer), 5_000);
    assert_eq!(
        harness.recipients.map(|key| balance(&harness, key)),
        recipients_before
    );
    assert_eq!(
        balance(&harness, harness.delivery_receiver),
        delivery_before
    );
    assert_eq!(balance(&harness, prefunded_asset), 2_000_000);
    assert!(harness.svm.get_account(&discount).is_none());
}
