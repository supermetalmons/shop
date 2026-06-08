use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::program::invoke_signed;
use core::fmt::Write;
use solana_sha256_hasher::hashv;

declare_id!("7h4JRc5vELpaahm11AeshFEQHe1jePauRnMFWaPSRNpV");

/// The only signer allowed to run `initialize()`.
///
/// This prevents a permissionless first-initializer from permanently taking over a drop config
/// PDA (`seeds = [b"config", drop_seed]`).
const EXPECTED_INITIALIZER: Pubkey = pubkey!("kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx");

// Uncompressed Core NFTs are much heavier than cNFTs, but they don't require proofs.
// Keep conservative caps to avoid compute/tx-size failures.
// NOTE: Uncompressed Core mints are expensive; keep this reasonably low.
const MAX_SAFE_MINTS_PER_TX: u8 = 15;
// Delivery is mostly limited by tx size; keep this high enough to not be the limiting factor.
const MAX_SAFE_DELIVERY_ITEMS_PER_TX: u8 = 32;
const MIN_DISCOUNT_MINTS_PER_WALLET: u8 = 1;
const MAX_DISCOUNT_MINTS_PER_WALLET: u8 = 3;

const MIN_ITEMS_PER_BOX: u8 = 0;
const MIN_OPENABLE_ITEMS_PER_BOX: u8 = 1;
// Keep this conservative: start_open_box + finalize_open_box do multiple MPL-Core CPIs per figure.
const MAX_ITEMS_PER_BOX: u8 = 5;
const MINT_VARIANT_OPTION_COUNT: usize = 3;
const MINT_VARIANT_KIND_NONE: u8 = 0;
const MINT_VARIANT_KIND_SIZE: u8 = 1;

// Asset PDA namespaces (owned by mpl-core; signed for via our program).
const SEED_BOX_ASSET: &[u8] = b"box";
const SEED_DELIVERY: &[u8] = b"delivery";
const SEED_ADMIN_ORDER: &[u8] = b"admin_order";
// Pending (two-step) box open flow.
const SEED_PENDING_OPEN: &[u8] = b"open";
const SEED_PENDING_DUDE_ASSET: &[u8] = b"pdude";
const SEED_DISCOUNT_MINT: &[u8] = b"discount";

// Metaplex Core program id.
const MPL_CORE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    175, 84, 171, 16, 189, 151, 165, 66, 160, 158, 247, 179, 152, 137, 221, 12, 211, 148, 164, 204,
    233, 223, 166, 205, 201, 126, 190, 45, 35, 91, 167, 72,
]);

// SPL Noop program id (MPL-Core log wrapper).
const SPL_NOOP_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    11, 188, 15, 192, 187, 71, 202, 47, 116, 196, 17, 46, 148, 171, 19, 207, 163, 198, 52, 229,
    220, 23, 234, 203, 3, 205, 26, 35, 205, 126, 120, 124,
]);

// Metaplex Noop program id (Bubblegum v2 log wrapper).
const MPL_NOOP_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    11, 121, 89, 138, 15, 175, 40, 176, 251, 210, 37, 99, 35, 51, 65, 75, 208, 58, 171, 36, 15,
    112, 50, 209, 222, 71, 87, 160, 172, 93, 198, 6,
]);

// Metaplex Account Compression program id (used by Bubblegum v2).
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    11, 110, 1, 83, 35, 73, 37, 196, 7, 241, 129, 86, 118, 252, 211, 44, 245, 164, 143, 110, 139,
    22, 153, 55, 86, 36, 187, 205, 94, 20, 114, 203,
]);

// Metaplex Bubblegum v2 program id.
const BUBBLEGUM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    152, 139, 128, 235, 121, 53, 40, 105, 178, 36, 116, 95, 89, 221, 191, 138, 38, 88, 202, 19,
    220, 104, 129, 33, 38, 53, 28, 174, 7, 193, 165, 165,
]);

// Bubblegum -> MPL-Core CPI signer (fixed address).
const MPL_CORE_CPI_SIGNER: Pubkey = Pubkey::new_from_array([
    172, 62, 167, 81, 182, 229, 187, 148, 54, 215, 103, 188, 191, 118, 136, 109, 246, 185, 148, 74,
    208, 130, 94, 187, 44, 164, 169, 205, 130, 57, 140, 171,
]);

// Bubblegum v2 mint discriminator: [120, 121, 23, 146, 173, 110, 199, 205]
const IX_BUBBLEGUM_MINT_V2: [u8; 8] = [120, 121, 23, 146, 173, 110, 199, 205];

// URI path prefixes appended to the configured DROP BASE (`config.uri_base`).
// Kept as `&'static str` so we can avoid allocating derived base Strings on the SBF heap.
const URI_PREFIX_BOXES: &str = "/b";
const URI_PREFIX_FIGURES: &str = "/f";
const URI_PREFIX_RECEIPTS_FIGURES: &str = "/rf";
const URI_PREFIX_RECEIPTS_BOXES: &str = "/rb";
const RECEIPT_NAME_PREFIX: &str = "receipt · ";

fn hash_leaf(data: &[u8]) -> [u8; 32] {
    hashv(&[data]).to_bytes()
}

fn hash_sorted_pair(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let (a, b) = if left <= right {
        (left, right)
    } else {
        (right, left)
    };
    hashv(&[a.as_ref(), b.as_ref()]).to_bytes()
}

fn has_any_non_zero_byte(data: &[u8]) -> bool {
    data.iter().any(|b| *b != 0)
}

fn verify_merkle_proof(leaf: &[u8], proof: &[[u8; 32]], root: [u8; 32]) -> bool {
    let mut node = hash_leaf(leaf);
    for sibling in proof {
        node = hash_sorted_pair(node, *sibling);
    }
    node == root
}

fn validate_metadata_base(drop_base: &str) -> Result<()> {
    require!(!drop_base.is_empty(), BoxMinterError::InvalidMetadataBase);
    require!(
        drop_base.starts_with("https://")
            || drop_base.starts_with("http://")
            || drop_base.starts_with("ipfs://"),
        BoxMinterError::InvalidMetadataBase
    );
    let lower_drop_base = drop_base.to_ascii_lowercase();
    require!(
        !lower_drop_base.ends_with(".json")
            && !lower_drop_base.contains("/json/boxes")
            && !lower_drop_base.contains("/json/figures")
            && !lower_drop_base.contains("/json/receipts")
            && !drop_base.contains('?')
            && !drop_base.contains('#'),
        BoxMinterError::InvalidMetadataBase
    );
    Ok(())
}

fn validate_mint_prices(price_lamports: u64, discount_price_lamports: u64) -> Result<()> {
    require!(price_lamports > 0, BoxMinterError::InvalidPrice);
    require!(
        discount_price_lamports > 0,
        BoxMinterError::InvalidDiscountPrice
    );
    require!(
        discount_price_lamports <= price_lamports,
        BoxMinterError::InvalidDiscountPrice
    );
    Ok(())
}

struct MintBoxesInnerAccounts<'info> {
    payer: AccountInfo<'info>,
    treasury: AccountInfo<'info>,
    core_collection: AccountInfo<'info>,
    mpl_core_program: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
}

impl<'info> MintBoxesInnerAccounts<'info> {
    fn new(
        payer: AccountInfo<'info>,
        treasury: AccountInfo<'info>,
        core_collection: AccountInfo<'info>,
        mpl_core_program: AccountInfo<'info>,
        system_program: AccountInfo<'info>,
    ) -> Self {
        Self {
            payer,
            treasury,
            core_collection,
            mpl_core_program,
            system_program,
        }
    }

    fn from_mint_boxes(accounts: &MintBoxes<'info>) -> Self {
        Self::new(
            accounts.payer.to_account_info(),
            accounts.treasury.to_account_info(),
            accounts.core_collection.to_account_info(),
            accounts.mpl_core_program.to_account_info(),
            accounts.system_program.to_account_info(),
        )
    }

    fn from_discounted_box(accounts: &MintDiscountedBox<'info>) -> Self {
        Self::new(
            accounts.payer.to_account_info(),
            accounts.treasury.to_account_info(),
            accounts.core_collection.to_account_info(),
            accounts.mpl_core_program.to_account_info(),
            accounts.system_program.to_account_info(),
        )
    }
}

struct MintBoxAssetBuffers {
    name_buf: String,
    uri_buf: String,
    create_ix: Instruction,
}

fn charge_mint_payment<'info>(
    accounts: &MintBoxesInnerAccounts<'info>,
    unit_price_lamports: u64,
    quantity: u8,
) -> Result<()> {
    let cost = (unit_price_lamports as u128)
        .checked_mul(quantity as u128)
        .ok_or(BoxMinterError::MathOverflow)?;
    require!(cost <= u64::MAX as u128, BoxMinterError::MathOverflow);
    let cost_u64 = cost as u64;
    if cost_u64 > 0 {
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &accounts.payer.key(),
            &accounts.treasury.key(),
            cost_u64,
        );
        invoke(
            &ix,
            &[
                accounts.payer.clone(),
                accounts.treasury.clone(),
                accounts.system_program.clone(),
            ],
        )?;
    }
    Ok(())
}

fn new_mint_box_asset_buffers<'info>(
    cfg: &Account<'info, BoxMinterConfig>,
    accounts: &MintBoxesInnerAccounts<'info>,
) -> MintBoxAssetBuffers {
    let drop_base = cfg.uri_base.as_str();
    let max_uri_len: usize = drop_base.len() + URI_PREFIX_BOXES.len() + 16;
    let cfg_ai = cfg.to_account_info();

    let mut create_ix = Instruction {
        program_id: MPL_CORE_PROGRAM_ID,
        accounts: Vec::with_capacity(8),
        data: Vec::with_capacity(
            1 // discriminator
                + 1 // data_state
                + 4 + (BoxMinterConfig::MAX_NAME_PREFIX + 12) // name
                + 4 + max_uri_len // uri (dynamic based on derived prefix)
                + 1, // plugins option
        ),
    };
    create_ix
        .accounts
        .push(AccountMeta::new(Pubkey::default(), true)); // asset (placeholder)
    create_ix
        .accounts
        .push(AccountMeta::new(accounts.core_collection.key(), false)); // collection
    create_ix
        .accounts
        .push(AccountMeta::new_readonly(cfg_ai.key(), true)); // authority
    create_ix
        .accounts
        .push(AccountMeta::new(accounts.payer.key(), true)); // payer
    create_ix
        .accounts
        .push(AccountMeta::new_readonly(accounts.payer.key(), false)); // owner
    create_ix
        .accounts
        .push(AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false)); // update_authority: None (placeholder)
    create_ix.accounts.push(AccountMeta::new_readonly(
        accounts.system_program.key(),
        false,
    )); // system_program
    create_ix
        .accounts
        .push(AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false)); // log_wrapper: None (placeholder)

    MintBoxAssetBuffers {
        name_buf: String::with_capacity(BoxMinterConfig::MAX_NAME_PREFIX + 12),
        uri_buf: String::with_capacity(max_uri_len),
        create_ix,
    }
}

fn mint_one_box_asset<'info>(
    cfg: &Account<'info, BoxMinterConfig>,
    accounts: &MintBoxesInnerAccounts<'info>,
    asset_ai: &AccountInfo<'info>,
    program_id: &Pubkey,
    mint_id: u64,
    asset_seed_index: u8,
    asset_bump: u8,
    metadata_id: u32,
    buffers: &mut MintBoxAssetBuffers,
) -> Result<()> {
    let payer_key = accounts.payer.key();
    let config_key = cfg.key();
    let mint_id_bytes = mint_id.to_le_bytes();
    let i_seed = [asset_seed_index];
    let asset_bump_bytes = [asset_bump];
    let expected = Pubkey::create_program_address(
        &[
            SEED_BOX_ASSET,
            config_key.as_ref(),
            payer_key.as_ref(),
            &mint_id_bytes,
            &i_seed,
            &asset_bump_bytes,
        ],
        program_id,
    )
    .map_err(|_| error!(BoxMinterError::InvalidAssetPda))?;

    require_keys_eq!(asset_ai.key(), expected, BoxMinterError::InvalidAssetPda);
    require_keys_eq!(
        *asset_ai.owner,
        anchor_lang::solana_program::system_program::ID,
        BoxMinterError::InvalidAssetPda
    );

    let asset_seeds: &[&[u8]] = &[
        SEED_BOX_ASSET,
        config_key.as_ref(),
        payer_key.as_ref(),
        &mint_id_bytes,
        &i_seed,
        &asset_bump_bytes,
    ];
    let prefund_lamports = asset_ai.lamports();
    if prefund_lamports > 0 {
        let sweep_ix = anchor_lang::solana_program::system_instruction::transfer(
            asset_ai.key,
            &accounts.payer.key(),
            prefund_lamports,
        );
        invoke_signed(
            &sweep_ix,
            &[
                asset_ai.clone(),
                accounts.payer.clone(),
                accounts.system_program.clone(),
            ],
            &[asset_seeds],
        )
        .map_err(anchor_lang::error::Error::from)?;
    }

    buffers.name_buf.clear();
    append_label_and_id(&mut buffers.name_buf, &cfg.name_prefix, metadata_id)?;

    buffers.uri_buf.clear();
    buffers.uri_buf.push_str(cfg.uri_base.as_str());
    buffers.uri_buf.push_str(URI_PREFIX_BOXES);
    write!(&mut buffers.uri_buf, "{}", metadata_id)
        .map_err(|_| error!(BoxMinterError::SerializationFailed))?;
    buffers.uri_buf.push_str(".json");

    let cfg_bump = cfg.bump;
    let cfg_bump_bytes = [cfg_bump];
    let cfg_signer_seeds: &[&[u8]] = &[
        BoxMinterConfig::SEED,
        cfg.drop_seed.as_ref(),
        &cfg_bump_bytes,
    ];
    let signer_seeds: &[&[&[u8]]] = &[cfg_signer_seeds, asset_seeds];

    buffers.create_ix.accounts[0].pubkey = asset_ai.key();
    buffers.create_ix.data.clear();
    buffers.create_ix.data.push(0); // CreateV1 discriminator
    buffers.create_ix.data.push(0); // DataState::AccountState
    buffers
        .create_ix
        .data
        .extend_from_slice(&(buffers.name_buf.len() as u32).to_le_bytes());
    buffers
        .create_ix
        .data
        .extend_from_slice(buffers.name_buf.as_bytes());
    buffers
        .create_ix
        .data
        .extend_from_slice(&(buffers.uri_buf.len() as u32).to_le_bytes());
    buffers
        .create_ix
        .data
        .extend_from_slice(buffers.uri_buf.as_bytes());
    buffers.create_ix.data.push(0); // plugins: None

    let cfg_ai = cfg.to_account_info();
    let cpi_infos = [
        accounts.mpl_core_program.clone(),
        asset_ai.clone(),
        accounts.core_collection.clone(),
        cfg_ai,
        accounts.payer.clone(),
        accounts.payer.clone(),
        accounts.system_program.clone(),
    ];
    invoke_signed(&buffers.create_ix, &cpi_infos, signer_seeds)
        .map_err(anchor_lang::error::Error::from)?;
    Ok(())
}

fn mint_standard_boxes_inner<'info>(
    cfg: &mut Account<'info, BoxMinterConfig>,
    accounts: &MintBoxesInnerAccounts<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    quantity: u8,
    mint_id: u64,
    box_bumps: Vec<u8>,
    program_id: &Pubkey,
    unit_price_lamports: u64,
) -> Result<()> {
    // Early fail-fast: do not allow minting until the admin explicitly starts the program.
    require!(cfg.started, BoxMinterError::MintNotStarted);

    require_keys_eq!(
        accounts.mpl_core_program.key(),
        MPL_CORE_PROGRAM_ID,
        BoxMinterError::InvalidMplCoreProgram
    );
    require!(
        !cfg.requires_variant_selection(),
        BoxMinterError::MintVariantSelectionRequired
    );

    require!(quantity >= 1, BoxMinterError::InvalidQuantity);
    let max_qty = cfg.max_per_tx.min(MAX_SAFE_MINTS_PER_TX);
    require!(quantity <= max_qty, BoxMinterError::InvalidQuantity);

    let qty_u32 = quantity as u32;
    let new_total = cfg
        .minted
        .checked_add(qty_u32)
        .ok_or(BoxMinterError::MathOverflow)?;
    require!(new_total <= cfg.max_supply, BoxMinterError::SoldOut);

    charge_mint_payment(accounts, unit_price_lamports, quantity)?;

    require!(
        remaining_accounts.len() == quantity as usize,
        BoxMinterError::InvalidRemainingAccounts
    );
    require!(
        box_bumps.len() == quantity as usize,
        BoxMinterError::InvalidRemainingAccounts
    );

    let start_index = cfg.minted + 1;
    let mut buffers = new_mint_box_asset_buffers(cfg, accounts);

    for i in 0..qty_u32 {
        let i_u8: u8 = i
            .try_into()
            .map_err(|_| error!(BoxMinterError::InvalidQuantity))?;
        mint_one_box_asset(
            cfg,
            accounts,
            &remaining_accounts[i as usize],
            program_id,
            mint_id,
            i_u8,
            box_bumps[i as usize],
            start_index + i,
            &mut buffers,
        )?;
    }

    cfg.minted = new_total;
    Ok(())
}

fn mint_variant_box_inner<'info>(
    cfg: &mut Account<'info, BoxMinterConfig>,
    accounts: &MintBoxesInnerAccounts<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    variant_index: u8,
    mint_id: u64,
    box_bump: u8,
    program_id: &Pubkey,
    unit_price_lamports: u64,
) -> Result<()> {
    require!(cfg.started, BoxMinterError::MintNotStarted);
    require_keys_eq!(
        accounts.mpl_core_program.key(),
        MPL_CORE_PROGRAM_ID,
        BoxMinterError::InvalidMplCoreProgram
    );
    require!(
        remaining_accounts.len() == 1,
        BoxMinterError::InvalidRemainingAccounts
    );
    require!(
        cfg.requires_variant_selection(),
        BoxMinterError::MintVariantSelectionRequired
    );

    let metadata_id = reserve_variant_metadata_ids(&mut *cfg, variant_index, 1)?;
    charge_mint_payment(accounts, unit_price_lamports, 1)?;

    let mut buffers = new_mint_box_asset_buffers(cfg, accounts);
    mint_one_box_asset(
        cfg,
        accounts,
        &remaining_accounts[0],
        program_id,
        mint_id,
        0,
        box_bump,
        metadata_id,
        &mut buffers,
    )?;

    Ok(())
}

fn load_or_create_discount_record<'info>(
    config_key: Pubkey,
    payer_key: Pubkey,
    payer_ai: AccountInfo<'info>,
    discount_ai: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    program_id: &Pubkey,
) -> Result<(DiscountMintRecord, u8)> {
    let (_, discount_bump) = Pubkey::find_program_address(
        &[SEED_DISCOUNT_MINT, config_key.as_ref(), payer_key.as_ref()],
        program_id,
    );
    let discount_bump_bytes = [discount_bump];
    let discount_seeds: &[&[u8]] = &[
        SEED_DISCOUNT_MINT,
        config_key.as_ref(),
        payer_key.as_ref(),
        &discount_bump_bytes,
    ];

    let record = if discount_ai.lamports() == 0
        || *discount_ai.owner == anchor_lang::solana_program::system_program::ID
    {
        create_or_reclaim_empty_pda_account(
            &discount_ai,
            &payer_ai,
            &system_program,
            DiscountMintRecord::SPACE,
            program_id,
            discount_seeds,
            BoxMinterError::InvalidDiscountRecord,
            BoxMinterError::InvalidDiscountRecord,
        )?;
        DiscountMintRecord {
            payer: payer_key,
            minted: 0,
            bump: discount_bump,
        }
    } else {
        require_keys_eq!(
            *discount_ai.owner,
            *program_id,
            BoxMinterError::InvalidDiscountRecord
        );
        let data = discount_ai.try_borrow_data()?;
        let mut data: &[u8] = &data;
        let existing = DiscountMintRecord::try_deserialize(&mut data)
            .map_err(|_| error!(BoxMinterError::InvalidDiscountRecord))?;
        require_keys_eq!(
            existing.payer,
            payer_key,
            BoxMinterError::InvalidDiscountRecord
        );
        existing
    };

    Ok((record, discount_bump))
}

/// Creates a PDA account or reclaims a pre-funded system-owned PDA stub.
///
/// Callers must validate the PDA address before calling; this helper only handles account creation
/// and rejects already-initialized accounts.
fn create_or_reclaim_empty_pda_account<'info>(
    account: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    space: usize,
    program_id: &Pubkey,
    signer_seeds: &[&[u8]],
    invalid_pda_error: BoxMinterError,
    already_exists_error: BoxMinterError,
) -> Result<()> {
    let current_lamports = account.lamports();

    if current_lamports == 0 {
        let rent_lamports = Rent::get()?.minimum_balance(space);
        let create_ix = anchor_lang::solana_program::system_instruction::create_account(
            &payer.key(),
            &account.key(),
            rent_lamports,
            space as u64,
            program_id,
        );
        invoke_signed(
            &create_ix,
            &[payer.clone(), account.clone(), system_program.clone()],
            &[signer_seeds],
        )?;
        return Ok(());
    }

    if !account.data_is_empty() {
        return Err(anchor_lang::error::Error::from(already_exists_error));
    }
    require_keys_eq!(
        *account.owner,
        anchor_lang::solana_program::system_program::ID,
        invalid_pda_error
    );

    let rent_lamports = Rent::get()?.minimum_balance(space);
    if current_lamports < rent_lamports {
        let diff = rent_lamports - current_lamports;
        let topup_ix = anchor_lang::solana_program::system_instruction::transfer(
            &payer.key(),
            &account.key(),
            diff,
        );
        invoke(
            &topup_ix,
            &[payer.clone(), account.clone(), system_program.clone()],
        )?;
    }

    let allocate_ix =
        anchor_lang::solana_program::system_instruction::allocate(&account.key(), space as u64);
    invoke_signed(
        &allocate_ix,
        &[account.clone(), system_program.clone()],
        &[signer_seeds],
    )?;

    let assign_ix =
        anchor_lang::solana_program::system_instruction::assign(&account.key(), program_id);
    invoke_signed(
        &assign_ix,
        &[account.clone(), system_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}

struct ReceiptMintAccounts<'info> {
    cosigner: AccountInfo<'info>,
    leaf_recipient: AccountInfo<'info>,
    merkle_tree: AccountInfo<'info>,
    tree_config: AccountInfo<'info>,
    core_collection: AccountInfo<'info>,
    bubblegum_program: AccountInfo<'info>,
    log_wrapper: AccountInfo<'info>,
    compression_program: AccountInfo<'info>,
    mpl_core_program: AccountInfo<'info>,
    mpl_core_cpi_signer: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
}

struct ReceiptMintCpi<'info> {
    ix: Instruction,
    account_infos: [AccountInfo<'info>; 14],
}

impl<'info> ReceiptMintAccounts<'info> {
    fn from_admin_delivery(accounts: &AdminDeliverVariantOrder<'info>) -> Self {
        Self {
            cosigner: accounts.cosigner.to_account_info(),
            leaf_recipient: accounts.receipt_owner.to_account_info(),
            merkle_tree: accounts.merkle_tree.to_account_info(),
            tree_config: accounts.tree_config.to_account_info(),
            core_collection: accounts.core_collection.to_account_info(),
            bubblegum_program: accounts.bubblegum_program.to_account_info(),
            log_wrapper: accounts.log_wrapper.to_account_info(),
            compression_program: accounts.compression_program.to_account_info(),
            mpl_core_program: accounts.mpl_core_program.to_account_info(),
            mpl_core_cpi_signer: accounts.mpl_core_cpi_signer.to_account_info(),
            system_program: accounts.system_program.to_account_info(),
        }
    }

    fn from_mint_receipts(accounts: &MintReceipts<'info>) -> Self {
        Self {
            cosigner: accounts.cosigner.to_account_info(),
            leaf_recipient: accounts.user.to_account_info(),
            merkle_tree: accounts.merkle_tree.to_account_info(),
            tree_config: accounts.tree_config.to_account_info(),
            core_collection: accounts.core_collection.to_account_info(),
            bubblegum_program: accounts.bubblegum_program.to_account_info(),
            log_wrapper: accounts.log_wrapper.to_account_info(),
            compression_program: accounts.compression_program.to_account_info(),
            mpl_core_program: accounts.mpl_core_program.to_account_info(),
            mpl_core_cpi_signer: accounts.mpl_core_cpi_signer.to_account_info(),
            system_program: accounts.system_program.to_account_info(),
        }
    }
}

fn validate_receipt_mint_accounts(accounts: &ReceiptMintAccounts<'_>) -> Result<()> {
    require_keys_eq!(
        accounts.bubblegum_program.key(),
        BUBBLEGUM_PROGRAM_ID,
        BoxMinterError::InvalidBubblegumProgram
    );
    require_keys_eq!(
        accounts.log_wrapper.key(),
        MPL_NOOP_PROGRAM_ID,
        BoxMinterError::InvalidMplNoopProgram
    );
    require_keys_eq!(
        accounts.compression_program.key(),
        MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        BoxMinterError::InvalidCompressionProgram
    );
    require_keys_eq!(
        accounts.mpl_core_program.key(),
        MPL_CORE_PROGRAM_ID,
        BoxMinterError::InvalidMplCoreProgram
    );
    require_keys_eq!(
        accounts.mpl_core_cpi_signer.key(),
        MPL_CORE_CPI_SIGNER,
        BoxMinterError::InvalidMplCoreCpiSigner
    );
    require_keys_eq!(
        *accounts.merkle_tree.owner,
        MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        BoxMinterError::InvalidReceiptsMerkleTree
    );
    let (expected_tree_config, _) = Pubkey::find_program_address(
        &[accounts.merkle_tree.key().as_ref()],
        &BUBBLEGUM_PROGRAM_ID,
    );
    require_keys_eq!(
        accounts.tree_config.key(),
        expected_tree_config,
        BoxMinterError::InvalidReceiptsTreeConfig
    );
    Ok(())
}

fn new_receipt_mint_ix(accounts: &ReceiptMintAccounts<'_>) -> Instruction {
    Instruction {
        program_id: BUBBLEGUM_PROGRAM_ID,
        accounts: vec![
            // mintV2 accounts order (kinobi):
            // 0 treeConfig (writable)
            AccountMeta::new(accounts.tree_config.key(), false),
            // 1 payer (writable signer)
            AccountMeta::new(accounts.cosigner.key(), true),
            // 2 treeCreatorOrDelegate (signer)
            AccountMeta::new_readonly(accounts.cosigner.key(), true),
            // 3 collectionAuthority (signer)
            AccountMeta::new_readonly(accounts.cosigner.key(), true),
            // 4 leafOwner
            AccountMeta::new_readonly(accounts.leaf_recipient.key(), false),
            // 5 leafDelegate
            AccountMeta::new_readonly(accounts.leaf_recipient.key(), false),
            // 6 merkleTree (writable)
            AccountMeta::new(accounts.merkle_tree.key(), false),
            // 7 coreCollection (writable)
            AccountMeta::new(accounts.core_collection.key(), false),
            // 8 mplCoreCpiSigner
            AccountMeta::new_readonly(accounts.mpl_core_cpi_signer.key(), false),
            // 9 logWrapper
            AccountMeta::new_readonly(accounts.log_wrapper.key(), false),
            // 10 compressionProgram
            AccountMeta::new_readonly(accounts.compression_program.key(), false),
            // 11 mplCoreProgram
            AccountMeta::new_readonly(accounts.mpl_core_program.key(), false),
            // 12 systemProgram
            AccountMeta::new_readonly(accounts.system_program.key(), false),
        ],
        data: Vec::with_capacity(256),
    }
}

fn new_receipt_mint_cpi<'info>(accounts: &ReceiptMintAccounts<'info>) -> ReceiptMintCpi<'info> {
    ReceiptMintCpi {
        ix: new_receipt_mint_ix(accounts),
        // Matches the AccountMeta order in new_receipt_mint_ix; Bubblegum's program account is
        // appended for CPI invocation.
        account_infos: [
            accounts.tree_config.clone(),
            accounts.cosigner.clone(),
            accounts.cosigner.clone(),
            accounts.cosigner.clone(),
            accounts.leaf_recipient.clone(),
            accounts.leaf_recipient.clone(),
            accounts.merkle_tree.clone(),
            accounts.core_collection.clone(),
            accounts.mpl_core_cpi_signer.clone(),
            accounts.log_wrapper.clone(),
            accounts.compression_program.clone(),
            accounts.mpl_core_program.clone(),
            accounts.system_program.clone(),
            accounts.bubblegum_program.clone(),
        ],
    }
}

fn write_receipt_mint_data(
    data: &mut Vec<u8>,
    core_collection: Pubkey,
    name: &str,
    uri: &str,
) -> Result<()> {
    data.clear();
    // MetadataArgsV2 (borsh):
    // name, symbol, uri, sellerFeeBasisPoints(u16), primarySaleHappened(bool), isMutable(bool),
    // tokenStandard: Option<TokenStandard> (Some(NonFungible=0)),
    // creators: Vec<Creator> (empty),
    // collection: Option<Pubkey> (Some(coreCollection))
    data.extend_from_slice(&IX_BUBBLEGUM_MINT_V2);
    borsh_push_string(data, name)?;
    borsh_push_string(data, "")?;
    borsh_push_string(data, uri)?;
    data.extend_from_slice(&(0u16).to_le_bytes()); // sellerFeeBasisPoints
    data.push(0u8); // primarySaleHappened=false
    data.push(1u8); // isMutable=true
    data.push(1u8); // tokenStandard: Some
    data.push(0u8); // NonFungible enum index
    data.extend_from_slice(&(0u32).to_le_bytes()); // creators vec len=0
    data.push(1u8); // collection: Some
    data.extend_from_slice(core_collection.as_ref());
    data.push(0u8); // assetData: None
    data.push(0u8); // assetDataSchema: None
    Ok(())
}

fn invoke_receipt_mint_v2<'info>(
    cpi: &mut ReceiptMintCpi<'info>,
    core_collection: Pubkey,
    name: &str,
    uri: &str,
) -> Result<()> {
    write_receipt_mint_data(&mut cpi.ix.data, core_collection, name, uri)?;
    // CPI: include the program account at the end (like SystemProgram CPIs).
    invoke(&cpi.ix, &cpi.account_infos)?;
    Ok(())
}

fn build_receipt_name_and_uri(
    name_buf: &mut String,
    uri_buf: &mut String,
    drop_base: &str,
    label: &str,
    uri_prefix: &str,
    id: impl core::fmt::Display + Copy,
) -> Result<()> {
    name_buf.clear();
    name_buf.push_str(RECEIPT_NAME_PREFIX);
    append_label_and_id(name_buf, label, id)?;

    uri_buf.clear();
    uri_buf.push_str(drop_base);
    uri_buf.push_str(uri_prefix);
    write!(uri_buf, "{}", id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
    uri_buf.push_str(".json");
    Ok(())
}

fn mint_admin_order_receipt_cnfts<'info>(
    cfg: &BoxMinterConfig,
    accounts: &ReceiptMintAccounts<'info>,
    first_metadata_id: u32,
    quantity: u8,
) -> Result<()> {
    require!(quantity >= 1, BoxMinterError::InvalidQuantity);
    let last_metadata_id = first_metadata_id
        .checked_add(u32::from(quantity) - 1)
        .ok_or(BoxMinterError::MathOverflow)?;
    require!(
        first_metadata_id >= 1 && last_metadata_id <= cfg.max_supply,
        BoxMinterError::InvalidAssetMetadata
    );

    let drop_base = cfg.uri_base.as_str();
    let mut name_buf = String::with_capacity(48);
    let mut uri_buf = String::with_capacity(drop_base.len() + URI_PREFIX_RECEIPTS_BOXES.len() + 16);
    let mut mint_cpi = new_receipt_mint_cpi(accounts);

    for metadata_id in first_metadata_id..=last_metadata_id {
        build_receipt_name_and_uri(
            &mut name_buf,
            &mut uri_buf,
            drop_base,
            &cfg.name_prefix,
            URI_PREFIX_RECEIPTS_BOXES,
            metadata_id,
        )?;
        invoke_receipt_mint_v2(&mut mint_cpi, cfg.core_collection, &name_buf, &uri_buf)?;
    }

    Ok(())
}

fn validate_admin_order_hash(order_hash: &[u8; 32]) -> Result<()> {
    require!(
        has_any_non_zero_byte(order_hash.as_ref()),
        BoxMinterError::InvalidAdminOrder
    );
    Ok(())
}

fn admin_order_is_valid_retry(
    record: &AdminDeliveryOrderRecord,
    args: &AdminDeliverVariantOrderArgs,
    effective_variant_index: u8,
    receipt_owner: Pubkey,
    order_bump: u8,
) -> bool {
    record.order_hash == args.order_hash
        && record.variant_index == effective_variant_index
        && record.quantity == args.quantity
        && record.receipt_owner == receipt_owner
        && record.bump == order_bump
        && record.quantity >= 1
        && record.first_metadata_id >= 1
}

fn deserialize_admin_order_record(
    account: &AccountInfo<'_>,
    program_id: &Pubkey,
) -> Result<AdminDeliveryOrderRecord> {
    require_keys_eq!(
        *account.owner,
        *program_id,
        BoxMinterError::InvalidAdminOrder
    );
    let data = account.try_borrow_data()?;
    let mut data: &[u8] = &data;
    AdminDeliveryOrderRecord::try_deserialize(&mut data)
        .map_err(|_| error!(BoxMinterError::InvalidAdminOrder))
}

fn validate_admin_order_pda(
    program_id: &Pubkey,
    config_key: &Pubkey,
    order_hash: &[u8; 32],
    admin_order_key: Pubkey,
) -> Result<u8> {
    let (expected_order, canonical_bump) = Pubkey::find_program_address(
        &[SEED_ADMIN_ORDER, config_key.as_ref(), order_hash.as_ref()],
        program_id,
    );
    require_keys_eq!(
        admin_order_key,
        expected_order,
        BoxMinterError::InvalidAdminOrderPda
    );
    Ok(canonical_bump)
}

fn reserve_variant_metadata_ids(
    cfg: &mut BoxMinterConfig,
    variant_index: u8,
    quantity: u8,
) -> Result<u32> {
    require!(quantity >= 1, BoxMinterError::InvalidQuantity);
    let new_total = cfg
        .minted
        .checked_add(u32::from(quantity))
        .ok_or(BoxMinterError::MathOverflow)?;
    require!(new_total <= cfg.max_supply, BoxMinterError::SoldOut);

    let variant_slot = cfg.variant_slot(variant_index)?;
    let first_metadata_id = cfg.next_variant_metadata_id(variant_slot)?;
    let last_metadata_id = first_metadata_id
        .checked_add(u32::from(quantity) - 1)
        .ok_or(BoxMinterError::MathOverflow)?;
    require!(
        last_metadata_id <= cfg.mint_variant_end_ids[variant_slot],
        BoxMinterError::MintVariantUnavailable
    );

    cfg.minted = new_total;
    cfg.mint_variant_next_ids[variant_slot] = last_metadata_id
        .checked_add(1)
        .ok_or(BoxMinterError::MathOverflow)?;
    Ok(first_metadata_id)
}

fn reserve_standard_metadata_ids(cfg: &mut BoxMinterConfig, quantity: u8) -> Result<u32> {
    require!(quantity >= 1, BoxMinterError::InvalidQuantity);
    let first_metadata_id = cfg
        .minted
        .checked_add(1)
        .ok_or(BoxMinterError::MathOverflow)?;
    let new_total = cfg
        .minted
        .checked_add(u32::from(quantity))
        .ok_or(BoxMinterError::MathOverflow)?;
    require!(new_total <= cfg.max_supply, BoxMinterError::SoldOut);

    cfg.minted = new_total;
    Ok(first_metadata_id)
}

fn admin_delivery_effective_variant_index(cfg: &BoxMinterConfig, variant_index: u8) -> u8 {
    if cfg.requires_variant_selection() {
        variant_index
    } else {
        0
    }
}

fn reserve_admin_delivery_metadata_ids(
    cfg: &mut BoxMinterConfig,
    variant_index: u8,
    quantity: u8,
) -> Result<u32> {
    require!(quantity >= 1, BoxMinterError::InvalidQuantity);
    require!(cfg.started, BoxMinterError::MintNotStarted);
    let max_qty = cfg.max_per_tx.min(MAX_SAFE_MINTS_PER_TX);
    require!(quantity <= max_qty, BoxMinterError::InvalidQuantity);

    if cfg.requires_variant_selection() {
        reserve_variant_metadata_ids(cfg, variant_index, quantity)
    } else {
        reserve_standard_metadata_ids(cfg, quantity)
    }
}

#[program]
pub mod box_minter {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            EXPECTED_INITIALIZER,
            BoxMinterError::UnauthorizedInitializer
        );
        require!(args.max_supply > 0, BoxMinterError::InvalidMaxSupply);
        require!(args.max_per_tx > 0, BoxMinterError::InvalidMaxPerTx);
        require!(
            args.max_per_tx <= MAX_SAFE_MINTS_PER_TX,
            BoxMinterError::InvalidMaxPerTx
        );
        require!(
            args.items_per_box >= MIN_ITEMS_PER_BOX && args.items_per_box <= MAX_ITEMS_PER_BOX,
            BoxMinterError::InvalidItemsPerBox
        );
        let max_figure_id = (args.max_supply as u64)
            .checked_mul(args.items_per_box as u64)
            .ok_or(BoxMinterError::MathOverflow)?;
        require!(
            max_figure_id <= u16::MAX as u64,
            BoxMinterError::InvalidItemsPerBox
        );
        validate_mint_prices(args.price_lamports, args.discount_price_lamports)?;
        require!(
            args.mint_variant_kind == MINT_VARIANT_KIND_NONE
                || args.mint_variant_kind == MINT_VARIANT_KIND_SIZE,
            BoxMinterError::InvalidMintVariantConfig
        );
        require!(
            args.discount_merkle_root != [0u8; 32],
            BoxMinterError::DiscountNotConfigured
        );
        require!(
            args.discount_mints_per_wallet >= MIN_DISCOUNT_MINTS_PER_WALLET
                && args.discount_mints_per_wallet <= MAX_DISCOUNT_MINTS_PER_WALLET,
            BoxMinterError::InvalidDiscountMintsPerWallet
        );
        require!(
            args.name_prefix.len() <= BoxMinterConfig::MAX_NAME_PREFIX,
            BoxMinterError::NameTooLong
        );
        require!(
            args.figure_name_prefix.len() <= BoxMinterConfig::MAX_FIGURE_NAME_PREFIX,
            BoxMinterError::FigureNameTooLong
        );
        require!(
            args.symbol.len() <= BoxMinterConfig::MAX_SYMBOL,
            BoxMinterError::SymbolTooLong
        );
        require!(
            args.uri_base.len() <= BoxMinterConfig::MAX_URI_BASE,
            BoxMinterError::UriTooLong
        );
        require!(
            has_any_non_zero_byte(args.drop_seed.as_ref()),
            BoxMinterError::InvalidDropSeed
        );
        // Canonical config: `uri_base` is the DROP BASE (not a legacy `/json/...` prefix and not a `.json` file).
        // Example: `https://assets.mons.link/drops/lsb` or `ipfs://bafy...`
        let drop_base = args.uri_base.trim_end_matches('/');
        validate_metadata_base(drop_base)?;
        if args.mint_variant_kind == MINT_VARIANT_KIND_SIZE {
            require!(
                args.items_per_box == 0,
                BoxMinterError::MintVariantDirectDeliveryOnly
            );
            require!(
                args.max_supply < u32::MAX,
                BoxMinterError::InvalidMintVariantConfig
            );
            for i in 0..MINT_VARIANT_OPTION_COUNT {
                let start_id = args.mint_variant_start_ids[i];
                let end_id = args.mint_variant_end_ids[i];
                let next_id = args.mint_variant_next_ids[i];
                require!(start_id >= 1, BoxMinterError::InvalidMintVariantConfig);
                require!(end_id >= start_id, BoxMinterError::InvalidMintVariantConfig);
                require!(
                    next_id == start_id,
                    BoxMinterError::InvalidMintVariantConfig
                );
                if i == 0 {
                    require!(start_id == 1, BoxMinterError::InvalidMintVariantConfig);
                } else {
                    require!(
                        start_id
                            == args.mint_variant_end_ids[i - 1]
                                .checked_add(1)
                                .ok_or(BoxMinterError::MathOverflow)?,
                        BoxMinterError::InvalidMintVariantConfig
                    );
                }
            }
            require!(
                args.mint_variant_end_ids[MINT_VARIANT_OPTION_COUNT - 1] == args.max_supply,
                BoxMinterError::InvalidMintVariantConfig
            );
        } else {
            require!(
                args.mint_variant_start_ids == [0; MINT_VARIANT_OPTION_COUNT]
                    && args.mint_variant_end_ids == [0; MINT_VARIANT_OPTION_COUNT]
                    && args.mint_variant_next_ids == [0; MINT_VARIANT_OPTION_COUNT],
                BoxMinterError::InvalidMintVariantConfig
            );
        }

        let core_collection_ai = ctx.accounts.core_collection.to_account_info();
        require!(
            core_collection_ai.key() != Pubkey::default(),
            BoxMinterError::InvalidCoreCollection
        );
        require_keys_eq!(
            *core_collection_ai.owner,
            MPL_CORE_PROGRAM_ID,
            BoxMinterError::InvalidCoreCollection
        );

        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.treasury = ctx.accounts.treasury.key();
        cfg.core_collection = core_collection_ai.key();
        cfg.price_lamports = args.price_lamports;
        cfg.discount_price_lamports = args.discount_price_lamports;
        cfg.discount_merkle_root = args.discount_merkle_root;
        cfg.max_supply = args.max_supply;
        cfg.max_per_tx = args.max_per_tx;
        cfg.items_per_box = args.items_per_box;
        cfg.discount_mints_per_wallet = args.discount_mints_per_wallet;
        // Minting is paused by default until the admin explicitly starts it.
        cfg.started = false;
        cfg.minted = 0;
        cfg.name_prefix = args.name_prefix;
        cfg.symbol = args.symbol;
        // Store normalized drop base (no trailing slash).
        cfg.uri_base = drop_base.to_string();
        cfg.bump = ctx.bumps.config;
        cfg.figure_name_prefix = args.figure_name_prefix;
        cfg.mint_variant_kind = args.mint_variant_kind;
        cfg.mint_variant_start_ids = args.mint_variant_start_ids;
        cfg.mint_variant_end_ids = args.mint_variant_end_ids;
        cfg.mint_variant_next_ids = args.mint_variant_next_ids;
        cfg.drop_seed = args.drop_seed;
        Ok(())
    }

    pub fn set_treasury(ctx: Context<SetTreasury>, treasury: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.treasury = treasury;
        Ok(())
    }

    pub fn set_mint_prices(
        ctx: Context<SetMintPrices>,
        price_lamports: u64,
        discount_price_lamports: u64,
    ) -> Result<()> {
        validate_mint_prices(price_lamports, discount_price_lamports)?;

        let cfg = &mut ctx.accounts.config;
        cfg.price_lamports = price_lamports;
        cfg.discount_price_lamports = discount_price_lamports;
        Ok(())
    }

    pub fn start_mint(ctx: Context<StartMint>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.started = true;
        Ok(())
    }

    pub fn mint_boxes<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, MintBoxes<'info>>,
        quantity: u8,
        // Client-chosen mint id used only for PDA derivation (prevents stale-PDA failures under high concurrency).
        // Must be random/unique per attempted mint transaction.
        mint_id: u64,
        // PDA bumps for each box asset PDA, in the same order as `remaining_accounts`.
        // Passed in from the client to avoid `find_program_address` compute inside the program.
        box_bumps: Vec<u8>,
    ) -> Result<()> {
        let accounts = MintBoxesInnerAccounts::from_mint_boxes(&ctx.accounts);
        let unit_price_lamports = ctx.accounts.config.price_lamports;
        mint_standard_boxes_inner(
            &mut ctx.accounts.config,
            &accounts,
            ctx.remaining_accounts,
            quantity,
            mint_id,
            box_bumps,
            ctx.program_id,
            unit_price_lamports,
        )
    }

    pub fn mint_variant_box<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, MintBoxes<'info>>,
        variant_index: u8,
        mint_id: u64,
        box_bump: u8,
    ) -> Result<()> {
        let accounts = MintBoxesInnerAccounts::from_mint_boxes(&ctx.accounts);
        let unit_price_lamports = ctx.accounts.config.price_lamports;
        mint_variant_box_inner(
            &mut ctx.accounts.config,
            &accounts,
            ctx.remaining_accounts,
            variant_index,
            mint_id,
            box_bump,
            ctx.program_id,
            unit_price_lamports,
        )
    }

    pub fn mint_discounted_box<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, MintDiscountedBox<'info>>,
        mint_id: u64,
        box_bumps: Vec<u8>,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let discount_price = ctx.accounts.config.discount_price_lamports;
        require!(discount_price > 0, BoxMinterError::InvalidDiscountPrice);
        let discount_root = ctx.accounts.config.discount_merkle_root;
        require!(
            discount_root != [0u8; 32],
            BoxMinterError::DiscountNotConfigured
        );

        let payer_key = ctx.accounts.payer.key();
        require!(
            verify_merkle_proof(payer_key.as_ref(), &proof, discount_root),
            BoxMinterError::InvalidDiscountProof
        );
        let quantity =
            u8::try_from(box_bumps.len()).map_err(|_| error!(BoxMinterError::InvalidQuantity))?;
        let discount_limit = ctx.accounts.config.discount_mints_per_wallet;
        let discount_ai = ctx.accounts.discount_record.to_account_info();
        let (mut discount_record, discount_bump) = load_or_create_discount_record(
            ctx.accounts.config.key(),
            payer_key,
            ctx.accounts.payer.to_account_info(),
            discount_ai.clone(),
            ctx.accounts.system_program.to_account_info(),
            ctx.program_id,
        )?;
        let new_discount_total = discount_record
            .minted
            .checked_add(quantity)
            .ok_or(BoxMinterError::MathOverflow)?;
        require!(
            new_discount_total <= discount_limit,
            BoxMinterError::DiscountAllowanceExceeded
        );

        let accounts = MintBoxesInnerAccounts::from_discounted_box(&ctx.accounts);
        mint_standard_boxes_inner(
            &mut ctx.accounts.config,
            &accounts,
            ctx.remaining_accounts,
            quantity,
            mint_id,
            box_bumps,
            ctx.program_id,
            discount_price,
        )?;
        discount_record.minted = new_discount_total;
        discount_record.bump = discount_bump;
        discount_record.try_serialize(&mut &mut discount_ai.data.borrow_mut()[..])?;
        Ok(())
    }

    pub fn mint_discounted_variant_box<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, MintDiscountedBox<'info>>,
        variant_index: u8,
        mint_id: u64,
        box_bump: u8,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let discount_price = ctx.accounts.config.discount_price_lamports;
        require!(discount_price > 0, BoxMinterError::InvalidDiscountPrice);
        let discount_root = ctx.accounts.config.discount_merkle_root;
        require!(
            discount_root != [0u8; 32],
            BoxMinterError::DiscountNotConfigured
        );

        let payer_key = ctx.accounts.payer.key();
        require!(
            verify_merkle_proof(payer_key.as_ref(), &proof, discount_root),
            BoxMinterError::InvalidDiscountProof
        );
        let discount_limit = ctx.accounts.config.discount_mints_per_wallet;
        let discount_ai = ctx.accounts.discount_record.to_account_info();
        let (mut discount_record, discount_bump) = load_or_create_discount_record(
            ctx.accounts.config.key(),
            payer_key,
            ctx.accounts.payer.to_account_info(),
            discount_ai.clone(),
            ctx.accounts.system_program.to_account_info(),
            ctx.program_id,
        )?;
        let new_discount_total = discount_record
            .minted
            .checked_add(1)
            .ok_or(BoxMinterError::MathOverflow)?;
        require!(
            new_discount_total <= discount_limit,
            BoxMinterError::DiscountAllowanceExceeded
        );

        let accounts = MintBoxesInnerAccounts::from_discounted_box(&ctx.accounts);
        mint_variant_box_inner(
            &mut ctx.accounts.config,
            &accounts,
            ctx.remaining_accounts,
            variant_index,
            mint_id,
            box_bump,
            ctx.program_id,
            discount_price,
        )?;
        discount_record.minted = new_discount_total;
        discount_record.bump = discount_bump;
        discount_record.try_serialize(&mut &mut discount_ai.data.borrow_mut()[..])?;
        Ok(())
    }

    /// Starts a two-step box open flow.
    ///
    /// This instruction performs an MPL-Core `TransferV1` CPI that transfers `box_asset` from the
    /// user to `config.admin` (vault). This avoids brittle reliance on instruction ordering (some
    /// wallets inject extra instructions like Compute Budget).
    ///
    /// Side effects (all in this one transaction):
    /// - creates a `PendingOpenBox` PDA keyed by the box asset pubkey
    /// - mints `config.items_per_box` placeholder Core assets (empty metadata, no collection)
    ///   owned by `config.admin`
    pub fn start_open_box<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, StartOpenBox<'info>>,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        cfg.require_openable()?;
        let items_per_box = cfg.items_per_box_len();

        require_keys_eq!(
            ctx.accounts.mpl_core_program.key(),
            MPL_CORE_PROGRAM_ID,
            BoxMinterError::InvalidMplCoreProgram
        );
        require_keys_eq!(
            ctx.accounts.log_wrapper.key(),
            SPL_NOOP_PROGRAM_ID,
            BoxMinterError::InvalidLogWrapper
        );

        // Pending open record PDA:
        // - Do not rely on Anchor `init_if_needed` here; its reclaim behavior for pre-funded PDA stubs
        //   (system-owned, data_len=0) has historically been version-sensitive.
        // - Starting an open twice for the same box must fail.
        let pending_ai = ctx.accounts.pending.to_account_info();

        // Create (or reclaim) the pending record PDA.
        //
        // Note: a PDA can be "pre-funded", creating a system-owned stub account that makes
        // `system_instruction::create_account` fail ("account already in use"). Since this is a PDA,
        // we can sign for it and reclaim it via `allocate` + `assign`.
        let pending_space: usize = PendingOpenBox::space(cfg.items_per_box);
        let pending_bump: u8 = ctx.bumps.pending;
        let box_asset_key = ctx.accounts.box_asset.key();
        let pending_seeds: &[&[u8]] = &[SEED_PENDING_OPEN, box_asset_key.as_ref(), &[pending_bump]];
        create_or_reclaim_empty_pda_account(
            &pending_ai,
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            pending_space,
            ctx.program_id,
            pending_seeds,
            BoxMinterError::InvalidPendingRecord,
            BoxMinterError::PendingAlreadyExists,
        )?;

        // Post-conditions: at this point the pending PDA must be a properly sized, program-owned
        // account ready for serialization.
        require_keys_eq!(
            *pending_ai.owner,
            *ctx.program_id,
            BoxMinterError::InvalidPendingRecord
        );
        require!(
            pending_ai.data_len() == pending_space,
            BoxMinterError::InvalidPendingRecord
        );

        // Defensive: ensure the provided asset is a Mons *box* owned by payer.
        let drop_base = cfg.uri_base.as_str();
        verify_core_asset_owned_by_uri(
            &ctx.accounts.box_asset.to_account_info(),
            ctx.accounts.payer.key(),
            cfg.core_collection,
            drop_base,
            URI_PREFIX_BOXES,
            None,
        )?;

        // Remaining accounts: exactly `items_per_box` new placeholder figure asset PDAs.
        require!(
            ctx.remaining_accounts.len() == items_per_box,
            BoxMinterError::InvalidRemainingAccounts
        );

        // Transfer the box to the vault/admin via MPL-Core `TransferV1` inside this instruction.
        // This makes the instruction robust against wallets that insert extra instructions into the tx.
        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let box_asset = ctx.accounts.box_asset.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let vault = ctx.accounts.vault.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let log_wrapper = ctx.accounts.log_wrapper.to_account_info();
        let cfg_ai = ctx.accounts.config.to_account_info();
        let cfg_bump_bytes = [cfg.bump];
        let cfg_signer_seeds: &[&[u8]] = &[
            BoxMinterConfig::SEED,
            cfg.drop_seed.as_ref(),
            &cfg_bump_bytes,
        ];

        let transfer_ix = Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // asset, collection, payer, authority, new_owner, system_program, log_wrapper
                AccountMeta::new(box_asset.key(), false),
                AccountMeta::new_readonly(core_collection.key(), false),
                AccountMeta::new(payer.key(), true),
                AccountMeta::new_readonly(payer.key(), true),
                AccountMeta::new_readonly(vault.key(), false),
                AccountMeta::new_readonly(system_program.key(), false),
                AccountMeta::new_readonly(log_wrapper.key(), false),
            ],
            // TransferV1 discriminator=14, compression_proof=None (0)
            data: vec![14u8, 0u8],
        };
        invoke(
            &transfer_ix,
            &[
                box_asset.clone(),
                core_collection.clone(),
                payer.clone(),
                payer.clone(),
                vault.clone(),
                system_program.clone(),
                log_wrapper.clone(),
                mpl_core_program.clone(),
            ],
        )?;

        // Create placeholder Core assets:
        // - owner: config.admin (vault/admin)
        // - update authority: config PDA (so only the program can later "reveal" by updating metadata + setting collection)
        // - collection: None (placeholder) so the assets do NOT appear in the collection until reveal.
        let pending_key = ctx.accounts.pending.key();
        let mut dudes: Vec<Pubkey> = Vec::with_capacity(items_per_box);

        let mut create_ix = Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // 0 asset (placeholder)
                AccountMeta::new(Pubkey::default(), true),
                // 1 collection: None => placeholder = program id (must be readonly when absent)
                AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false),
                // 2 authority (signer): config PDA
                AccountMeta::new_readonly(cfg_ai.key(), true),
                // 3 payer (signer)
                AccountMeta::new(payer.key(), true),
                // 4 owner: vault/admin (not signer)
                AccountMeta::new_readonly(vault.key(), false),
                // 5 update authority: config PDA (not signer account meta)
                AccountMeta::new_readonly(cfg_ai.key(), false),
                // 6 system program
                AccountMeta::new_readonly(system_program.key(), false),
                // 7 log wrapper: None => placeholder = program id
                AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false),
            ],
            data: Vec::with_capacity(32),
        };

        for (i, asset_ai) in ctx.remaining_accounts.iter().enumerate() {
            let i_u8: u8 = i
                .try_into()
                .map_err(|_| error!(BoxMinterError::InvalidRemainingAccounts))?;
            let i_seed = [i_u8];
            let (expected, asset_bump) = Pubkey::find_program_address(
                &[SEED_PENDING_DUDE_ASSET, pending_key.as_ref(), &i_seed],
                ctx.program_id,
            );

            require_keys_eq!(asset_ai.key(), expected, BoxMinterError::InvalidAssetPda);
            // Ensure the account is uninitialized (otherwise Create will fail and waste compute).
            require_keys_eq!(
                *asset_ai.owner,
                anchor_lang::solana_program::system_program::ID,
                BoxMinterError::InvalidAssetPda
            );

            dudes.push(expected);

            let asset_seeds: &[&[u8]] = &[
                SEED_PENDING_DUDE_ASSET,
                pending_key.as_ref(),
                &i_seed,
                &[asset_bump],
            ];
            let signer_seeds: &[&[&[u8]]] = &[cfg_signer_seeds, asset_seeds];

            // Prevent PDA "squatting": if the placeholder PDA was pre-funded, MPL-Core Create would fail.
            // Drain any prefunded lamports back to the payer before invoking MPL-Core.
            let prefund_lamports = asset_ai.lamports();
            if prefund_lamports > 0 {
                let sweep_ix = anchor_lang::solana_program::system_instruction::transfer(
                    asset_ai.key,
                    payer.key,
                    prefund_lamports,
                );
                invoke_signed(
                    &sweep_ix,
                    &[asset_ai.clone(), payer.clone(), system_program.clone()],
                    &[asset_seeds],
                )
                .map_err(anchor_lang::error::Error::from)?;
            }

            create_ix.accounts[0].pubkey = asset_ai.key();
            create_ix.data.clear();
            // CreateV1 discriminator=0, DataState::AccountState=0
            create_ix.data.push(0u8);
            create_ix.data.push(0u8);
            // name: empty string
            create_ix.data.extend_from_slice(&(0u32).to_le_bytes());
            // uri: empty string
            create_ix.data.extend_from_slice(&(0u32).to_le_bytes());
            // plugins: None
            create_ix.data.push(0u8);

            let create_infos = [
                mpl_core_program.clone(),
                asset_ai.clone(),
                cfg_ai.clone(),
                payer.clone(),
                vault.clone(),
                cfg_ai.clone(),
                system_program.clone(),
            ];
            invoke_signed(&create_ix, &create_infos, signer_seeds)
                .map_err(anchor_lang::error::Error::from)?;
        }

        // Persist the pending flow record so the admin can later finalize it.
        let record = PendingOpenBox {
            owner: ctx.accounts.payer.key(),
            box_asset: ctx.accounts.box_asset.key(),
            dudes,
            created_slot: Clock::get()?.slot,
            bump: pending_bump,
            config: ctx.accounts.config.key(),
        };
        record.try_serialize(&mut &mut pending_ai.data.borrow_mut()[..])?;

        Ok(())
    }

    /// Finalizes a pending box open, admin-only.
    ///
    /// Performs in one transaction:
    /// 1) burns the vault-owned box (reclaims rent)
    /// 2) updates placeholder dudes with real IDs + moves them into the core collection
    /// 3) transfers dudes to the user
    /// 4) closes the pending record PDA
    pub fn finalize_open_box<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, FinalizeOpenBox<'info>>,
        args: FinalizeOpenBoxArgs,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let pending_ai = ctx.accounts.pending.to_account_info();
        require_keys_eq!(
            *pending_ai.owner,
            *ctx.program_id,
            BoxMinterError::InvalidPendingRecord
        );
        let pending = {
            let pending_data = pending_ai.try_borrow_data()?;
            decode_pending_open_box_account(&pending_data)?
        };
        cfg.require_openable()?;
        let items_per_box = cfg.items_per_box_len();
        let max_dude_id = cfg.max_figure_id()?;
        let dude_ids = &args.dude_ids;

        // Admin-only. The admin key is the custody vault for delivered/opened assets.
        require_keys_eq!(
            ctx.accounts.cosigner.key(),
            cfg.admin,
            BoxMinterError::InvalidCosigner
        );

        require_keys_eq!(
            ctx.accounts.mpl_core_program.key(),
            MPL_CORE_PROGRAM_ID,
            BoxMinterError::InvalidMplCoreProgram
        );
        require_keys_eq!(
            ctx.accounts.log_wrapper.key(),
            SPL_NOOP_PROGRAM_ID,
            BoxMinterError::InvalidLogWrapper
        );

        // Validate figure IDs.
        require!(
            dude_ids.len() == items_per_box,
            BoxMinterError::InvalidDudeId
        );
        for id in dude_ids.iter() {
            require!(
                *id >= 1 && *id <= max_dude_id,
                BoxMinterError::InvalidDudeId
            );
        }
        for i in 0..dude_ids.len() {
            for j in (i + 1)..dude_ids.len() {
                require!(dude_ids[i] != dude_ids[j], BoxMinterError::DuplicateDudeId);
            }
        }

        // Pending record must belong to the provided user, and must correspond to this box.
        require_keys_eq!(
            pending.box_asset,
            ctx.accounts.box_asset.key(),
            BoxMinterError::InvalidPendingRecord
        );
        require_keys_eq!(
            ctx.accounts.user.key(),
            pending.owner,
            BoxMinterError::InvalidPendingRecord
        );
        if let Some(pending_config) = pending.config {
            require_keys_eq!(
                pending_config,
                ctx.accounts.config.key(),
                BoxMinterError::InvalidPendingRecord
            );
        }

        require!(
            pending.dudes.len() == items_per_box,
            BoxMinterError::InvalidPendingRecord
        );
        // Remaining accounts: exactly `items_per_box` placeholder figure assets, in the order stored on-chain.
        require!(
            ctx.remaining_accounts.len() == items_per_box,
            BoxMinterError::InvalidRemainingAccounts
        );
        for i in 0..items_per_box {
            require_keys_eq!(
                ctx.remaining_accounts[i].key(),
                pending.dudes[i],
                BoxMinterError::InvalidRemainingAccounts
            );
        }

        // Defensive: ensure the box is a Mons *box* now owned by the vault/admin.
        let drop_base = cfg.uri_base.as_str();
        verify_core_asset_owned_by_uri(
            &ctx.accounts.box_asset.to_account_info(),
            cfg.admin,
            cfg.core_collection,
            drop_base,
            URI_PREFIX_BOXES,
            None,
        )?;

        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let cosigner = ctx.accounts.cosigner.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let log_wrapper = ctx.accounts.log_wrapper.to_account_info();
        let cfg_ai = ctx.accounts.config.to_account_info();
        let cfg_bump_bytes = [cfg.bump];
        let cfg_signer_seeds: &[&[u8]] = &[
            BoxMinterConfig::SEED,
            cfg.drop_seed.as_ref(),
            &cfg_bump_bytes,
        ];

        // 1) Burn the box (reclaim rent to the admin payer).
        let burn_ix = Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // asset, collection, payer, authority, system_program, log_wrapper
                AccountMeta::new(ctx.accounts.box_asset.key(), false),
                AccountMeta::new(core_collection.key(), false),
                AccountMeta::new(cosigner.key(), true),
                AccountMeta::new_readonly(cosigner.key(), true),
                AccountMeta::new_readonly(system_program.key(), false),
                AccountMeta::new_readonly(log_wrapper.key(), false),
            ],
            // BurnV1 discriminator=12, compression_proof=None (0)
            data: vec![12u8, 0u8],
        };
        invoke(
            &burn_ix,
            &[
                ctx.accounts.box_asset.to_account_info(),
                core_collection.clone(),
                cosigner.clone(),
                cosigner.clone(),
                system_program.clone(),
                log_wrapper.clone(),
                mpl_core_program.clone(),
            ],
        )?;

        // 2) Update + "add to collection" by setting update authority to Collection(core_collection).
        //
        // IMPORTANT: MPL-Core only supports moving an asset into a collection via `UpdateV2`
        // (UpdateV1 cannot add/remove/change collection).
        let mut name_buf = String::with_capacity(32);
        let mut uri_buf = String::with_capacity(drop_base.len() + URI_PREFIX_FIGURES.len() + 16);

        let mut update_ix = Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // UpdateV2 accounts:
                //   asset, collection (optional), payer, authority, new_collection (optional), system_program, log_wrapper
                AccountMeta::new(Pubkey::default(), false), // asset placeholder
                // collection: None (placeholder)
                AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false),
                AccountMeta::new(cosigner.key(), true),
                AccountMeta::new_readonly(cfg_ai.key(), true), // authority (config PDA)
                // new_collection: core collection (writable; mpl-core increments size)
                AccountMeta::new(core_collection.key(), false),
                AccountMeta::new_readonly(system_program.key(), false),
                AccountMeta::new_readonly(log_wrapper.key(), false),
            ],
            data: Vec::with_capacity(128),
        };

        // 3) Transfer dudes to the user.
        let user_ai = ctx.accounts.user.to_account_info();
        let mut transfer_ix = Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // asset, collection, payer, authority, new_owner, system_program, log_wrapper
                AccountMeta::new(Pubkey::default(), false), // asset placeholder
                AccountMeta::new_readonly(core_collection.key(), false),
                AccountMeta::new(cosigner.key(), true),
                AccountMeta::new_readonly(cosigner.key(), true),
                AccountMeta::new_readonly(user_ai.key(), false),
                AccountMeta::new_readonly(system_program.key(), false),
                AccountMeta::new_readonly(log_wrapper.key(), false),
            ],
            // TransferV1 discriminator=14, compression_proof=None (0)
            data: vec![14u8, 0u8],
        };

        for (i, asset_ai) in ctx.remaining_accounts.iter().enumerate() {
            let dude_id = dude_ids[i];
            name_buf.clear();
            append_label_and_id(&mut name_buf, &cfg.figure_name_prefix, dude_id)?;

            uri_buf.clear();
            uri_buf.push_str(drop_base);
            uri_buf.push_str(URI_PREFIX_FIGURES);
            write!(&mut uri_buf, "{}", dude_id)
                .map_err(|_| error!(BoxMinterError::SerializationFailed))?;
            uri_buf.push_str(".json");

            // UpdateV2:
            // - newName: Some(name)
            // - newUri: Some(uri)
            // - newUpdateAuthority: Some(Collection(core_collection))
            update_ix.accounts[0].pubkey = asset_ai.key();
            update_ix.data.clear();
            // discriminator
            update_ix.data.push(30u8);
            // newName: Some(string)
            update_ix.data.push(1u8);
            update_ix
                .data
                .extend_from_slice(&(name_buf.len() as u32).to_le_bytes());
            update_ix.data.extend_from_slice(name_buf.as_bytes());
            // newUri: Some(string)
            update_ix.data.push(1u8);
            update_ix
                .data
                .extend_from_slice(&(uri_buf.len() as u32).to_le_bytes());
            update_ix.data.extend_from_slice(uri_buf.as_bytes());
            // newUpdateAuthority: Some(BaseUpdateAuthority::Collection(core_collection))
            update_ix.data.push(1u8); // Option::Some
            update_ix.data.push(2u8); // BaseUpdateAuthority::Collection enum index
            update_ix
                .data
                .extend_from_slice(core_collection.key().as_ref());

            invoke_signed(
                &update_ix,
                &[
                    asset_ai.clone(),
                    core_collection.clone(),
                    cosigner.clone(),
                    cfg_ai.clone(),
                    system_program.clone(),
                    log_wrapper.clone(),
                    mpl_core_program.clone(),
                ],
                &[cfg_signer_seeds],
            )
            .map_err(anchor_lang::error::Error::from)?;

            // TransferV1 to the user.
            transfer_ix.accounts[0].pubkey = asset_ai.key();
            invoke(
                &transfer_ix,
                &[
                    asset_ai.clone(),
                    core_collection.clone(),
                    cosigner.clone(),
                    cosigner.clone(),
                    user_ai.clone(),
                    system_program.clone(),
                    log_wrapper.clone(),
                    mpl_core_program.clone(),
                ],
            )?;
        }

        close_program_account(&pending_ai, &cosigner)?;
        Ok(())
    }

    pub fn deliver<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, Deliver<'info>>,
        args: DeliverArgs,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;

        // Require a cloud-held signer (same admin as initialize) so users can't choose arbitrary fees.
        // The delivery fee itself is determined off-chain and embedded in the cosigned transaction.
        require_keys_eq!(
            ctx.accounts.cosigner.key(),
            cfg.admin,
            BoxMinterError::InvalidCosigner
        );

        require!(
            !ctx.remaining_accounts.is_empty(),
            BoxMinterError::InvalidQuantity
        );
        require!(
            (ctx.remaining_accounts.len() as u8) <= MAX_SAFE_DELIVERY_ITEMS_PER_TX,
            BoxMinterError::InvalidQuantity
        );

        require_keys_eq!(
            ctx.accounts.mpl_core_program.key(),
            MPL_CORE_PROGRAM_ID,
            BoxMinterError::InvalidMplCoreProgram
        );
        require_keys_eq!(
            ctx.accounts.log_wrapper.key(),
            SPL_NOOP_PROGRAM_ID,
            BoxMinterError::InvalidLogWrapper
        );

        // Delivery record PDA: `delivery` + config + delivery_id.
        let config_key = ctx.accounts.config.key();
        let delivery_id_bytes = args.delivery_id.to_le_bytes();
        let expected_delivery = Pubkey::create_program_address(
            &[
                SEED_DELIVERY,
                config_key.as_ref(),
                &delivery_id_bytes,
                &[args.delivery_bump],
            ],
            ctx.program_id,
        )
        .map_err(|_| error!(BoxMinterError::InvalidDeliveryPda))?;
        require_keys_eq!(
            ctx.accounts.delivery.key(),
            expected_delivery,
            BoxMinterError::InvalidDeliveryPda
        );
        let delivery_ai = ctx.accounts.delivery.to_account_info();
        // Create (or reclaim) the tiny on-chain delivery record (presence == paid order).
        //
        // Note: a PDA can be "pre-funded", creating a system-owned stub account that makes
        // `system_instruction::create_account` fail ("account already in use"). Since this is a PDA,
        // we can sign for it and reclaim it via `allocate` + `assign`.
        let delivery_space: usize = DeliveryRecord::SPACE;
        let delivery_bump_bytes = [args.delivery_bump];
        let delivery_seeds: &[&[u8]] = &[
            SEED_DELIVERY,
            config_key.as_ref(),
            &delivery_id_bytes,
            &delivery_bump_bytes,
        ];
        create_or_reclaim_empty_pda_account(
            &delivery_ai,
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            delivery_space,
            ctx.program_id,
            delivery_seeds,
            BoxMinterError::InvalidDeliveryPda,
            BoxMinterError::DeliveryAlreadyExists,
        )?;

        let record = DeliveryRecord {
            payer: ctx.accounts.payer.key(),
            delivery_fee_lamports: args.delivery_fee_lamports,
            item_count: ctx.remaining_accounts.len() as u16,
        };
        record.try_serialize(&mut &mut delivery_ai.data.borrow_mut()[..])?;

        // Take delivery payment (enforced on-chain).
        if args.delivery_fee_lamports > 0 {
            let ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.treasury.key(),
                args.delivery_fee_lamports,
            );
            invoke(
                &ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.treasury.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // Transfer all delivered assets to the vault (config.admin) via MPL-Core `TransferV1`.
        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        // Vault is the admin/cosigner key (custody); payment receiver is `config.treasury`.
        let vault = ctx.accounts.cosigner.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let log_wrapper = ctx.accounts.log_wrapper.to_account_info();

        let mut transfer_ix = Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // asset, collection, payer, authority, new_owner, system_program, log_wrapper
                AccountMeta::new(Pubkey::default(), false), // asset placeholder
                AccountMeta::new_readonly(core_collection.key(), false),
                AccountMeta::new(payer.key(), true),
                AccountMeta::new_readonly(payer.key(), true),
                AccountMeta::new_readonly(vault.key(), false),
                AccountMeta::new_readonly(system_program.key(), false),
                AccountMeta::new_readonly(log_wrapper.key(), false),
            ],
            // TransferV1 discriminator=14, compression_proof=None (0)
            data: vec![14u8, 0u8],
        };

        for asset_ai in ctx.remaining_accounts.iter() {
            transfer_ix.accounts[0].pubkey = asset_ai.key();
            invoke(
                &transfer_ix,
                &[
                    asset_ai.clone(),
                    core_collection.clone(),
                    payer.clone(),
                    payer.clone(),
                    vault.clone(),
                    system_program.clone(),
                    log_wrapper.clone(),
                    mpl_core_program.clone(),
                ],
            )?;
        }
        Ok(())
    }

    pub fn close_delivery(_ctx: Context<CloseDelivery>, _args: CloseDeliveryArgs) -> Result<()> {
        // The `CloseDelivery` account constraints enforce:
        // - `cosigner` == `config.admin`
        // - `delivery` is the expected PDA
        // - `delivery` is closed to `cosigner` (rent reclaimed) via Anchor's canonical close path
        Ok(())
    }

    /// Admin-only off-chain order fulfillment for drops.
    ///
    /// This reserves a contiguous run of variant metadata ids, creates an idempotency PDA keyed by
    /// the off-chain order hash, and mints the matching receipt cNFTs to the recipient wallet.
    /// For non-variant drops, `variant_index` is ignored and the order record stores `0`.
    /// Exact retries of a fulfilled order are accepted as no-ops.
    pub fn admin_deliver_variant_order(
        ctx: Context<AdminDeliverVariantOrder>,
        args: AdminDeliverVariantOrderArgs,
    ) -> Result<()> {
        validate_admin_order_hash(&args.order_hash)?;
        require!(args.quantity >= 1, BoxMinterError::InvalidQuantity);

        let config_key = ctx.accounts.config.key();
        let order_bump = validate_admin_order_pda(
            ctx.program_id,
            &config_key,
            &args.order_hash,
            ctx.accounts.admin_order.key(),
        )?;
        let order_bump_bytes = [order_bump];
        let order_seeds: &[&[u8]] = &[
            SEED_ADMIN_ORDER,
            config_key.as_ref(),
            args.order_hash.as_ref(),
            &order_bump_bytes,
        ];

        let order_ai = ctx.accounts.admin_order.to_account_info();
        let receipt_owner = ctx.accounts.receipt_owner.key();
        let effective_variant_index =
            admin_delivery_effective_variant_index(&ctx.accounts.config, args.variant_index);
        require!(
            receipt_owner != Pubkey::default(),
            BoxMinterError::InvalidReceiptOwner
        );
        if !order_ai.data_is_empty() {
            let existing = deserialize_admin_order_record(&order_ai, ctx.program_id)?;
            require!(
                admin_order_is_valid_retry(
                    &existing,
                    &args,
                    effective_variant_index,
                    receipt_owner,
                    order_bump,
                ),
                BoxMinterError::AdminOrderAlreadyExists
            );
            return Ok(());
        }
        let receipt_accounts = ReceiptMintAccounts::from_admin_delivery(&ctx.accounts);
        validate_receipt_mint_accounts(&receipt_accounts)?;

        let first_metadata_id = reserve_admin_delivery_metadata_ids(
            &mut *ctx.accounts.config,
            effective_variant_index,
            args.quantity,
        )?;

        create_or_reclaim_empty_pda_account(
            &order_ai,
            &ctx.accounts.cosigner.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            AdminDeliveryOrderRecord::SPACE,
            ctx.program_id,
            order_seeds,
            BoxMinterError::InvalidAdminOrderPda,
            BoxMinterError::AdminOrderAlreadyExists,
        )?;

        let record = AdminDeliveryOrderRecord {
            order_hash: args.order_hash,
            variant_index: effective_variant_index,
            quantity: args.quantity,
            first_metadata_id,
            receipt_owner,
            created_slot: Clock::get()?.slot,
            bump: order_bump,
        };
        record.try_serialize(&mut &mut order_ai.data.borrow_mut()[..])?;
        mint_admin_order_receipt_cnfts(
            &ctx.accounts.config,
            &receipt_accounts,
            first_metadata_id,
            args.quantity,
        )
    }

    /// Mint compressed (Bubblegum v2) receipt cNFTs into the receipts tree, admin/cosigner-only.
    ///
    /// This is used by:
    /// - delivery receipt issuance (boxes + figures)
    /// - IRL claim flow (figures)
    ///
    /// Receipt metadata is derived on-chain from the configured `config.uri_base` so the backend
    /// does not duplicate receipt URI/name logic.
    pub fn mint_receipts(ctx: Context<MintReceipts>, args: MintReceiptsArgs) -> Result<()> {
        let cfg = &ctx.accounts.config;

        // Admin-only (server cosigner).
        require_keys_eq!(
            ctx.accounts.cosigner.key(),
            cfg.admin,
            BoxMinterError::InvalidCosigner
        );

        let box_ids = args.box_ids;
        let dude_ids = args.dude_ids;
        let max_dude_id = cfg.max_figure_id()?;

        // Defensive caps (Bubblegum mints are compute-heavy).
        let total = box_ids
            .len()
            .checked_add(dude_ids.len())
            .ok_or(BoxMinterError::MathOverflow)?;
        require!(total > 0, BoxMinterError::InvalidQuantity);
        // Conservative cap; if the backend wants more, it should batch.
        require!(total <= 24, BoxMinterError::InvalidQuantity);

        // Validate box IDs (must correspond to configured box supply).
        for id in box_ids.iter() {
            require!(
                *id >= 1 && *id <= cfg.max_supply,
                BoxMinterError::InvalidAssetMetadata
            );
        }
        // Validate dude IDs.
        for id in dude_ids.iter() {
            require!(
                *id >= 1 && *id <= max_dude_id,
                BoxMinterError::InvalidDudeId
            );
        }
        // Ensure there are no duplicates (cheap O(n^2) since n is tiny).
        for i in 0..box_ids.len() {
            for j in (i + 1)..box_ids.len() {
                require!(
                    box_ids[i] != box_ids[j],
                    BoxMinterError::InvalidAssetMetadata
                );
            }
        }
        for i in 0..dude_ids.len() {
            for j in (i + 1)..dude_ids.len() {
                require!(dude_ids[i] != dude_ids[j], BoxMinterError::DuplicateDudeId);
            }
        }

        let receipt_accounts = ReceiptMintAccounts::from_mint_receipts(&ctx.accounts);
        validate_receipt_mint_accounts(&receipt_accounts)?;

        let drop_base = cfg.uri_base.as_str();
        let mut mint_cpi = new_receipt_mint_cpi(&receipt_accounts);

        let mut name_buf = String::with_capacity(48);
        let mut uri_buf = String::with_capacity(
            drop_base.len()
                + URI_PREFIX_RECEIPTS_BOXES
                    .len()
                    .max(URI_PREFIX_RECEIPTS_FIGURES.len())
                + 16,
        );

        for box_id in box_ids.iter() {
            build_receipt_name_and_uri(
                &mut name_buf,
                &mut uri_buf,
                drop_base,
                &cfg.name_prefix,
                URI_PREFIX_RECEIPTS_BOXES,
                *box_id,
            )?;
            invoke_receipt_mint_v2(&mut mint_cpi, cfg.core_collection, &name_buf, &uri_buf)?;
        }

        for dude_id in dude_ids.iter() {
            build_receipt_name_and_uri(
                &mut name_buf,
                &mut uri_buf,
                drop_base,
                &cfg.figure_name_prefix,
                URI_PREFIX_RECEIPTS_FIGURES,
                *dude_id,
            )?;
            invoke_receipt_mint_v2(&mut mint_cpi, cfg.core_collection, &name_buf, &uri_buf)?;
        }

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub price_lamports: u64,
    pub discount_price_lamports: u64,
    pub discount_merkle_root: [u8; 32],
    pub max_supply: u32,
    pub max_per_tx: u8,
    pub items_per_box: u8,
    pub name_prefix: String,
    pub symbol: String,
    pub uri_base: String,
    pub discount_mints_per_wallet: u8,
    pub figure_name_prefix: String,
    pub mint_variant_kind: u8,
    pub mint_variant_start_ids: [u32; MINT_VARIANT_OPTION_COUNT],
    pub mint_variant_end_ids: [u32; MINT_VARIANT_OPTION_COUNT],
    pub mint_variant_next_ids: [u32; MINT_VARIANT_OPTION_COUNT],
    pub drop_seed: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FinalizeOpenBoxArgs {
    pub dude_ids: Vec<u16>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DeliverArgs {
    pub delivery_id: u32,
    pub delivery_fee_lamports: u64,
    /// PDA bump for `delivery` record (passed from client to avoid find_program_address compute).
    pub delivery_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CloseDeliveryArgs {
    pub delivery_id: u32,
    pub delivery_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MintReceiptsArgs {
    pub box_ids: Vec<u32>,
    pub dude_ids: Vec<u16>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AdminDeliverVariantOrderArgs {
    pub order_hash: [u8; 32],
    /// Ignored for non-variant drops.
    pub variant_index: u8,
    pub quantity: u8,
}

#[account]
pub struct BoxMinterConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub core_collection: Pubkey,
    pub price_lamports: u64,
    pub discount_price_lamports: u64,
    pub discount_merkle_root: [u8; 32],
    pub max_supply: u32,
    pub max_per_tx: u8,
    pub items_per_box: u8,
    pub minted: u32,
    pub name_prefix: String,
    pub symbol: String,
    pub uri_base: String,
    /// If false, `mint_boxes` is paused.
    pub started: bool,
    pub bump: u8,
    pub discount_mints_per_wallet: u8,
    pub figure_name_prefix: String,
    pub mint_variant_kind: u8,
    pub mint_variant_start_ids: [u32; MINT_VARIANT_OPTION_COUNT],
    pub mint_variant_end_ids: [u32; MINT_VARIANT_OPTION_COUNT],
    pub mint_variant_next_ids: [u32; MINT_VARIANT_OPTION_COUNT],
    pub drop_seed: [u8; 32],
}

#[account]
pub struct DiscountMintRecord {
    pub payer: Pubkey,
    pub minted: u8,
    pub bump: u8,
}

impl DiscountMintRecord {
    pub const SPACE: usize = 8 // anchor account discriminator
        + 32 // payer
        + 1 // minted
        + 1; // bump
}

#[account]
pub struct DeliveryRecord {
    pub payer: Pubkey,
    pub delivery_fee_lamports: u64,
    pub item_count: u16,
}

impl DeliveryRecord {
    pub const SPACE: usize = 8 // anchor account discriminator
        + 32 // payer
        + 8 // delivery_fee_lamports
        + 2; // item_count
}

#[account]
pub struct AdminDeliveryOrderRecord {
    pub order_hash: [u8; 32],
    pub variant_index: u8,
    pub quantity: u8,
    pub first_metadata_id: u32,
    pub receipt_owner: Pubkey,
    pub created_slot: u64,
    pub bump: u8,
}

impl AdminDeliveryOrderRecord {
    pub const SPACE: usize = 8 // anchor account discriminator
        + 32 // order_hash
        + 1 // variant_index
        + 1 // quantity
        + 4 // first_metadata_id
        + 32 // receipt_owner
        + 8 // created_slot
        + 1; // bump
}

impl BoxMinterConfig {
    pub const SEED: &'static [u8] = b"config";

    // Keep these tiny by design; uncompressed Core mints are compute heavy.
    pub const MAX_NAME_PREFIX: usize = 8;
    pub const MAX_FIGURE_NAME_PREFIX: usize = 12;
    pub const MAX_SYMBOL: usize = 10;
    pub const MAX_URI_BASE: usize = 96;

    pub const SPACE: usize = 8 // anchor account discriminator
        + 32 * 3 // pubkeys
        + 8 // price_lamports
        + 8 // discount_price_lamports
        + 32 // discount_merkle_root
        + 4 // max_supply
        + 1 // max_per_tx
        + 1 // items_per_box
        + 4 // minted
        + 4 + Self::MAX_NAME_PREFIX // name_prefix
        + 4 + Self::MAX_SYMBOL // symbol
        + 4 + Self::MAX_URI_BASE // uri_base
        + 1 // started (bool)
        + 1 // bump
        + 1 // discount_mints_per_wallet
        + 4 + Self::MAX_FIGURE_NAME_PREFIX // figure_name_prefix
        + 1 // mint_variant_kind
        + 4 * MINT_VARIANT_OPTION_COUNT // mint_variant_start_ids
        + 4 * MINT_VARIANT_OPTION_COUNT // mint_variant_end_ids
        + 4 * MINT_VARIANT_OPTION_COUNT // mint_variant_next_ids
        + 32; // drop_seed

    pub fn items_per_box_len(&self) -> usize {
        self.items_per_box as usize
    }

    pub fn require_openable(&self) -> Result<()> {
        require!(
            self.items_per_box >= MIN_OPENABLE_ITEMS_PER_BOX,
            BoxMinterError::OpeningDisabled
        );
        Ok(())
    }

    pub fn max_figure_id(&self) -> Result<u16> {
        let total = (self.max_supply as u64)
            .checked_mul(self.items_per_box as u64)
            .ok_or(BoxMinterError::MathOverflow)?;
        require!(total <= u16::MAX as u64, BoxMinterError::InvalidItemsPerBox);
        Ok(total as u16)
    }

    pub fn requires_variant_selection(&self) -> bool {
        self.mint_variant_kind == MINT_VARIANT_KIND_SIZE
    }

    pub fn variant_slot(&self, variant_index: u8) -> Result<usize> {
        require!(
            self.requires_variant_selection(),
            BoxMinterError::MintVariantSelectionRequired
        );
        let slot = usize::from(variant_index);
        require!(
            slot < MINT_VARIANT_OPTION_COUNT,
            BoxMinterError::InvalidMintVariant
        );
        Ok(slot)
    }

    pub fn next_variant_metadata_id(&self, slot: usize) -> Result<u32> {
        require!(
            slot < MINT_VARIANT_OPTION_COUNT,
            BoxMinterError::InvalidMintVariant
        );
        let next_id = self.mint_variant_next_ids[slot];
        let start_id = self.mint_variant_start_ids[slot];
        let end_id = self.mint_variant_end_ids[slot];
        require!(
            next_id >= start_id,
            BoxMinterError::InvalidMintVariantConfig
        );
        require!(next_id <= end_id, BoxMinterError::MintVariantUnavailable);
        Ok(next_id)
    }
}

#[account]
pub struct PendingOpenBox {
    /// User who started the open.
    pub owner: Pubkey,
    /// The box asset being opened (now owned by the vault).
    pub box_asset: Pubkey,
    /// Placeholder dude asset accounts to be updated + transferred on finalize.
    pub dudes: Vec<Pubkey>,
    /// Slot when the pending record was created (for UX ordering).
    pub created_slot: u64,
    /// PDA bump for this record.
    pub bump: u8,
    /// Config PDA that created this pending record. Shared-program drops use this to
    /// disambiguate pending reveals without relying on external indexers.
    pub config: Pubkey,
}

impl PendingOpenBox {
    pub fn space(items_per_box: u8) -> usize {
        8 // anchor discriminator
        + 32 // owner
        + 32 // box_asset
        + 4 // dudes vec len
        + 32 * items_per_box as usize // dudes
        + 8 // created_slot
        + 1 // bump
        + 32 // config
    }
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
struct PendingOpenBoxLegacyLayout {
    pub owner: Pubkey,
    pub box_asset: Pubkey,
    pub dudes: Vec<Pubkey>,
    pub created_slot: u64,
    pub bump: u8,
}

#[cfg_attr(not(test), allow(dead_code))]
struct PendingOpenBoxDecoded {
    pub owner: Pubkey,
    pub box_asset: Pubkey,
    pub dudes: Vec<Pubkey>,
    pub created_slot: u64,
    pub bump: u8,
    pub config: Option<Pubkey>,
}

fn decode_pending_open_box_account(data: &[u8]) -> Result<PendingOpenBoxDecoded> {
    const MIN_PENDING_OPEN_BOX_LEN: usize = 8 + 32 + 32 + 4 + 8 + 1;

    require!(
        data.len() >= MIN_PENDING_OPEN_BOX_LEN,
        BoxMinterError::InvalidPendingRecord
    );
    require!(
        data.get(..8) == Some(PendingOpenBox::DISCRIMINATOR.as_ref()),
        BoxMinterError::InvalidPendingRecord
    );

    let mut o = 8usize;
    let owner = read_pubkey(data, o)?;
    o += 32;
    let box_asset = read_pubkey(data, o)?;
    o += 32;
    let dude_count = read_u32_le_pending(data, o)? as usize;
    o += 4;

    let dude_bytes = dude_count
        .checked_mul(32)
        .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
    let dudes_end = o
        .checked_add(dude_bytes)
        .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
    require!(
        dudes_end <= data.len(),
        BoxMinterError::InvalidPendingRecord
    );

    let mut dudes = Vec::with_capacity(dude_count);
    for _ in 0..dude_count {
        dudes.push(read_pubkey(data, o)?);
        o += 32;
    }

    let created_slot = read_u64_le(data, o)?;
    o += 8;
    let bump = *data
        .get(o)
        .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
    o += 1;

    let config = if o == data.len() {
        None
    } else {
        let config_end = o
            .checked_add(32)
            .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
        require!(
            config_end == data.len(),
            BoxMinterError::InvalidPendingRecord
        );
        Some(read_pubkey(data, o)?)
    };

    Ok(PendingOpenBoxDecoded {
        owner,
        box_asset,
        dudes,
        created_slot,
        bump,
        config,
    })
}

fn close_program_account<'info>(
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
) -> Result<()> {
    let account_lamports = account.lamports();
    let destination_lamports = destination.lamports();
    let updated_destination_lamports = destination_lamports
        .checked_add(account_lamports)
        .ok_or(error!(BoxMinterError::MathOverflow))?;

    **destination.try_borrow_mut_lamports()? = updated_destination_lamports;
    **account.try_borrow_mut_lamports()? = 0;
    account.assign(&anchor_lang::solana_program::system_program::ID);
    account.resize(0)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = BoxMinterConfig::SPACE,
        seeds = [BoxMinterConfig::SEED, args.drop_seed.as_ref()],
        bump,
    )]
    pub config: Account<'info, BoxMinterConfig>,

    #[account(
        mut,
        constraint = admin.key() == EXPECTED_INITIALIZER @ BoxMinterError::UnauthorizedInitializer
    )]
    pub admin: Signer<'info>,

    /// CHECK: Any SOL receiver is fine; stored in config.
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection address; stored in config and validated (owner == mpl-core program).
    pub core_collection: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetTreasury<'info> {
    #[account(mut, seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump, has_one = admin)]
    pub config: Account<'info, BoxMinterConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetMintPrices<'info> {
    #[account(mut, seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump, has_one = admin)]
    pub config: Account<'info, BoxMinterConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct StartMint<'info> {
    #[account(mut, seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump, has_one = admin)]
    pub config: Account<'info, BoxMinterConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MintBoxes<'info> {
    #[account(mut, seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Must match config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(mut, address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintDiscountedBox<'info> {
    #[account(mut, seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Discount mint record PDA. The handler creates it on demand or loads the existing
    /// program-owned record after validating the PDA seeds above.
    #[account(
        mut,
        seeds = [SEED_DISCOUNT_MINT, config.key().as_ref(), payer.key().as_ref()],
        bump,
    )]
    pub discount_record: UncheckedAccount<'info>,

    /// CHECK: Must match config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(mut, address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartOpenBox<'info> {
    #[account(seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Existing box Core asset account to transfer to the vault.
    #[account(mut)]
    pub box_asset: UncheckedAccount<'info>,

    /// CHECK: Must match config.admin (vault that receives box transfers and temporarily owns placeholder dudes).
    #[account(address = config.admin)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: SPL Noop program (MPL-Core log wrapper).
    #[account(address = SPL_NOOP_PROGRAM_ID)]
    pub log_wrapper: UncheckedAccount<'info>,

    /// CHECK: Pending open record PDA derived from `[SEED_PENDING_OPEN, box_asset]`.
    ///
    /// This is intentionally `UncheckedAccount` so the handler can create it or reclaim a
    /// pre-funded PDA stub (PDA squatting). The handler checks that the account is either
    /// uninitialized (`data_is_empty()` / system-owned stub) or, after creation, a properly-sized
    /// program-owned account, and it will never overwrite an initialized record.
    #[account(
        mut,
        seeds = [SEED_PENDING_OPEN, box_asset.key().as_ref()],
        bump,
    )]
    pub pending: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FinalizeOpenBox<'info> {
    #[account(seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin).
    #[account(mut)]
    pub cosigner: Signer<'info>,

    /// CHECK: Vault-owned box Core asset to burn.
    #[account(mut)]
    pub box_asset: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(mut, address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: SPL Noop program (MPL-Core log wrapper).
    #[account(address = SPL_NOOP_PROGRAM_ID)]
    pub log_wrapper: UncheckedAccount<'info>,

    /// CHECK: Pending open record PDA. The handler manually decodes either the legacy or v2 layout,
    /// then explicitly closes the account after a successful finalize to preserve backward
    /// compatibility for in-flight opens created before the `config` field was added.
    #[account(
        mut,
        seeds = [SEED_PENDING_OPEN, box_asset.key().as_ref()],
        bump
    )]
    pub pending: UncheckedAccount<'info>,

    /// CHECK: User who will receive the dudes (must equal `pending.owner`).
    pub user: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Deliver<'info> {
    #[account(seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin).
    pub cosigner: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Must match config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: SPL Noop program (MPL-Core log wrapper).
    #[account(address = SPL_NOOP_PROGRAM_ID)]
    pub log_wrapper: UncheckedAccount<'info>,

    /// CHECK: Delivery record PDA (created by this instruction).
    #[account(mut)]
    pub delivery: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(args: CloseDeliveryArgs)]
pub struct CloseDelivery<'info> {
    #[account(seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin).
    #[account(mut, address = config.admin)]
    pub cosigner: Signer<'info>,

    /// Delivery record PDA to close (rent reclaimed to `cosigner`).
    #[account(
        mut,
        seeds = [SEED_DELIVERY, config.key().as_ref(), &args.delivery_id.to_le_bytes()],
        bump = args.delivery_bump,
        close = cosigner
    )]
    pub delivery: Account<'info, DeliveryRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminDeliverVariantOrder<'info> {
    #[account(mut, seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin); pays for and authorizes the receipt mints.
    #[account(mut, address = config.admin @ BoxMinterError::InvalidCosigner)]
    pub cosigner: Signer<'info>,

    /// CHECK: Buyer/admin wallet that receives the receipt cNFTs. The handler rejects the default
    /// pubkey; Bubblegum only needs this account's key as leaf owner/delegate.
    pub receipt_owner: UncheckedAccount<'info>,

    /// CHECK: Admin order PDA for `[SEED_ADMIN_ORDER, config, order_hash]`. The handler validates
    /// the canonical PDA/bump, then creates it only if it is uninitialized or a system-owned stub.
    #[account(mut)]
    pub admin_order: UncheckedAccount<'info>,

    /// CHECK: Receipt cNFT Merkle tree (owned by MPL account compression program).
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,

    /// CHECK: Bubblegum tree config PDA for `merkle_tree`.
    #[account(mut)]
    pub tree_config: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(mut, address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Bubblegum program.
    pub bubblegum_program: UncheckedAccount<'info>,

    /// CHECK: Metaplex Noop program (Bubblegum v2 log wrapper).
    #[account(address = MPL_NOOP_PROGRAM_ID)]
    pub log_wrapper: UncheckedAccount<'info>,

    /// CHECK: Metaplex Account Compression program.
    #[account(address = MPL_ACCOUNT_COMPRESSION_PROGRAM_ID)]
    pub compression_program: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program.
    #[account(address = MPL_CORE_PROGRAM_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    /// CHECK: Bubblegum -> MPL-Core CPI signer.
    #[account(address = MPL_CORE_CPI_SIGNER)]
    pub mpl_core_cpi_signer: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintReceipts<'info> {
    #[account(seeds = [BoxMinterConfig::SEED, config.drop_seed.as_ref()], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin).
    #[account(mut)]
    pub cosigner: Signer<'info>,

    /// CHECK: User who will receive the receipt cNFTs.
    pub user: UncheckedAccount<'info>,

    /// CHECK: Receipt cNFT Merkle tree (owned by MPL account compression program).
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,

    /// CHECK: Bubblegum tree config PDA for `merkle_tree`.
    #[account(mut)]
    pub tree_config: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(mut, address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Bubblegum program
    pub bubblegum_program: UncheckedAccount<'info>,

    /// CHECK: Metaplex Noop program (Bubblegum v2 log wrapper).
    #[account(address = MPL_NOOP_PROGRAM_ID)]
    pub log_wrapper: UncheckedAccount<'info>,

    /// CHECK: Metaplex Account Compression program.
    #[account(address = MPL_ACCOUNT_COMPRESSION_PROGRAM_ID)]
    pub compression_program: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    #[account(address = MPL_CORE_PROGRAM_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    /// CHECK: Bubblegum -> MPL-Core CPI signer.
    #[account(address = MPL_CORE_CPI_SIGNER)]
    pub mpl_core_cpi_signer: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

const MAX_MPL_CORE_NAME_BYTES: usize = 128;
const MAX_MPL_CORE_URI_BYTES: usize = 256;

struct ParsedMplCoreBaseAssetV1<'a> {
    owner: Pubkey,
    // UpdateAuthority enum discriminator: 0=None, 1=Address, 2=Collection
    update_authority_kind: u8,
    // Only meaningful for kinds 1/2; otherwise default pubkey.
    update_authority: Pubkey,
    // Borrowed slice of the URI bytes (utf-8).
    uri: &'a [u8],
}

fn read_u32_le(data: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    let slice = data
        .get(offset..end)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u32_le_pending(data: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
    let slice = data
        .get(offset..end)
        .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u64_le(data: &[u8], offset: usize) -> Result<u64> {
    let end = offset
        .checked_add(8)
        .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
    let slice = data
        .get(offset..end)
        .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
    Ok(u64::from_le_bytes([
        slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
    ]))
}

fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    let end = offset
        .checked_add(32)
        .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
    let slice = data
        .get(offset..end)
        .ok_or(error!(BoxMinterError::InvalidPendingRecord))?;
    let mut key = [0u8; 32];
    key.copy_from_slice(slice);
    Ok(Pubkey::new_from_array(key))
}

fn parse_mpl_core_base_asset_v1(data: &[u8]) -> Result<ParsedMplCoreBaseAssetV1<'_>> {
    // Borsh layout: Key(u8) + owner(32) + update_authority(enum) + name(String) + uri(String) + seq(Option<u64>)
    if data.len() < 1 + 32 + 1 + 4 + 4 + 1 {
        return Err(error!(BoxMinterError::InvalidAsset));
    }
    let mut o: usize = 0;

    // Key::AssetV1 == 1
    let key = data[0];
    if key != 1 {
        return Err(error!(BoxMinterError::InvalidAsset));
    }
    o += 1;

    let owner_bytes: [u8; 32] = data
        .get(o..o + 32)
        .ok_or(error!(BoxMinterError::InvalidAsset))?
        .try_into()
        .map_err(|_| error!(BoxMinterError::InvalidAsset))?;
    let owner = Pubkey::new_from_array(owner_bytes);
    o += 32;

    let update_kind = *data.get(o).ok_or(error!(BoxMinterError::InvalidAsset))?;
    o += 1;
    let mut update_pk = Pubkey::default();
    match update_kind {
        0 => {}
        1 | 2 => {
            let bytes: [u8; 32] = data
                .get(o..o + 32)
                .ok_or(error!(BoxMinterError::InvalidAsset))?
                .try_into()
                .map_err(|_| error!(BoxMinterError::InvalidAsset))?;
            update_pk = Pubkey::new_from_array(bytes);
            o += 32;
        }
        _ => return Err(error!(BoxMinterError::InvalidAsset)),
    }

    let name_len = read_u32_le(data, o)? as usize;
    o = o
        .checked_add(4)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    if name_len > MAX_MPL_CORE_NAME_BYTES {
        return Err(error!(BoxMinterError::InvalidAsset));
    }
    o = o
        .checked_add(name_len)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    if o > data.len() {
        return Err(error!(BoxMinterError::InvalidAsset));
    }

    let uri_len = read_u32_le(data, o)? as usize;
    o = o
        .checked_add(4)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    if uri_len > MAX_MPL_CORE_URI_BYTES {
        return Err(error!(BoxMinterError::InvalidAsset));
    }
    let uri_end = o
        .checked_add(uri_len)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    let uri = data
        .get(o..uri_end)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;

    Ok(ParsedMplCoreBaseAssetV1 {
        owner,
        update_authority_kind: update_kind,
        update_authority: update_pk,
        uri,
    })
}

fn parse_ref_id_from_uri_bytes(uri: &[u8], drop_base: &str, uri_suffix: &str) -> Option<u32> {
    let drop = drop_base.as_bytes();
    if !uri.starts_with(drop) {
        return None;
    }
    let rest = &uri[drop.len()..];
    let suffix = uri_suffix.as_bytes();
    if !rest.starts_with(suffix) {
        return None;
    }
    let rest = &rest[suffix.len()..];
    if rest.len() < 5 || !rest.ends_with(b".json") {
        return None;
    }
    let stem = &rest[..rest.len() - 5];
    if stem.is_empty() || stem.iter().any(|b| *b == b'/') {
        return None;
    }
    let mut out: u32 = 0;
    for b in stem {
        if !b.is_ascii_digit() {
            return None;
        }
        out = out.checked_mul(10)?;
        out = out.checked_add((b - b'0') as u32)?;
    }
    if out == 0 {
        return None;
    }
    Some(out)
}

fn verify_core_asset_owned_by_uri(
    asset_ai: &AccountInfo,
    owner: Pubkey,
    core_collection: Pubkey,
    expected_drop_base: &str,
    expected_uri_suffix: &str,
    expected_ref_id: Option<u32>,
) -> Result<()> {
    require_keys_eq!(
        *asset_ai.owner,
        MPL_CORE_PROGRAM_ID,
        BoxMinterError::InvalidAsset
    );
    let data = asset_ai.try_borrow_data()?;
    let base = parse_mpl_core_base_asset_v1(&data)?;
    require_keys_eq!(base.owner, owner, BoxMinterError::InvalidAssetOwner);
    require!(
        base.update_authority_kind == 2 && base.update_authority == core_collection,
        BoxMinterError::InvalidAssetCollection
    );

    // Ensure the asset corresponds to the expected kind by validating its URI prefix and (optionally) id.
    let parsed = parse_ref_id_from_uri_bytes(base.uri, expected_drop_base, expected_uri_suffix)
        .ok_or(error!(BoxMinterError::InvalidAssetMetadata))?;
    if let Some(expected) = expected_ref_id {
        require!(parsed == expected, BoxMinterError::InvalidAssetMetadata);
    }
    Ok(())
}

fn borsh_push_string(out: &mut Vec<u8>, value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    require!(
        bytes.len() <= u32::MAX as usize,
        BoxMinterError::SerializationFailed
    );
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

fn append_label_and_id(
    name_buf: &mut String,
    label: &str,
    id: impl core::fmt::Display,
) -> Result<()> {
    name_buf.push_str(label);
    if !label.is_empty() && !label.ends_with(' ') {
        name_buf.push(' ');
    }
    write!(name_buf, "{}", id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
    Ok(())
}

#[error_code]
pub enum BoxMinterError {
    #[msg("Invalid quantity")]
    InvalidQuantity,
    #[msg("Sold out")]
    SoldOut,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid max supply")]
    InvalidMaxSupply,
    #[msg("Invalid max per transaction")]
    InvalidMaxPerTx,
    #[msg("Invalid items per box")]
    InvalidItemsPerBox,
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Invalid discount price")]
    InvalidDiscountPrice,
    #[msg("Invalid discount allowance per wallet")]
    InvalidDiscountMintsPerWallet,
    #[msg("Discount config missing")]
    DiscountNotConfigured,
    #[msg("Invalid discount proof")]
    InvalidDiscountProof,
    #[msg("Discount allowance exceeded")]
    DiscountAllowanceExceeded,
    #[msg("Name prefix too long")]
    NameTooLong,
    #[msg("Figure name prefix too long")]
    FigureNameTooLong,
    #[msg("Symbol too long")]
    SymbolTooLong,
    #[msg("URI base too long")]
    UriTooLong,
    #[msg("Invalid core collection")]
    InvalidCoreCollection,
    #[msg("Serialization failed")]
    SerializationFailed,
    #[msg("Invalid dude id")]
    InvalidDudeId,
    #[msg("Duplicate dude id")]
    DuplicateDudeId,
    #[msg("Invalid cosigner")]
    InvalidCosigner,
    #[msg("Invalid figure URI base")]
    InvalidFigureUriBase,
    #[msg("Invalid delivery fee")]
    InvalidDeliveryFee,
    #[msg("Invalid delivery item kind")]
    InvalidDeliveryItemKind,
    #[msg("Invalid remaining accounts")]
    InvalidRemainingAccounts,
    #[msg("Invalid Metaplex Core program id")]
    InvalidMplCoreProgram,
    #[msg("Invalid asset PDA")]
    InvalidAssetPda,
    #[msg("Invalid asset account")]
    InvalidAsset,
    #[msg("Asset owner mismatch")]
    InvalidAssetOwner,
    #[msg("Asset is not in the configured collection")]
    InvalidAssetCollection,
    #[msg("Asset metadata does not match expected kind/id")]
    InvalidAssetMetadata,
    #[msg("Missing required transfer instruction")]
    MissingTransferInstruction,
    #[msg("Invalid transfer instruction")]
    InvalidTransferInstruction,
    #[msg("Invalid pending open record")]
    InvalidPendingRecord,
    #[msg("Invalid discount record")]
    InvalidDiscountRecord,
    #[msg("Invalid delivery PDA")]
    InvalidDeliveryPda,
    #[msg("Delivery record already exists")]
    DeliveryAlreadyExists,
    #[msg("Invalid log wrapper program id")]
    InvalidLogWrapper,
    #[msg("Invalid Bubblegum program id")]
    InvalidBubblegumProgram,
    #[msg("Invalid MPL Noop program id")]
    InvalidMplNoopProgram,
    #[msg("Invalid compression program id")]
    InvalidCompressionProgram,
    #[msg("Invalid Bubblegum -> MPL-Core CPI signer address")]
    InvalidMplCoreCpiSigner,
    #[msg("Invalid receipts merkle tree account")]
    InvalidReceiptsMerkleTree,
    #[msg("Invalid receipts tree config PDA")]
    InvalidReceiptsTreeConfig,
    #[msg("Invalid receipt URI base")]
    InvalidReceiptUriBase,
    #[msg("Invalid metadata base")]
    InvalidMetadataBase,
    #[msg("Mint variant selection is required for this drop")]
    MintVariantSelectionRequired,
    #[msg("Invalid mint variant")]
    InvalidMintVariant,
    #[msg("Mint variant is sold out")]
    MintVariantUnavailable,
    #[msg("Invalid mint variant configuration")]
    InvalidMintVariantConfig,
    #[msg("Mint variant selection currently supports direct-delivery drops only")]
    MintVariantDirectDeliveryOnly,
    #[msg("Pending open record already exists")]
    PendingAlreadyExists,
    #[msg("Unauthorized initializer")]
    UnauthorizedInitializer,
    #[msg("Minting has not started yet")]
    MintNotStarted,
    #[msg("Opening is disabled for this drop")]
    OpeningDisabled,
    #[msg("Invalid drop seed")]
    InvalidDropSeed,
    #[msg("Invalid admin order PDA")]
    InvalidAdminOrderPda,
    #[msg("Admin order already exists")]
    AdminOrderAlreadyExists,
    #[msg("Invalid admin order")]
    InvalidAdminOrder,
    #[msg("Invalid receipt owner")]
    InvalidReceiptOwner,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_size_variant_cfg() -> BoxMinterConfig {
        BoxMinterConfig {
            admin: Pubkey::default(),
            treasury: Pubkey::default(),
            core_collection: Pubkey::default(),
            price_lamports: 1,
            discount_price_lamports: 1,
            discount_merkle_root: [1u8; 32],
            max_supply: 34,
            max_per_tx: 15,
            items_per_box: 0,
            minted: 0,
            name_prefix: "hoodie".to_string(),
            symbol: "hoodie".to_string(),
            uri_base: "https://assets.mons.link/drops/hoodie".to_string(),
            started: true,
            bump: 0,
            discount_mints_per_wallet: 1,
            figure_name_prefix: "hoodie".to_string(),
            mint_variant_kind: MINT_VARIANT_KIND_SIZE,
            mint_variant_start_ids: [1, 16, 31],
            mint_variant_end_ids: [15, 30, 34],
            mint_variant_next_ids: [1, 16, 31],
            drop_seed: [7u8; 32],
        }
    }

    fn test_standard_cfg() -> BoxMinterConfig {
        let mut cfg = test_size_variant_cfg();
        cfg.items_per_box = 2;
        cfg.mint_variant_kind = MINT_VARIANT_KIND_NONE;
        cfg.mint_variant_start_ids = [0; MINT_VARIANT_OPTION_COUNT];
        cfg.mint_variant_end_ids = [0; MINT_VARIANT_OPTION_COUNT];
        cfg.mint_variant_next_ids = [0; MINT_VARIANT_OPTION_COUNT];
        cfg
    }

    #[test]
    fn mint_price_validation_rejects_zero_or_inverted_discount() {
        assert!(validate_mint_prices(1, 1).is_ok());
        assert!(validate_mint_prices(2, 1).is_ok());
        assert!(validate_mint_prices(0, 1).is_err());
        assert!(validate_mint_prices(1, 0).is_err());
        assert!(validate_mint_prices(1, 2).is_err());
    }

    #[test]
    fn size_variant_initial_cursors_match_range_starts() {
        let cfg = test_size_variant_cfg();
        assert_eq!(cfg.variant_slot(0).unwrap(), 0);
        assert_eq!(cfg.variant_slot(1).unwrap(), 1);
        assert_eq!(cfg.variant_slot(2).unwrap(), 2);
        assert_eq!(cfg.next_variant_metadata_id(0).unwrap(), 1);
        assert_eq!(cfg.next_variant_metadata_id(1).unwrap(), 16);
        assert_eq!(cfg.next_variant_metadata_id(2).unwrap(), 31);
    }

    #[test]
    fn size_variant_advances_within_each_range() {
        let mut cfg = test_size_variant_cfg();
        cfg.mint_variant_next_ids[0] += 1;
        cfg.mint_variant_next_ids[1] += 1;
        cfg.mint_variant_next_ids[2] += 1;
        assert_eq!(cfg.next_variant_metadata_id(0).unwrap(), 2);
        assert_eq!(cfg.next_variant_metadata_id(1).unwrap(), 17);
        assert_eq!(cfg.next_variant_metadata_id(2).unwrap(), 32);
    }

    #[test]
    fn exhausting_one_size_does_not_block_other_sizes() {
        let mut cfg = test_size_variant_cfg();
        cfg.mint_variant_next_ids[0] = 16;
        assert!(cfg.next_variant_metadata_id(0).is_err());
        assert_eq!(cfg.next_variant_metadata_id(1).unwrap(), 16);
        assert_eq!(cfg.next_variant_metadata_id(2).unwrap(), 31);
    }

    #[test]
    fn exhausted_size_returns_error() {
        let mut cfg = test_size_variant_cfg();
        cfg.mint_variant_next_ids[2] = 35;
        assert!(cfg.next_variant_metadata_id(2).is_err());
    }

    #[test]
    fn admin_order_hash_must_be_nonzero() {
        assert!(validate_admin_order_hash(&[0u8; 32]).is_err());
        assert!(validate_admin_order_hash(&[9u8; 32]).is_ok());
    }

    #[test]
    fn admin_order_pda_returns_canonical_bump() {
        let program_id = Pubkey::new_unique();
        let config = Pubkey::new_unique();
        let order_hash = [9u8; 32];
        let (canonical_order, canonical_bump) = Pubkey::find_program_address(
            &[SEED_ADMIN_ORDER, config.as_ref(), order_hash.as_ref()],
            &program_id,
        );

        assert_eq!(
            validate_admin_order_pda(&program_id, &config, &order_hash, canonical_order).unwrap(),
            canonical_bump
        );

        assert!(
            validate_admin_order_pda(&program_id, &config, &order_hash, Pubkey::new_unique())
                .is_err()
        );
    }

    #[test]
    fn admin_order_match_accepts_only_exact_retry() {
        let receipt_owner = Pubkey::new_unique();
        let args = AdminDeliverVariantOrderArgs {
            order_hash: [9u8; 32],
            variant_index: 1,
            quantity: 2,
        };
        let record = AdminDeliveryOrderRecord {
            order_hash: args.order_hash,
            variant_index: args.variant_index,
            quantity: args.quantity,
            first_metadata_id: 16,
            receipt_owner,
            created_slot: 42,
            bump: 251,
        };

        assert!(admin_order_is_valid_retry(
            &record,
            &args,
            args.variant_index,
            receipt_owner,
            251
        ));

        let mut wrong_args = args.clone();
        wrong_args.variant_index = 2;
        assert!(!admin_order_is_valid_retry(
            &record,
            &wrong_args,
            wrong_args.variant_index,
            receipt_owner,
            251
        ));

        wrong_args = args.clone();
        wrong_args.quantity = 1;
        assert!(!admin_order_is_valid_retry(
            &record,
            &wrong_args,
            args.variant_index,
            receipt_owner,
            251
        ));

        wrong_args = args.clone();
        wrong_args.order_hash = [8u8; 32];
        assert!(!admin_order_is_valid_retry(
            &record,
            &wrong_args,
            args.variant_index,
            receipt_owner,
            251
        ));
        assert!(!admin_order_is_valid_retry(
            &record,
            &args,
            args.variant_index,
            Pubkey::new_unique(),
            251
        ));
        assert!(!admin_order_is_valid_retry(
            &record,
            &args,
            args.variant_index,
            receipt_owner,
            250
        ));

        let invalid_record = AdminDeliveryOrderRecord {
            first_metadata_id: 0,
            ..record
        };
        assert!(!admin_order_is_valid_retry(
            &invalid_record,
            &args,
            args.variant_index,
            receipt_owner,
            251
        ));

        let zero_quantity_args = AdminDeliverVariantOrderArgs {
            order_hash: [7u8; 32],
            variant_index: 1,
            quantity: 0,
        };
        let zero_quantity_record = AdminDeliveryOrderRecord {
            order_hash: zero_quantity_args.order_hash,
            variant_index: zero_quantity_args.variant_index,
            quantity: zero_quantity_args.quantity,
            first_metadata_id: 16,
            receipt_owner,
            created_slot: 42,
            bump: 251,
        };
        assert!(!admin_order_is_valid_retry(
            &zero_quantity_record,
            &zero_quantity_args,
            zero_quantity_args.variant_index,
            receipt_owner,
            251
        ));
    }

    #[test]
    fn admin_order_retry_uses_normalized_variant_for_non_variant_drop() {
        let receipt_owner = Pubkey::new_unique();
        let args = AdminDeliverVariantOrderArgs {
            order_hash: [9u8; 32],
            variant_index: 2,
            quantity: 1,
        };
        let record = AdminDeliveryOrderRecord {
            order_hash: args.order_hash,
            variant_index: 0,
            quantity: args.quantity,
            first_metadata_id: 7,
            receipt_owner,
            created_slot: 42,
            bump: 251,
        };

        assert!(admin_order_is_valid_retry(
            &record,
            &args,
            0,
            receipt_owner,
            251
        ));
    }

    #[test]
    fn admin_variant_delivery_reserves_next_size_id() {
        let mut cfg = test_size_variant_cfg();

        let id = reserve_admin_delivery_metadata_ids(&mut cfg, 1, 2).unwrap();

        assert_eq!(id, 16);
        assert_eq!(cfg.minted, 2);
        assert_eq!(cfg.mint_variant_next_ids, [1, 18, 31]);
    }

    #[test]
    fn admin_variant_delivery_rejects_sold_out_variant() {
        let mut cfg = test_size_variant_cfg();
        cfg.mint_variant_next_ids[0] = 15;

        assert!(reserve_admin_delivery_metadata_ids(&mut cfg, 0, 2).is_err());
        assert_eq!(cfg.minted, 0);
        assert_eq!(cfg.mint_variant_next_ids[0], 15);
    }

    #[test]
    fn admin_variant_delivery_requires_valid_quantity() {
        let mut cfg = test_size_variant_cfg();
        assert!(reserve_admin_delivery_metadata_ids(&mut cfg, 0, 0).is_err());

        cfg.max_per_tx = 1;
        assert!(reserve_admin_delivery_metadata_ids(&mut cfg, 0, 2).is_err());

        let mut boxed_variant_cfg = test_size_variant_cfg();
        boxed_variant_cfg.items_per_box = 1;
        assert!(reserve_admin_delivery_metadata_ids(&mut boxed_variant_cfg, 0, 1).is_ok());
    }

    #[test]
    fn admin_delivery_reserves_standard_ids_for_non_variant_drop() {
        let mut cfg = test_standard_cfg();
        cfg.minted = 4;

        let id = reserve_admin_delivery_metadata_ids(&mut cfg, 2, 3).unwrap();

        assert_eq!(id, 5);
        assert_eq!(cfg.minted, 7);
        assert_eq!(cfg.mint_variant_next_ids, [0; MINT_VARIANT_OPTION_COUNT]);
    }

    #[test]
    fn admin_variant_delivery_requires_started_drop() {
        let mut cfg = test_size_variant_cfg();
        cfg.started = false;

        assert!(reserve_admin_delivery_metadata_ids(&mut cfg, 1, 2).is_err());
        assert_eq!(cfg.minted, 0);
        assert_eq!(cfg.mint_variant_next_ids, [1, 16, 31]);
    }

    #[test]
    fn compact_uri_parser_accepts_current_asset_shapes() {
        let drop_base = "ipfs://bafycompactdrop";
        assert_eq!(
            parse_ref_id_from_uri_bytes(
                format!("{drop_base}/b12.json").as_bytes(),
                drop_base,
                URI_PREFIX_BOXES,
            ),
            Some(12)
        );
        assert_eq!(
            parse_ref_id_from_uri_bytes(
                format!("{drop_base}/f34.json").as_bytes(),
                drop_base,
                URI_PREFIX_FIGURES,
            ),
            Some(34)
        );
        assert_eq!(
            parse_ref_id_from_uri_bytes(
                format!("{drop_base}/rb56.json").as_bytes(),
                drop_base,
                URI_PREFIX_RECEIPTS_BOXES,
            ),
            Some(56)
        );
        assert_eq!(
            parse_ref_id_from_uri_bytes(
                format!("{drop_base}/rf78.json").as_bytes(),
                drop_base,
                URI_PREFIX_RECEIPTS_FIGURES,
            ),
            Some(78)
        );
    }

    #[test]
    fn compact_uri_parser_rejects_legacy_uri_shape() {
        let drop_base = "https://assets.example.com/drops/legacy";
        assert_eq!(
            parse_ref_id_from_uri_bytes(
                format!("{drop_base}/json/boxes/12.json").as_bytes(),
                drop_base,
                URI_PREFIX_BOXES,
            ),
            None
        );
    }

    #[test]
    fn metadata_base_validation_accepts_canonical_bases() {
        assert!(validate_metadata_base("https://assets.example.com/drops/lsb").is_ok());
        assert!(validate_metadata_base("http://localhost:3000/drops/lsb").is_ok());
        assert!(validate_metadata_base("ipfs://bafycompactdrop").is_ok());
    }

    #[test]
    fn metadata_base_validation_rejects_legacy_prefixes_and_json_files() {
        assert!(validate_metadata_base("banana").is_err());
        assert!(validate_metadata_base("https://assets.example.com/drops/lsb/json/boxes").is_err());
        assert!(
            validate_metadata_base("https://assets.example.com/drops/lsb/json/figures").is_err()
        );
        assert!(
            validate_metadata_base("https://assets.example.com/drops/lsb/json/receipts").is_err()
        );
        assert!(
            validate_metadata_base("https://assets.example.com/drops/lsb/collection.json").is_err()
        );
    }

    #[test]
    fn metadata_base_validation_rejects_query_strings_and_fragments() {
        assert!(
            validate_metadata_base("https://assets.example.com/drops/lsb?filename=drop").is_err()
        );
        assert!(validate_metadata_base("https://assets.example.com/drops/lsb#collection").is_err());
        assert!(validate_metadata_base("ipfs://bafycompactdrop?filename=drop").is_err());
        assert!(validate_metadata_base("ipfs://bafycompactdrop#collection").is_err());
    }

    #[test]
    fn metadata_base_validation_accepts_roots_with_compact_like_terminal_segments() {
        assert!(validate_metadata_base("https://assets.example.com/drops/b").is_ok());
        assert!(validate_metadata_base("https://assets.example.com/drops/f").is_ok());
        assert!(validate_metadata_base("ipfs://bafycompactdrop/rb").is_ok());
        assert!(validate_metadata_base("ipfs://bafycompactdrop/rf").is_ok());
    }

    #[test]
    fn decode_pending_open_box_account_supports_legacy_and_v2_layouts() {
        let legacy = PendingOpenBoxLegacyLayout {
            owner: Pubkey::new_unique(),
            box_asset: Pubkey::new_unique(),
            dudes: vec![Pubkey::new_unique(), Pubkey::new_unique()],
            created_slot: 42,
            bump: 7,
        };

        let mut legacy_data = PendingOpenBox::DISCRIMINATOR.to_vec();
        legacy.serialize(&mut legacy_data).unwrap();

        let decoded_legacy = decode_pending_open_box_account(&legacy_data).unwrap();
        assert_eq!(decoded_legacy.owner, legacy.owner);
        assert_eq!(decoded_legacy.box_asset, legacy.box_asset);
        assert_eq!(decoded_legacy.dudes, legacy.dudes);
        assert_eq!(decoded_legacy.created_slot, legacy.created_slot);
        assert_eq!(decoded_legacy.bump, legacy.bump);
        assert_eq!(decoded_legacy.config, None);

        let config = Pubkey::new_unique();
        let mut v2_data = legacy_data.clone();
        v2_data.extend_from_slice(config.as_ref());

        let decoded_v2 = decode_pending_open_box_account(&v2_data).unwrap();
        assert_eq!(decoded_v2.owner, legacy.owner);
        assert_eq!(decoded_v2.box_asset, legacy.box_asset);
        assert_eq!(decoded_v2.dudes, legacy.dudes);
        assert_eq!(decoded_v2.created_slot, legacy.created_slot);
        assert_eq!(decoded_v2.bump, legacy.bump);
        assert_eq!(decoded_v2.config, Some(config));
    }

    #[test]
    fn decode_pending_open_box_account_rejects_unexpected_trailing_bytes() {
        let legacy = PendingOpenBoxLegacyLayout {
            owner: Pubkey::new_unique(),
            box_asset: Pubkey::new_unique(),
            dudes: vec![Pubkey::new_unique()],
            created_slot: 7,
            bump: 1,
        };

        let mut invalid = PendingOpenBox::DISCRIMINATOR.to_vec();
        legacy.serialize(&mut invalid).unwrap();
        invalid.push(9);

        assert!(decode_pending_open_box_account(&invalid).is_err());
    }

    #[test]
    fn pending_open_space_includes_config_pubkey() {
        assert_eq!(
            PendingOpenBox::space(2),
            8 + 32 + 32 + 4 + 32 * 2 + 8 + 1 + 32
        );
    }

    #[test]
    fn zero_drop_seed_is_rejected() {
        assert!(!has_any_non_zero_byte(&[0u8; 32]));

        let mut drop_seed = [0u8; 32];
        drop_seed[31] = 1;
        assert!(has_any_non_zero_byte(&drop_seed));
    }

    #[test]
    fn config_pdas_differ_for_distinct_drop_seeds() {
        let program_id = Pubkey::new_unique();
        let drop_seed_a = [1u8; 32];
        let drop_seed_b = [2u8; 32];
        let (config_a, _) = Pubkey::find_program_address(
            &[BoxMinterConfig::SEED, drop_seed_a.as_ref()],
            &program_id,
        );
        let (config_b, _) = Pubkey::find_program_address(
            &[BoxMinterConfig::SEED, drop_seed_b.as_ref()],
            &program_id,
        );
        assert_ne!(config_a, config_b);
    }

    #[test]
    fn v2_pdas_are_namespaced_by_config() {
        let program_id = Pubkey::new_unique();
        let payer = Pubkey::new_unique();
        let config_a = Pubkey::new_unique();
        let config_b = Pubkey::new_unique();
        let mint_id = 42u64;
        let mint_id_bytes = mint_id.to_le_bytes();
        let box_index = [0u8];
        let delivery_id = 99u32;
        let delivery_id_bytes = delivery_id.to_le_bytes();

        let (box_a, _) = Pubkey::find_program_address(
            &[
                SEED_BOX_ASSET,
                config_a.as_ref(),
                payer.as_ref(),
                &mint_id_bytes,
                &box_index,
            ],
            &program_id,
        );
        let (box_b, _) = Pubkey::find_program_address(
            &[
                SEED_BOX_ASSET,
                config_b.as_ref(),
                payer.as_ref(),
                &mint_id_bytes,
                &box_index,
            ],
            &program_id,
        );
        assert_ne!(box_a, box_b);

        let (discount_a, _) = Pubkey::find_program_address(
            &[SEED_DISCOUNT_MINT, config_a.as_ref(), payer.as_ref()],
            &program_id,
        );
        let (discount_b, _) = Pubkey::find_program_address(
            &[SEED_DISCOUNT_MINT, config_b.as_ref(), payer.as_ref()],
            &program_id,
        );
        assert_ne!(discount_a, discount_b);

        let (delivery_a, _) = Pubkey::find_program_address(
            &[SEED_DELIVERY, config_a.as_ref(), &delivery_id_bytes],
            &program_id,
        );
        let (delivery_b, _) = Pubkey::find_program_address(
            &[SEED_DELIVERY, config_b.as_ref(), &delivery_id_bytes],
            &program_id,
        );
        assert_ne!(delivery_a, delivery_b);
    }
}
