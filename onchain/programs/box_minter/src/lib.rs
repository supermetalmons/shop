use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::program::invoke_signed;
use core::fmt::Write;
use solana_sha256_hasher::hashv;

declare_id!("22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep");

/// The only signer allowed to run `initialize()`.
///
/// This prevents a permissionless first-initializer from permanently taking over the canonical
/// `config` PDA (`seeds = [b"config"]`).
const EXPECTED_INITIALIZER: Pubkey = pubkey!("kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx");

// Uncompressed Core NFTs are much heavier than cNFTs, but they don't require proofs.
// Keep conservative caps to avoid compute/tx-size failures.
// NOTE: Uncompressed Core mints are expensive; keep this reasonably low.
const MAX_SAFE_MINTS_PER_TX: u8 = 15;
// Delivery is mostly limited by tx size; keep this high enough to not be the limiting factor.
const MAX_SAFE_DELIVERY_ITEMS_PER_TX: u8 = 32;

// Figure IDs are globally unique, 1..=999 for a 333 box supply (3 figures per box).
const DUDES_PER_BOX: usize = 3;
const MAX_DUDE_ID: u16 = 999;

// Asset PDA namespaces (owned by mpl-core; signed for via our program).
const SEED_BOX_ASSET: &[u8] = b"box";
const SEED_DELIVERY: &[u8] = b"delivery";
// Pending (two-step) box open flow.
const SEED_PENDING_OPEN: &[u8] = b"open";
const SEED_PENDING_DUDE_ASSET: &[u8] = b"pdude";
const SEED_DISCOUNT_MINT: &[u8] = b"discount";

// Metaplex Core program id.
const MPL_CORE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    175, 84, 171, 16, 189, 151, 165, 66, 160, 158, 247, 179, 152, 137, 221, 12, 211, 148,
    164, 204, 233, 223, 166, 205, 201, 126, 190, 45, 35, 91, 167, 72,
]);

// SPL Noop program id (MPL-Core log wrapper).
const SPL_NOOP_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    11, 188, 15, 192, 187, 71, 202, 47, 116, 196, 17, 46, 148, 171, 19, 207, 163, 198, 52,
    229, 220, 23, 234, 203, 3, 205, 26, 35, 205, 126, 120, 124,
]);

// Metaplex Noop program id (Bubblegum v2 log wrapper).
const MPL_NOOP_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    11, 121, 89, 138, 15, 175, 40, 176, 251, 210, 37, 99, 35, 51, 65, 75, 208, 58, 171, 36,
    15, 112, 50, 209, 222, 71, 87, 160, 172, 93, 198, 6,
]);

// Metaplex Account Compression program id (used by Bubblegum v2).
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    11, 110, 1, 83, 35, 73, 37, 196, 7, 241, 129, 86, 118, 252, 211, 44, 245, 164, 143, 110,
    139, 22, 153, 55, 86, 36, 187, 205, 94, 20, 114, 203,
]);

// Metaplex Bubblegum v2 program id.
const BUBBLEGUM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    152, 139, 128, 235, 121, 53, 40, 105, 178, 36, 116, 95, 89, 221, 191, 138, 38, 88, 202,
    19, 220, 104, 129, 33, 38, 53, 28, 174, 7, 193, 165, 165,
]);

// Bubblegum -> MPL-Core CPI signer (fixed address).
const MPL_CORE_CPI_SIGNER: Pubkey = Pubkey::new_from_array([
    172, 62, 167, 81, 182, 229, 187, 148, 54, 215, 103, 188, 191, 118, 136, 109, 246, 185,
    148, 74, 208, 130, 94, 187, 44, 164, 169, 205, 130, 57, 140, 171,
]);

// Bubblegum v2 mint discriminator: [120, 121, 23, 146, 173, 110, 199, 205]
const IX_BUBBLEGUM_MINT_V2: [u8; 8] = [120, 121, 23, 146, 173, 110, 199, 205];

// URI path suffixes appended to the configured DROP BASE (`config.uri_base`).
// Kept as `&'static str` so we can avoid allocating derived base Strings on the SBF heap.
const URI_SUFFIX_BOXES: &str = "/json/boxes/";
const URI_SUFFIX_FIGURES: &str = "/json/figures/";
const URI_SUFFIX_RECEIPTS_FIGURES: &str = "/json/receipts/figures/";
const URI_SUFFIX_RECEIPTS_BOXES: &str = "/json/receipts/boxes/";
const LEGACY_LITTLE_SWAG_BOXES_URI_BASE: &str = "https://assets.mons.link/drops/lsb";
const CURRENT_LITTLE_SWAG_BOXES_URI_BASE: &str = "https://cdn.lil.org/nft/little_swag_boxes";
const LITTLE_SWAG_RECEIPTS_TREE: Pubkey = pubkey!("Bep28XBM8LEjdCHgTzhuo5hFazpKrKgxDaEcnRg2VThV");
const IX_BUBBLEGUM_UPDATE_METADATA_V2: [u8; 8] = [43, 103, 89, 42, 121, 242, 62, 72];
const RECEIPT_KIND_BOX: u8 = 0;
const RECEIPT_KIND_FIGURE: u8 = 1;
const MAX_RECEIPT_PROOF_ACCOUNTS: usize = 14;

fn hash_leaf(data: &[u8]) -> [u8; 32] {
    hashv(&[data]).to_bytes()
}

fn hash_sorted_pair(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let (a, b) = if left <= right { (left, right) } else { (right, left) };
    hashv(&[a.as_ref(), b.as_ref()]).to_bytes()
}

fn verify_merkle_proof(leaf: &[u8], proof: &[[u8; 32]], root: [u8; 32]) -> bool {
    let mut node = hash_leaf(leaf);
    for sibling in proof {
        node = hash_sorted_pair(node, *sibling);
    }
    node == root
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
}

fn mint_boxes_inner<'info>(
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

    require!(quantity >= 1, BoxMinterError::InvalidQuantity);
    let max_qty = cfg.max_per_tx.min(MAX_SAFE_MINTS_PER_TX);
    require!(quantity <= max_qty, BoxMinterError::InvalidQuantity);

    let qty_u32 = quantity as u32;
    let new_total = cfg
        .minted
        .checked_add(qty_u32)
        .ok_or(BoxMinterError::MathOverflow)?;
    require!(new_total <= cfg.max_supply, BoxMinterError::SoldOut);

    // Take payment.
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

    // Remaining accounts: `quantity` PDA addresses for the new box assets.
    require!(
        remaining_accounts.len() == quantity as usize,
        BoxMinterError::InvalidRemainingAccounts
    );
    require!(
        box_bumps.len() == quantity as usize,
        BoxMinterError::InvalidRemainingAccounts
    );

    let mpl_core_program = accounts.mpl_core_program.clone();
    let core_collection = accounts.core_collection.clone();
    let payer = accounts.payer.clone();
    let cfg_ai = cfg.to_account_info();
    let system_program = accounts.system_program.clone();

    let cfg_bump = cfg.bump;
    let cfg_signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg_bump]];
    let start_index = cfg.minted + 1;
    let payer_key = accounts.payer.key();
    let mint_id_bytes = mint_id.to_le_bytes();

    // IMPORTANT (memory): kinobi CPI builders allocate fresh Vec/Box per mint and the SBF heap is tiny.
    // Reuse buffers across the loop so minting 10+ assets doesn't OOM.
    // Canonical config: cfg.uri_base is the DROP BASE.
    let drop_base = cfg.uri_base.as_str();
    // Pre-allocate enough for: `${drop_base}{URI_SUFFIX_BOXES}{id}.json`
    let max_uri_len: usize = drop_base.len() + URI_SUFFIX_BOXES.len() + 16;

    let mut name_buf = String::with_capacity(BoxMinterConfig::MAX_NAME_PREFIX + 12);
    let mut uri_buf = String::with_capacity(max_uri_len);

    let mut create_ix = anchor_lang::solana_program::instruction::Instruction {
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
    // Build constant accounts once; only `asset` changes per mint.
    create_ix
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new(
            Pubkey::default(),
            true,
        )); // asset (placeholder)
    create_ix
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new(
            core_collection.key(),
            false,
        )); // collection
    create_ix
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            cfg_ai.key(),
            true,
        )); // authority
    create_ix
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new(
            payer.key(),
            true,
        )); // payer
    create_ix
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            payer.key(),
            false,
        )); // owner
    create_ix
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            MPL_CORE_PROGRAM_ID,
            false,
        )); // update_authority: None (placeholder)
    create_ix
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            system_program.key(),
            false,
        )); // system_program
    create_ix
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            MPL_CORE_PROGRAM_ID,
            false,
        )); // log_wrapper: None (placeholder)

    for i in 0..qty_u32 {
        // IMPORTANT: the asset address must NOT depend on `cfg.minted` (global counter), otherwise
        // concurrent mints will frequently fail due to clients building stale PDAs.
        //
        // Asset PDA seeds: ["box", payer, mint_id, i, bump]
        let i_u8: u8 = i
            .try_into()
            .map_err(|_| error!(BoxMinterError::InvalidQuantity))?;
        let i_seed = [i_u8];

        let idx = start_index + i;
        let asset_bump = box_bumps[i as usize];
        let asset_bump_bytes = [asset_bump];
        let expected = Pubkey::create_program_address(
            &[
                SEED_BOX_ASSET,
                payer_key.as_ref(),
                &mint_id_bytes,
                &i_seed,
                &asset_bump_bytes,
            ],
            program_id,
        )
        .map_err(|_| error!(BoxMinterError::InvalidAssetPda))?;

        let asset_ai = &remaining_accounts[i as usize];
        require_keys_eq!(asset_ai.key(), expected, BoxMinterError::InvalidAssetPda);
        // Ensure the account is uninitialized (otherwise Create will fail and waste compute).
        require_keys_eq!(
            *asset_ai.owner,
            anchor_lang::solana_program::system_program::ID,
            BoxMinterError::InvalidAssetPda
        );

        // Prevent PDA "squatting": a pre-funded system-owned stub would make downstream Create fail.
        // Since this is a PDA, we can sign for it and drain any prefunded lamports back to the payer.
        let asset_seeds: &[&[u8]] = &[
            SEED_BOX_ASSET,
            payer_key.as_ref(),
            &mint_id_bytes,
            &i_seed,
            &asset_bump_bytes,
        ];
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

        // Build metadata without allocating fresh Strings each loop.
        name_buf.clear();
        name_buf.push_str(&cfg.name_prefix);
        if !cfg.name_prefix.is_empty() && !cfg.name_prefix.ends_with(' ') {
            name_buf.push(' ');
        }
        write!(&mut name_buf, "{}", idx).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

        uri_buf.clear();
        // Per-box JSON URI: `${drop_base}{URI_SUFFIX_BOXES}{id}.json`
        uri_buf.push_str(drop_base);
        uri_buf.push_str(URI_SUFFIX_BOXES);
        write!(&mut uri_buf, "{}", idx).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
        uri_buf.push_str(".json");
        let signer_seeds: &[&[&[u8]]] = &[cfg_signer_seeds, asset_seeds];

        // Reuse instruction buffers to keep heap usage flat.
        create_ix.accounts[0].pubkey = asset_ai.key();
        create_ix.data.clear();
        // discriminator for CreateV1 is 0
        create_ix.data.push(0);
        // DataState::AccountState is enum variant 0
        create_ix.data.push(0);
        create_ix
            .data
            .extend_from_slice(&(name_buf.len() as u32).to_le_bytes());
        create_ix.data.extend_from_slice(name_buf.as_bytes());
        create_ix
            .data
            .extend_from_slice(&(uri_buf.len() as u32).to_le_bytes());
        create_ix.data.extend_from_slice(uri_buf.as_bytes());
        // plugins: None
        create_ix.data.push(0);

        // AccountInfos order must match mpl-core CPI expectations (program first).
        let cpi_infos = [
            mpl_core_program.clone(),
            asset_ai.clone(),
            core_collection.clone(),
            cfg_ai.clone(),
            payer.clone(),
            payer.clone(), // owner (same pubkey; cheap clone)
            system_program.clone(),
        ];
        invoke_signed(&create_ix, &cpi_infos, signer_seeds).map_err(anchor_lang::error::Error::from)?;
    }

    cfg.minted = new_total;
    Ok(())
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
        require!(args.price_lamports > 0, BoxMinterError::InvalidPrice);
        require!(
            args.discount_price_lamports > 0,
            BoxMinterError::InvalidDiscountPrice
        );
        require!(
            args.discount_price_lamports <= args.price_lamports,
            BoxMinterError::InvalidDiscountPrice
        );
        require!(
            args.discount_merkle_root != [0u8; 32],
            BoxMinterError::DiscountNotConfigured
        );
        require!(
            args.name_prefix.len() <= BoxMinterConfig::MAX_NAME_PREFIX,
            BoxMinterError::NameTooLong
        );
        require!(
            args.symbol.len() <= BoxMinterConfig::MAX_SYMBOL,
            BoxMinterError::SymbolTooLong
        );
        require!(
            args.uri_base.len() <= BoxMinterConfig::MAX_URI_BASE,
            BoxMinterError::UriTooLong
        );
        // Canonical config: `uri_base` is the DROP BASE (not `/json/boxes/` and not a `.json` file).
        // Example: `https://assets.mons.link/drops/lsb`
        let drop_base = args.uri_base.trim_end_matches('/');
        require!(!drop_base.is_empty(), BoxMinterError::InvalidMetadataBase);
        require!(!drop_base.ends_with(".json"), BoxMinterError::InvalidMetadataBase);
        require!(!drop_base.contains("/json/boxes"), BoxMinterError::InvalidMetadataBase);
        require!(!drop_base.contains("/json/figures"), BoxMinterError::InvalidMetadataBase);
        require!(!drop_base.contains("/json/receipts"), BoxMinterError::InvalidMetadataBase);

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
        // Minting is paused by default until the admin explicitly starts it.
        cfg.started = false;
        cfg.minted = 0;
        cfg.name_prefix = args.name_prefix;
        cfg.symbol = args.symbol;
        // Store normalized drop base (no trailing slash).
        cfg.uri_base = drop_base.to_string();
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_treasury(ctx: Context<SetTreasury>, treasury: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.treasury = treasury;
        Ok(())
    }

    pub fn set_uri_base(ctx: Context<SetUriBase>, uri_base: String) -> Result<()> {
        apply_uri_base(
            &mut ctx.accounts.config,
            ctx.accounts.admin.key(),
            &uri_base,
        )
    }

    pub fn migrate_collection_uri(ctx: Context<MigrateCollectionUri>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let source_base = migration_source_base(&cfg.uri_base)?;
        let target_uri = format!("{}/collection.json", cfg.uri_base);
        let source_uri = format!("{source_base}/collection.json");
        {
            let data = ctx.accounts.core_collection.try_borrow_data()?;
            let collection = parse_mpl_core_base_collection_v1(&data)?;
            require_keys_eq!(
                collection.update_authority,
                ctx.accounts.config.key(),
                BoxMinterError::InvalidAssetCollection
            );
            if collection.uri == target_uri.as_bytes() {
                return Ok(());
            }
            require!(
                collection.uri == source_uri.as_bytes(),
                BoxMinterError::InvalidAssetMetadata
            );
        }

        let mut data = Vec::with_capacity(8 + target_uri.len());
        data.push(16u8);
        data.push(0u8);
        data.push(1u8);
        borsh_push_string(&mut data, &target_uri)?;
        let config = ctx.accounts.config.to_account_info();
        let core_program = ctx.accounts.mpl_core_program.to_account_info();
        let instruction = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(
                    ctx.accounts.core_collection.key(),
                    false,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new(
                    ctx.accounts.admin.key(),
                    true,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    config.key(),
                    true,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    MPL_CORE_PROGRAM_ID,
                    false,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.system_program.key(),
                    false,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.log_wrapper.key(),
                    false,
                ),
            ],
            data,
        };
        let signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];
        invoke_signed(
            &instruction,
            &[
                ctx.accounts.core_collection.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                config,
                core_program.clone(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.log_wrapper.to_account_info(),
                core_program,
            ],
            &[signer_seeds],
        )?;
        Ok(())
    }

    pub fn migrate_core_asset_uri(ctx: Context<MigrateCoreAssetUri>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        migration_source_base(&cfg.uri_base)?;
        let target_uri = {
            let data = ctx.accounts.asset.try_borrow_data()?;
            let asset = parse_mpl_core_base_asset_v1(&data)?;
            require!(
                asset.update_authority_kind == 2 && asset.update_authority == cfg.core_collection,
                BoxMinterError::InvalidAssetCollection
            );
            if core_asset_uri_matches_base(asset.uri, cfg.max_supply, &cfg.uri_base) {
                return Ok(());
            }
            migrated_core_asset_uri(asset.uri, cfg.max_supply, &cfg.uri_base)?
        };

        let mut data = Vec::with_capacity(8 + target_uri.len());
        data.push(15u8);
        data.push(0u8);
        data.push(1u8);
        borsh_push_string(&mut data, &target_uri)?;
        data.push(0u8);
        let config = ctx.accounts.config.to_account_info();
        let instruction = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(
                    ctx.accounts.asset.key(),
                    false,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.core_collection.key(),
                    false,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new(
                    ctx.accounts.admin.key(),
                    true,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    config.key(),
                    true,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.system_program.key(),
                    false,
                ),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                    ctx.accounts.log_wrapper.key(),
                    false,
                ),
            ],
            data,
        };
        let signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];
        invoke_signed(
            &instruction,
            &[
                ctx.accounts.asset.to_account_info(),
                ctx.accounts.core_collection.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                config,
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.log_wrapper.to_account_info(),
                ctx.accounts.mpl_core_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;
        Ok(())
    }

    pub fn migrate_receipt_uri<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, MigrateReceiptUri<'info>>,
        args: MigrateReceiptUriArgs,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        migration_source_base(&cfg.uri_base)?;
        require!(
            ctx.remaining_accounts.len() <= MAX_RECEIPT_PROOF_ACCOUNTS,
            BoxMinterError::InvalidRemainingAccounts
        );
        let (expected_tree_config, _) = Pubkey::find_program_address(
            &[ctx.accounts.merkle_tree.key().as_ref()],
            &BUBBLEGUM_PROGRAM_ID,
        );
        require_keys_eq!(
            ctx.accounts.tree_config.key(),
            expected_tree_config,
            BoxMinterError::InvalidReceiptsTreeConfig
        );
        require!(args.flags == 0, BoxMinterError::InvalidAssetMetadata);
        require!(
            args.nonce <= u32::MAX as u64 && args.index == args.nonce as u32,
            BoxMinterError::InvalidAssetMetadata
        );
        require_keys_eq!(
            ctx.accounts.leaf_owner.key(),
            ctx.accounts.leaf_delegate.key(),
            BoxMinterError::InvalidAssetOwner
        );

        let (name, current_uri, target_uri) = receipt_migration_metadata(
            args.receipt_kind,
            args.receipt_id,
            cfg.max_supply,
            &cfg.uri_base,
        )?;
        let mut data = Vec::with_capacity(320);
        data.extend_from_slice(&IX_BUBBLEGUM_UPDATE_METADATA_V2);
        data.extend_from_slice(&args.root);
        data.push(1u8);
        data.extend_from_slice(&args.asset_data_hash);
        data.push(1u8);
        data.push(args.flags);
        data.extend_from_slice(&args.nonce.to_le_bytes());
        data.extend_from_slice(&args.index.to_le_bytes());
        borsh_push_string(&mut data, &name)?;
        borsh_push_string(&mut data, "")?;
        borsh_push_string(&mut data, &current_uri)?;
        data.extend_from_slice(&0u16.to_le_bytes());
        data.push(0u8);
        data.push(1u8);
        data.push(1u8);
        data.push(0u8);
        data.extend_from_slice(&0u32.to_le_bytes());
        data.push(1u8);
        data.extend_from_slice(cfg.core_collection.as_ref());
        data.push(0u8);
        data.push(0u8);
        data.push(1u8);
        borsh_push_string(&mut data, &target_uri)?;
        data.push(0u8);
        data.push(0u8);
        data.push(0u8);
        data.push(0u8);

        let config = ctx.accounts.config.to_account_info();
        let mut metas = Vec::with_capacity(10 + ctx.remaining_accounts.len());
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
            ctx.accounts.tree_config.key(),
            false,
        ));
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
            ctx.accounts.admin.key(),
            true,
        ));
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            config.key(),
            true,
        ));
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            ctx.accounts.leaf_owner.key(),
            false,
        ));
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            ctx.accounts.leaf_delegate.key(),
            false,
        ));
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new(
            ctx.accounts.merkle_tree.key(),
            false,
        ));
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            ctx.accounts.core_collection.key(),
            false,
        ));
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            ctx.accounts.log_wrapper.key(),
            false,
        ));
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            ctx.accounts.compression_program.key(),
            false,
        ));
        metas.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
            ctx.accounts.system_program.key(),
            false,
        ));
        metas.extend(ctx.remaining_accounts.iter().map(|account| {
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(account.key(), false)
        }));

        let instruction = anchor_lang::solana_program::instruction::Instruction {
            program_id: BUBBLEGUM_PROGRAM_ID,
            accounts: metas,
            data,
        };
        let mut infos = Vec::with_capacity(11 + ctx.remaining_accounts.len());
        infos.push(ctx.accounts.tree_config.to_account_info());
        infos.push(ctx.accounts.admin.to_account_info());
        infos.push(config);
        infos.push(ctx.accounts.leaf_owner.to_account_info());
        infos.push(ctx.accounts.leaf_delegate.to_account_info());
        infos.push(ctx.accounts.merkle_tree.to_account_info());
        infos.push(ctx.accounts.core_collection.to_account_info());
        infos.push(ctx.accounts.log_wrapper.to_account_info());
        infos.push(ctx.accounts.compression_program.to_account_info());
        infos.push(ctx.accounts.system_program.to_account_info());
        infos.extend(ctx.remaining_accounts.iter().cloned());
        infos.push(ctx.accounts.bubblegum_program.to_account_info());
        let signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];
        invoke_signed(&instruction, &infos, &[signer_seeds])?;
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
        let accounts = MintBoxesInnerAccounts::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
            ctx.accounts.core_collection.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        );
        let unit_price_lamports = ctx.accounts.config.price_lamports;
        mint_boxes_inner(
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

        ctx.accounts.discount_record.payer = payer_key;
        ctx.accounts.discount_record.bump = ctx.bumps.discount_record;

        let accounts = MintBoxesInnerAccounts::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
            ctx.accounts.core_collection.to_account_info(),
            ctx.accounts.mpl_core_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        );
        let quantity = 1;
        mint_boxes_inner(
            &mut ctx.accounts.config,
            &accounts,
            ctx.remaining_accounts,
            quantity,
            mint_id,
            box_bumps,
            ctx.program_id,
            discount_price,
        )
    }

    /// Starts a two-step box open flow.
    ///
    /// This instruction performs an MPL-Core `TransferV1` CPI that transfers `box_asset` from the
    /// user to `config.admin` (vault). This avoids brittle reliance on instruction ordering (some
    /// wallets inject extra instructions like Compute Budget).
    ///
    /// Side effects (all in this one transaction):
    /// - creates a `PendingOpenBox` PDA keyed by the box asset pubkey
    /// - mints 3 placeholder Core assets (empty metadata, no collection) owned by `config.admin`
    pub fn start_open_box<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, StartOpenBox<'info>>,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;

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
        if !pending_ai.data_is_empty() {
            return err!(BoxMinterError::PendingAlreadyExists);
        }

        // Create (or reclaim) the pending record PDA.
        //
        // Note: a PDA can be "pre-funded", creating a system-owned stub account that makes
        // `system_instruction::create_account` fail ("account already in use"). Since this is a PDA,
        // we can sign for it and reclaim it via `allocate` + `assign`.
        let pending_space: usize = PendingOpenBox::SPACE;
        let rent_lamports = Rent::get()?.minimum_balance(pending_space);
        let pending_bump: u8 = ctx.bumps.pending;
        let box_asset_key = ctx.accounts.box_asset.key();
        let pending_seeds: &[&[u8]] = &[
            SEED_PENDING_OPEN,
            box_asset_key.as_ref(),
            &[pending_bump],
        ];
        if pending_ai.lamports() == 0 {
            let create_pending_ix = anchor_lang::solana_program::system_instruction::create_account(
                &ctx.accounts.payer.key(),
                &ctx.accounts.pending.key(),
                rent_lamports,
                pending_space as u64,
                ctx.program_id,
            );
            invoke_signed(
                &create_pending_ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    pending_ai.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[pending_seeds],
            )?;
        } else {
            // Reclaim pre-funded PDA stub (system-owned, unallocated).
            require_keys_eq!(
                *pending_ai.owner,
                anchor_lang::solana_program::system_program::ID,
                BoxMinterError::InvalidPendingRecord
            );
            require!(pending_ai.data_len() == 0, BoxMinterError::PendingAlreadyExists);

            // Ensure rent exemption for the allocated size.
            if pending_ai.lamports() < rent_lamports {
                let diff = rent_lamports - pending_ai.lamports();
                let topup_ix = anchor_lang::solana_program::system_instruction::transfer(
                    &ctx.accounts.payer.key(),
                    &ctx.accounts.pending.key(),
                    diff,
                );
                invoke(
                    &topup_ix,
                    &[
                        ctx.accounts.payer.to_account_info(),
                        pending_ai.clone(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;
            }

            let allocate_ix = anchor_lang::solana_program::system_instruction::allocate(
                &ctx.accounts.pending.key(),
                pending_space as u64,
            );
            invoke_signed(
                &allocate_ix,
                &[pending_ai.clone(), ctx.accounts.system_program.to_account_info()],
                &[pending_seeds],
            )?;

            let assign_ix = anchor_lang::solana_program::system_instruction::assign(
                &ctx.accounts.pending.key(),
                ctx.program_id,
            );
            invoke_signed(
                &assign_ix,
                &[pending_ai.clone(), ctx.accounts.system_program.to_account_info()],
                &[pending_seeds],
            )?;
        }

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
            Some(LEGACY_LITTLE_SWAG_BOXES_URI_BASE),
            URI_SUFFIX_BOXES,
            None,
        )?;

        // Remaining accounts: exactly 3 new placeholder dude asset PDAs.
        require!(
            ctx.remaining_accounts.len() == DUDES_PER_BOX,
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
        let cfg_signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];

        let transfer_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // asset, collection, payer, authority, new_owner, system_program, log_wrapper
                anchor_lang::solana_program::instruction::AccountMeta::new(box_asset.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(core_collection.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(payer.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(payer.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(vault.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(log_wrapper.key(), false),
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

        // Create 3 placeholder Core assets:
        // - owner: config.admin (vault/admin)
        // - update authority: config PDA (so only the program can later "reveal" by updating metadata + setting collection)
        // - collection: None (placeholder) so the assets do NOT appear in the collection until reveal.
        let pending_key = ctx.accounts.pending.key();
        let mut dudes: [Pubkey; DUDES_PER_BOX] = [Pubkey::default(); DUDES_PER_BOX];

        let mut create_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // 0 asset (placeholder)
                anchor_lang::solana_program::instruction::AccountMeta::new(Pubkey::default(), true),
                // 1 collection: None => placeholder = program id (must be readonly when absent)
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false),
                // 2 authority (signer): config PDA
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cfg_ai.key(), true),
                // 3 payer (signer)
                anchor_lang::solana_program::instruction::AccountMeta::new(payer.key(), true),
                // 4 owner: vault/admin (not signer)
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(vault.key(), false),
                // 5 update authority: config PDA (not signer account meta)
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cfg_ai.key(), false),
                // 6 system program
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false),
                // 7 log wrapper: None => placeholder = program id
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false),
            ],
            data: Vec::with_capacity(32),
        };

        for i in 0..DUDES_PER_BOX {
            let i_u8: u8 = i
                .try_into()
                .map_err(|_| error!(BoxMinterError::InvalidRemainingAccounts))?;
            let i_seed = [i_u8];
            let (expected, asset_bump) = Pubkey::find_program_address(
                &[SEED_PENDING_DUDE_ASSET, pending_key.as_ref(), &i_seed],
                ctx.program_id,
            );

            let asset_ai = &ctx.remaining_accounts[i];
            require_keys_eq!(asset_ai.key(), expected, BoxMinterError::InvalidAssetPda);
            // Ensure the account is uninitialized (otherwise Create will fail and waste compute).
            require_keys_eq!(
                *asset_ai.owner,
                anchor_lang::solana_program::system_program::ID,
                BoxMinterError::InvalidAssetPda
            );

            dudes[i] = expected;

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

        // Validate dude IDs.
        for id in args.dude_ids {
            require!(id >= 1 && id <= MAX_DUDE_ID, BoxMinterError::InvalidDudeId);
        }
        require!(
            args.dude_ids[0] != args.dude_ids[1]
                && args.dude_ids[0] != args.dude_ids[2]
                && args.dude_ids[1] != args.dude_ids[2],
            BoxMinterError::DuplicateDudeId
        );

        // Pending record must belong to the provided user, and must correspond to this box.
        require_keys_eq!(
            ctx.accounts.pending.box_asset,
            ctx.accounts.box_asset.key(),
            BoxMinterError::InvalidPendingRecord
        );
        require_keys_eq!(
            ctx.accounts.user.key(),
            ctx.accounts.pending.owner,
            BoxMinterError::InvalidPendingRecord
        );

        // Remaining accounts: exactly 3 placeholder dude assets, in the order stored on-chain.
        require!(
            ctx.remaining_accounts.len() == DUDES_PER_BOX,
            BoxMinterError::InvalidRemainingAccounts
        );
        for i in 0..DUDES_PER_BOX {
            require_keys_eq!(
                ctx.remaining_accounts[i].key(),
                ctx.accounts.pending.dudes[i],
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
            Some(LEGACY_LITTLE_SWAG_BOXES_URI_BASE),
            URI_SUFFIX_BOXES,
            None,
        )?;

        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let cosigner = ctx.accounts.cosigner.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let log_wrapper = ctx.accounts.log_wrapper.to_account_info();
        let cfg_ai = ctx.accounts.config.to_account_info();
        let cfg_signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];

        // 1) Burn the box (reclaim rent to the admin payer).
        let burn_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // asset, collection, payer, authority, system_program, log_wrapper
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.box_asset.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(core_collection.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(cosigner.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cosigner.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(log_wrapper.key(), false),
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
        let mut uri_buf = String::with_capacity(drop_base.len() + URI_SUFFIX_FIGURES.len() + 16);

        let mut update_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // UpdateV2 accounts:
                //   asset, collection (optional), payer, authority, new_collection (optional), system_program, log_wrapper
                anchor_lang::solana_program::instruction::AccountMeta::new(Pubkey::default(), false), // asset placeholder
                // collection: None (placeholder)
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false),
                anchor_lang::solana_program::instruction::AccountMeta::new(cosigner.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cfg_ai.key(), true), // authority (config PDA)
                // new_collection: core collection (writable; mpl-core increments size)
                anchor_lang::solana_program::instruction::AccountMeta::new(core_collection.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(log_wrapper.key(), false),
            ],
            data: Vec::with_capacity(128),
        };

        // 3) Transfer dudes to the user.
        let user_ai = ctx.accounts.user.to_account_info();
        let mut transfer_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // asset, collection, payer, authority, new_owner, system_program, log_wrapper
                anchor_lang::solana_program::instruction::AccountMeta::new(Pubkey::default(), false), // asset placeholder
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(core_collection.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(cosigner.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cosigner.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(user_ai.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(log_wrapper.key(), false),
            ],
            // TransferV1 discriminator=14, compression_proof=None (0)
            data: vec![14u8, 0u8],
        };

        for i in 0..DUDES_PER_BOX {
            let dude_id = args.dude_ids[i];
            name_buf.clear();
            name_buf.push_str("figure ");
            write!(&mut name_buf, "{}", dude_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(drop_base);
            uri_buf.push_str(URI_SUFFIX_FIGURES);
            write!(&mut uri_buf, "{}", dude_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
            uri_buf.push_str(".json");

            let asset_ai = &ctx.remaining_accounts[i];

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
            update_ix.data.extend_from_slice(core_collection.key().as_ref());

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

        // Delivery record PDA: `delivery` + delivery_id.
        let delivery_id_bytes = args.delivery_id.to_le_bytes();
        let expected_delivery = Pubkey::create_program_address(
            &[SEED_DELIVERY, &delivery_id_bytes, &[args.delivery_bump]],
            ctx.program_id,
        )
        .map_err(|_| error!(BoxMinterError::InvalidDeliveryPda))?;
        require_keys_eq!(
            ctx.accounts.delivery.key(),
            expected_delivery,
            BoxMinterError::InvalidDeliveryPda
        );
        let delivery_ai = ctx.accounts.delivery.to_account_info();
        if !delivery_ai.data_is_empty() {
            return err!(BoxMinterError::DeliveryAlreadyExists);
        }

        // Create (or reclaim) the tiny on-chain delivery record (presence == paid order).
        //
        // Note: a PDA can be "pre-funded", creating a system-owned stub account that makes
        // `system_instruction::create_account` fail ("account already in use"). Since this is a PDA,
        // we can sign for it and reclaim it via `allocate` + `assign`.
        let delivery_space: usize = DeliveryRecord::SPACE;
        let rent_lamports = Rent::get()?.minimum_balance(delivery_space);
        let delivery_seeds: &[&[u8]] = &[SEED_DELIVERY, &delivery_id_bytes, &[args.delivery_bump]];
        if delivery_ai.lamports() == 0 {
            let create_delivery_ix = anchor_lang::solana_program::system_instruction::create_account(
                &ctx.accounts.payer.key(),
                &ctx.accounts.delivery.key(),
                rent_lamports,
                delivery_space as u64,
                ctx.program_id,
            );
            invoke_signed(
                &create_delivery_ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    delivery_ai.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[delivery_seeds],
            )?;
        } else {
            // Reclaim pre-funded PDA stub (system-owned, unallocated).
            require_keys_eq!(
                *delivery_ai.owner,
                anchor_lang::solana_program::system_program::ID,
                BoxMinterError::InvalidDeliveryPda
            );
            require!(delivery_ai.data_len() == 0, BoxMinterError::DeliveryAlreadyExists);

            // Ensure rent exemption for the allocated size.
            if delivery_ai.lamports() < rent_lamports {
                let diff = rent_lamports - delivery_ai.lamports();
                let topup_ix = anchor_lang::solana_program::system_instruction::transfer(
                    &ctx.accounts.payer.key(),
                    &ctx.accounts.delivery.key(),
                    diff,
                );
                invoke(
                    &topup_ix,
                    &[
                        ctx.accounts.payer.to_account_info(),
                        delivery_ai.clone(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;
            }

            let allocate_ix = anchor_lang::solana_program::system_instruction::allocate(
                &ctx.accounts.delivery.key(),
                delivery_space as u64,
            );
            invoke_signed(
                &allocate_ix,
                &[delivery_ai.clone(), ctx.accounts.system_program.to_account_info()],
                &[delivery_seeds],
            )?;

            let assign_ix = anchor_lang::solana_program::system_instruction::assign(
                &ctx.accounts.delivery.key(),
                ctx.program_id,
            );
            invoke_signed(
                &assign_ix,
                &[delivery_ai.clone(), ctx.accounts.system_program.to_account_info()],
                &[delivery_seeds],
            )?;
        }

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

        let mut transfer_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                // asset, collection, payer, authority, new_owner, system_program, log_wrapper
                anchor_lang::solana_program::instruction::AccountMeta::new(Pubkey::default(), false), // asset placeholder
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(core_collection.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(payer.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(payer.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(vault.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(log_wrapper.key(), false),
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

        require_keys_eq!(
            ctx.accounts.bubblegum_program.key(),
            BUBBLEGUM_PROGRAM_ID,
            BoxMinterError::InvalidBubblegumProgram
        );
        require_keys_eq!(
            ctx.accounts.log_wrapper.key(),
            MPL_NOOP_PROGRAM_ID,
            BoxMinterError::InvalidMplNoopProgram
        );
        require_keys_eq!(
            ctx.accounts.compression_program.key(),
            MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
            BoxMinterError::InvalidCompressionProgram
        );
        require_keys_eq!(
            ctx.accounts.mpl_core_program.key(),
            MPL_CORE_PROGRAM_ID,
            BoxMinterError::InvalidMplCoreProgram
        );
        require_keys_eq!(
            ctx.accounts.mpl_core_cpi_signer.key(),
            MPL_CORE_CPI_SIGNER,
            BoxMinterError::InvalidMplCoreCpiSigner
        );

        let box_ids = args.box_ids;
        let dude_ids = args.dude_ids;

        // Defensive caps (Bubblegum mints are compute-heavy).
        let total = box_ids.len().checked_add(dude_ids.len()).ok_or(BoxMinterError::MathOverflow)?;
        require!(total > 0, BoxMinterError::InvalidQuantity);
        // Conservative cap; if the backend wants more, it should batch.
        require!(total <= 24, BoxMinterError::InvalidQuantity);

        // Validate box IDs (must correspond to configured box supply).
        for id in box_ids.iter() {
            require!(*id >= 1 && *id <= cfg.max_supply, BoxMinterError::InvalidAssetMetadata);
        }
        // Validate dude IDs.
        for id in dude_ids.iter() {
            require!(*id >= 1 && *id <= MAX_DUDE_ID, BoxMinterError::InvalidDudeId);
        }
        // Ensure there are no duplicates (cheap O(n^2) since n is tiny).
        for i in 0..box_ids.len() {
            for j in (i + 1)..box_ids.len() {
                require!(box_ids[i] != box_ids[j], BoxMinterError::InvalidAssetMetadata);
            }
        }
        for i in 0..dude_ids.len() {
            for j in (i + 1)..dude_ids.len() {
                require!(dude_ids[i] != dude_ids[j], BoxMinterError::DuplicateDudeId);
            }
        }

        // Validate receipts tree + treeConfig PDA.
        require_keys_eq!(
            *ctx.accounts.merkle_tree.to_account_info().owner,
            MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
            BoxMinterError::InvalidReceiptsMerkleTree
        );
        let (expected_tree_config, _) = Pubkey::find_program_address(
            &[ctx.accounts.merkle_tree.key().as_ref()],
            &BUBBLEGUM_PROGRAM_ID,
        );
        require_keys_eq!(
            ctx.accounts.tree_config.key(),
            expected_tree_config,
            BoxMinterError::InvalidReceiptsTreeConfig
        );

        let drop_base = cfg.uri_base.as_str();

        // Build constant accounts once; only metadata bytes change per mint.
        let cosigner = ctx.accounts.cosigner.to_account_info();
        let user_ai = ctx.accounts.user.to_account_info();
        let merkle_tree = ctx.accounts.merkle_tree.to_account_info();
        let tree_config = ctx.accounts.tree_config.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let mpl_core_cpi_signer = ctx.accounts.mpl_core_cpi_signer.to_account_info();
        let log_wrapper = ctx.accounts.log_wrapper.to_account_info();
        let compression_program = ctx.accounts.compression_program.to_account_info();
        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let bubblegum_program = ctx.accounts.bubblegum_program.to_account_info();

        let mut mint_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: BUBBLEGUM_PROGRAM_ID,
            accounts: vec![
                // mintV2 accounts order (kinobi):
                // 0 treeConfig (writable)
                anchor_lang::solana_program::instruction::AccountMeta::new(tree_config.key(), false),
                // 1 payer (writable signer)
                anchor_lang::solana_program::instruction::AccountMeta::new(cosigner.key(), true),
                // 2 treeCreatorOrDelegate (signer)
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cosigner.key(), true),
                // 3 collectionAuthority (signer)
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cosigner.key(), true),
                // 4 leafOwner
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(user_ai.key(), false),
                // 5 leafDelegate
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(user_ai.key(), false),
                // 6 merkleTree (writable)
                anchor_lang::solana_program::instruction::AccountMeta::new(merkle_tree.key(), false),
                // 7 coreCollection (writable)
                anchor_lang::solana_program::instruction::AccountMeta::new(core_collection.key(), false),
                // 8 mplCoreCpiSigner
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(mpl_core_cpi_signer.key(), false),
                // 9 logWrapper
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(log_wrapper.key(), false),
                // 10 compressionProgram
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(compression_program.key(), false),
                // 11 mplCoreProgram
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(mpl_core_program.key(), false),
                // 12 systemProgram
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false),
            ],
            data: Vec::with_capacity(256),
        };

        let mut name_buf = String::with_capacity(48);
        let mut uri_buf = String::with_capacity(
            drop_base.len()
                + URI_SUFFIX_RECEIPTS_BOXES
                    .len()
                    .max(URI_SUFFIX_RECEIPTS_FIGURES.len())
                + 16,
        );

        // Helper closure to build + invoke a Bubblegum mintV2 for the current name/uri buffers.
        let mut mint_one = |name: &str, uri: &str| -> Result<()> {
            mint_ix.data.clear();
            mint_ix.data.extend_from_slice(&IX_BUBBLEGUM_MINT_V2);
            // MetadataArgsV2 (borsh):
            // name, symbol, uri, sellerFeeBasisPoints(u16), primarySaleHappened(bool), isMutable(bool),
            // tokenStandard: Option<TokenStandard> (Some(NonFungible=0)),
            // creators: Vec<Creator> (empty),
            // collection: Option<Pubkey> (Some(coreCollection))
            borsh_push_string(&mut mint_ix.data, name)?;
            borsh_push_string(&mut mint_ix.data, "")?;
            borsh_push_string(&mut mint_ix.data, uri)?;
            mint_ix.data.extend_from_slice(&(0u16).to_le_bytes()); // sellerFeeBasisPoints
            mint_ix.data.push(0u8); // primarySaleHappened=false
            mint_ix.data.push(1u8); // isMutable=true
            mint_ix.data.push(1u8); // tokenStandard: Some
            mint_ix.data.push(0u8); // NonFungible enum index
            mint_ix.data.extend_from_slice(&(0u32).to_le_bytes()); // creators vec len=0
            mint_ix.data.push(1u8); // collection: Some
            mint_ix.data.extend_from_slice(core_collection.key().as_ref());
            // assetData: None
            mint_ix.data.push(0u8);
            // assetDataSchema: None
            mint_ix.data.push(0u8);

            // CPI: include the program account at the end (like SystemProgram CPIs).
            invoke(
                &mint_ix,
                &[
                    tree_config.clone(),
                    cosigner.clone(),
                    cosigner.clone(),
                    cosigner.clone(),
                    user_ai.clone(),
                    user_ai.clone(),
                    merkle_tree.clone(),
                    core_collection.clone(),
                    mpl_core_cpi_signer.clone(),
                    log_wrapper.clone(),
                    compression_program.clone(),
                    mpl_core_program.clone(),
                    system_program.clone(),
                    bubblegum_program.clone(),
                ],
            )?;
            Ok(())
        };

        for box_id in box_ids.iter() {
            name_buf.clear();
            name_buf.push_str("receipt · box ");
            write!(&mut name_buf, "{}", *box_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(drop_base);
            uri_buf.push_str(URI_SUFFIX_RECEIPTS_BOXES);
            write!(&mut uri_buf, "{}", *box_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
            uri_buf.push_str(".json");
            mint_one(&name_buf, &uri_buf)?;
        }

        for dude_id in dude_ids.iter() {
            name_buf.clear();
            name_buf.push_str("receipt · figure ");
            write!(&mut name_buf, "{}", *dude_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(drop_base);
            uri_buf.push_str(URI_SUFFIX_RECEIPTS_FIGURES);
            write!(&mut uri_buf, "{}", *dude_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
            uri_buf.push_str(".json");
            mint_one(&name_buf, &uri_buf)?;
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
    pub name_prefix: String,
    pub symbol: String,
    pub uri_base: String,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct FinalizeOpenBoxArgs {
    pub dude_ids: [u16; DUDES_PER_BOX],
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct MigrateReceiptUriArgs {
    pub root: [u8; 32],
    pub asset_data_hash: [u8; 32],
    pub flags: u8,
    pub nonce: u64,
    pub index: u32,
    pub receipt_kind: u8,
    pub receipt_id: u16,
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
    pub minted: u32,
    pub name_prefix: String,
    pub symbol: String,
    pub uri_base: String,
    /// If false, `mint_boxes` is paused.
    pub started: bool,
    pub bump: u8,
}

#[account]
pub struct DiscountMintRecord {
    pub payer: Pubkey,
    pub bump: u8,
}

impl DiscountMintRecord {
    pub const SPACE: usize = 8 // anchor account discriminator
        + 32 // payer
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

impl BoxMinterConfig {
    pub const SEED: &'static [u8] = b"config";

    // Keep these tiny by design; uncompressed Core mints are compute heavy.
    pub const MAX_NAME_PREFIX: usize = 8;
    pub const MAX_SYMBOL: usize = 10;
    pub const MAX_URI_BASE: usize = 96;

    pub const SPACE: usize = 8 // anchor account discriminator
        + 32 * 3 // pubkeys
        + 8 // price_lamports
        + 8 // discount_price_lamports
        + 32 // discount_merkle_root
        + 4 // max_supply
        + 1 // max_per_tx
        + 4 // minted
        + 4 + Self::MAX_NAME_PREFIX // name_prefix
        + 4 + Self::MAX_SYMBOL // symbol
        + 4 + Self::MAX_URI_BASE // uri_base
        + 1 // started (bool)
        + 1; // bump
}

#[account]
pub struct PendingOpenBox {
    /// User who started the open.
    pub owner: Pubkey,
    /// The box asset being opened (now owned by the vault).
    pub box_asset: Pubkey,
    /// Placeholder dude asset accounts to be updated + transferred on finalize.
    pub dudes: [Pubkey; DUDES_PER_BOX],
    /// Slot when the pending record was created (for UX ordering).
    pub created_slot: u64,
    /// PDA bump for this record.
    pub bump: u8,
}

impl PendingOpenBox {
    pub const SPACE: usize = 8 // anchor discriminator
        + 32 // owner
        + 32 // box_asset
        + 32 * DUDES_PER_BOX // dudes
        + 8 // created_slot
        + 1; // bump
}

#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = BoxMinterConfig::SPACE,
        seeds = [BoxMinterConfig::SEED],
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
    #[account(mut, seeds = [BoxMinterConfig::SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, BoxMinterConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetUriBase<'info> {
    #[account(mut, seeds = [BoxMinterConfig::SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, BoxMinterConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MigrateCollectionUri<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, BoxMinterConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Address and owner are constrained to the configured MPL Core collection.
    #[account(mut, address = config.core_collection, owner = MPL_CORE_PROGRAM_ID)]
    pub core_collection: UncheckedAccount<'info>,
    /// CHECK: Address is constrained to the MPL Core program.
    #[account(address = MPL_CORE_PROGRAM_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Address is constrained to the SPL Noop program.
    #[account(address = SPL_NOOP_PROGRAM_ID)]
    pub log_wrapper: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MigrateCoreAssetUri<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, BoxMinterConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Owner is constrained to MPL Core and metadata is parsed by the handler.
    #[account(mut, owner = MPL_CORE_PROGRAM_ID)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: Address and owner are constrained to the configured MPL Core collection.
    #[account(address = config.core_collection, owner = MPL_CORE_PROGRAM_ID)]
    pub core_collection: UncheckedAccount<'info>,
    /// CHECK: Address is constrained to the MPL Core program.
    #[account(address = MPL_CORE_PROGRAM_ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Address is constrained to the SPL Noop program.
    #[account(address = SPL_NOOP_PROGRAM_ID)]
    pub log_wrapper: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MigrateReceiptUri<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, BoxMinterConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Bubblegum verifies the owner against the compressed leaf.
    pub leaf_owner: UncheckedAccount<'info>,
    /// CHECK: Equality to leaf_owner is enforced by the handler.
    pub leaf_delegate: UncheckedAccount<'info>,
    /// CHECK: Address and compression-program ownership are constrained.
    #[account(
        mut,
        address = LITTLE_SWAG_RECEIPTS_TREE,
        owner = MPL_ACCOUNT_COMPRESSION_PROGRAM_ID
    )]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK: Bubblegum ownership is constrained and PDA derivation is checked by the handler.
    #[account(mut, owner = BUBBLEGUM_PROGRAM_ID)]
    pub tree_config: UncheckedAccount<'info>,
    /// CHECK: Address and owner are constrained to the configured MPL Core collection.
    #[account(address = config.core_collection, owner = MPL_CORE_PROGRAM_ID)]
    pub core_collection: UncheckedAccount<'info>,
    /// CHECK: Address is constrained to the Bubblegum program.
    #[account(address = BUBBLEGUM_PROGRAM_ID)]
    pub bubblegum_program: UncheckedAccount<'info>,
    /// CHECK: Address is constrained to the MPL Noop program.
    #[account(address = MPL_NOOP_PROGRAM_ID)]
    pub log_wrapper: UncheckedAccount<'info>,
    /// CHECK: Address is constrained to the account-compression program.
    #[account(address = MPL_ACCOUNT_COMPRESSION_PROGRAM_ID)]
    pub compression_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartMint<'info> {
    #[account(mut, seeds = [BoxMinterConfig::SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, BoxMinterConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MintBoxes<'info> {
    #[account(mut, seeds = [BoxMinterConfig::SEED], bump = config.bump)]
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
    #[account(mut, seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = DiscountMintRecord::SPACE,
        seeds = [SEED_DISCOUNT_MINT, payer.key().as_ref()],
        bump,
    )]
    pub discount_record: Account<'info, DiscountMintRecord>,

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
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
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
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
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

    /// Pending open record PDA, closed after finalize to reclaim rent.
    #[account(
        mut,
        seeds = [SEED_PENDING_OPEN, box_asset.key().as_ref()],
        bump = pending.bump,
        close = cosigner
    )]
    pub pending: Account<'info, PendingOpenBox>,

    /// CHECK: User who will receive the dudes (must equal `pending.owner`).
    pub user: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Deliver<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
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
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin).
    #[account(mut, address = config.admin)]
    pub cosigner: Signer<'info>,

    /// Delivery record PDA to close (rent reclaimed to `cosigner`).
    #[account(
        mut,
        seeds = [SEED_DELIVERY, &args.delivery_id.to_le_bytes()],
        bump = args.delivery_bump,
        close = cosigner
    )]
    pub delivery: Account<'info, DeliveryRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintReceipts<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin).
    #[account(mut)]
    pub cosigner: Signer<'info>,

    /// CHECK: User who will receive the dude receipt cNFTs.
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

struct ParsedMplCoreBaseCollectionV1<'a> {
    update_authority: Pubkey,
    uri: &'a [u8],
}

fn read_u32_le(data: &[u8], offset: usize) -> Result<u32> {
    let end = offset.checked_add(4).ok_or(error!(BoxMinterError::InvalidAsset))?;
    let slice = data.get(offset..end).ok_or(error!(BoxMinterError::InvalidAsset))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
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
    o = o.checked_add(4).ok_or(error!(BoxMinterError::InvalidAsset))?;
    if name_len > MAX_MPL_CORE_NAME_BYTES {
        return Err(error!(BoxMinterError::InvalidAsset));
    }
    o = o.checked_add(name_len).ok_or(error!(BoxMinterError::InvalidAsset))?;
    if o > data.len() {
        return Err(error!(BoxMinterError::InvalidAsset));
    }

    let uri_len = read_u32_le(data, o)? as usize;
    o = o.checked_add(4).ok_or(error!(BoxMinterError::InvalidAsset))?;
    if uri_len > MAX_MPL_CORE_URI_BYTES {
        return Err(error!(BoxMinterError::InvalidAsset));
    }
    let uri_end = o.checked_add(uri_len).ok_or(error!(BoxMinterError::InvalidAsset))?;
    let uri = data.get(o..uri_end).ok_or(error!(BoxMinterError::InvalidAsset))?;

    Ok(ParsedMplCoreBaseAssetV1 {
        owner,
        update_authority_kind: update_kind,
        update_authority: update_pk,
        uri,
    })
}

fn parse_mpl_core_base_collection_v1(
    data: &[u8],
) -> Result<ParsedMplCoreBaseCollectionV1<'_>> {
    if data.len() < 1 + 32 + 4 + 4 + 4 + 4 || data[0] != 5 {
        return Err(error!(BoxMinterError::InvalidAsset));
    }
    let update_authority = Pubkey::new_from_array(
        data[1..33]
            .try_into()
            .map_err(|_| error!(BoxMinterError::InvalidAsset))?,
    );
    let mut offset = 33usize;
    let name_len = read_u32_le(data, offset)? as usize;
    require!(
        name_len <= MAX_MPL_CORE_NAME_BYTES,
        BoxMinterError::InvalidAsset
    );
    offset = offset
        .checked_add(4)
        .and_then(|value| value.checked_add(name_len))
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    if offset > data.len() {
        return Err(error!(BoxMinterError::InvalidAsset));
    }
    let uri_len = read_u32_le(data, offset)? as usize;
    require!(
        uri_len <= MAX_MPL_CORE_URI_BYTES,
        BoxMinterError::InvalidAsset
    );
    offset = offset
        .checked_add(4)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    let uri_end = offset
        .checked_add(uri_len)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    let uri = data
        .get(offset..uri_end)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    let trailing = uri_end
        .checked_add(8)
        .ok_or(error!(BoxMinterError::InvalidAsset))?;
    if trailing > data.len() {
        return Err(error!(BoxMinterError::InvalidAsset));
    }
    Ok(ParsedMplCoreBaseCollectionV1 {
        update_authority,
        uri,
    })
}

fn core_asset_uri_matches_base(uri: &[u8], max_supply: u32, drop_base: &str) -> bool {
    parse_ref_id_from_uri_bytes(uri, drop_base, URI_SUFFIX_BOXES)
        .is_some_and(|id| id <= max_supply)
        || parse_ref_id_from_uri_bytes(uri, drop_base, URI_SUFFIX_FIGURES)
            .is_some_and(|id| id <= MAX_DUDE_ID as u32)
}

fn migration_source_base(target_base: &str) -> Result<&'static str> {
    match target_base {
        CURRENT_LITTLE_SWAG_BOXES_URI_BASE => Ok(LEGACY_LITTLE_SWAG_BOXES_URI_BASE),
        LEGACY_LITTLE_SWAG_BOXES_URI_BASE => Ok(CURRENT_LITTLE_SWAG_BOXES_URI_BASE),
        _ => Err(error!(BoxMinterError::InvalidMigrationTarget)),
    }
}

fn migrated_core_asset_uri(
    uri: &[u8],
    max_supply: u32,
    target_base: &str,
) -> Result<String> {
    let source_base = migration_source_base(target_base)?;
    if let Some(id) = parse_ref_id_from_uri_bytes(
        uri,
        source_base,
        URI_SUFFIX_BOXES,
    ) {
        require!(id <= max_supply, BoxMinterError::InvalidAssetMetadata);
        return Ok(format!("{target_base}{URI_SUFFIX_BOXES}{id}.json"));
    }
    if let Some(id) = parse_ref_id_from_uri_bytes(
        uri,
        source_base,
        URI_SUFFIX_FIGURES,
    ) {
        require!(
            id <= MAX_DUDE_ID as u32,
            BoxMinterError::InvalidAssetMetadata
        );
        return Ok(format!("{target_base}{URI_SUFFIX_FIGURES}{id}.json"));
    }
    Err(error!(BoxMinterError::InvalidAssetMetadata))
}

fn receipt_migration_metadata(
    receipt_kind: u8,
    receipt_id: u16,
    max_supply: u32,
    target_base: &str,
) -> Result<(String, String, String)> {
    let source_base = migration_source_base(target_base)?;
    let (name, suffix) = match receipt_kind {
        RECEIPT_KIND_BOX => {
            require!(
                receipt_id > 0 && receipt_id as u32 <= max_supply,
                BoxMinterError::InvalidAssetMetadata
            );
            (format!("receipt · box {receipt_id}"), URI_SUFFIX_RECEIPTS_BOXES)
        }
        RECEIPT_KIND_FIGURE => {
            require!(
                receipt_id > 0 && receipt_id <= MAX_DUDE_ID,
                BoxMinterError::InvalidAssetMetadata
            );
            (
                format!("receipt · figure {receipt_id}"),
                URI_SUFFIX_RECEIPTS_FIGURES,
            )
        }
        _ => return Err(error!(BoxMinterError::InvalidAssetMetadata)),
    };
    Ok((
        name,
        format!("{source_base}{suffix}{receipt_id}.json"),
        format!("{target_base}{suffix}{receipt_id}.json"),
    ))
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

fn normalize_uri_base(uri_base: &str) -> Result<&str> {
    let drop_base = uri_base.trim_end_matches('/');
    require!(
        drop_base.len() <= BoxMinterConfig::MAX_URI_BASE,
        BoxMinterError::UriTooLong
    );
    require!(
        is_valid_uri_base(drop_base),
        BoxMinterError::InvalidMetadataBase
    );
    Ok(drop_base)
}

fn apply_uri_base(config: &mut BoxMinterConfig, admin: Pubkey, uri_base: &str) -> Result<()> {
    require_keys_eq!(
        config.admin,
        admin,
        BoxMinterError::UnauthorizedInitializer
    );
    config.uri_base = normalize_uri_base(uri_base)?.to_string();
    Ok(())
}

fn is_valid_uri_base(drop_base: &str) -> bool {
    if !drop_base.starts_with("https://")
        || drop_base.contains('?')
        || drop_base.contains('#')
        || drop_base.ends_with(".json")
        || drop_base.contains("/json/boxes")
        || drop_base.contains("/json/figures")
        || drop_base.contains("/json/receipts")
        || drop_base.bytes().any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return false;
    }
    let authority = drop_base["https://".len()..]
        .split('/')
        .next()
        .unwrap_or_default();
    !authority.is_empty() && !authority.starts_with('.') && !authority.ends_with('.')
}

fn verify_core_asset_owned_by_uri(
    asset_ai: &AccountInfo,
    owner: Pubkey,
    core_collection: Pubkey,
    expected_drop_base: &str,
    legacy_drop_base: Option<&str>,
    expected_uri_suffix: &str,
    expected_ref_id: Option<u32>,
) -> Result<()> {
    require_keys_eq!(*asset_ai.owner, MPL_CORE_PROGRAM_ID, BoxMinterError::InvalidAsset);
    let data = asset_ai.try_borrow_data()?;
    let base = parse_mpl_core_base_asset_v1(&data)?;
    require_keys_eq!(base.owner, owner, BoxMinterError::InvalidAssetOwner);
    require!(
        base.update_authority_kind == 2 && base.update_authority == core_collection,
        BoxMinterError::InvalidAssetCollection
    );

    // Ensure the asset corresponds to the expected kind by validating its URI prefix and (optionally) id.
    let parsed = parse_ref_id_from_uri_bytes_with_alias(
        base.uri,
        expected_drop_base,
        legacy_drop_base,
        expected_uri_suffix,
    )
        .ok_or(error!(BoxMinterError::InvalidAssetMetadata))?;
    if let Some(expected) = expected_ref_id {
        require!(parsed == expected, BoxMinterError::InvalidAssetMetadata);
    }
    Ok(())
}

fn parse_ref_id_from_uri_bytes_with_alias(
    uri: &[u8],
    expected_drop_base: &str,
    alias_drop_base: Option<&str>,
    expected_uri_suffix: &str,
) -> Option<u32> {
    parse_ref_id_from_uri_bytes(uri, expected_drop_base, expected_uri_suffix).or_else(|| {
        alias_drop_base.and_then(|drop_base| {
            parse_ref_id_from_uri_bytes(uri, drop_base, expected_uri_suffix)
        })
    })
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
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Invalid discount price")]
    InvalidDiscountPrice,
    #[msg("Discount config missing")]
    DiscountNotConfigured,
    #[msg("Invalid discount proof")]
    InvalidDiscountProof,
    #[msg("Name prefix too long")]
    NameTooLong,
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
    #[msg("Pending open record already exists")]
    PendingAlreadyExists,
    #[msg("Unauthorized initializer")]
    UnauthorizedInitializer,
    #[msg("Minting has not started yet")]
    MintNotStarted,
    #[msg("URI migration requires a recognized Little Swag Boxes base")]
    InvalidMigrationTarget,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq)]
    struct NonUriFields {
        admin: Pubkey,
        treasury: Pubkey,
        core_collection: Pubkey,
        price_lamports: u64,
        discount_price_lamports: u64,
        discount_merkle_root: [u8; 32],
        max_supply: u32,
        max_per_tx: u8,
        minted: u32,
        name_prefix: String,
        symbol: String,
        started: bool,
        bump: u8,
    }

    fn config(uri_base: &str) -> BoxMinterConfig {
        BoxMinterConfig {
            admin: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(),
            core_collection: Pubkey::new_unique(),
            price_lamports: 1_000_000_000,
            discount_price_lamports: 550_000_000,
            discount_merkle_root: [7; 32],
            max_supply: 333,
            max_per_tx: 15,
            minted: 333,
            name_prefix: "box".to_string(),
            symbol: "box".to_string(),
            uri_base: uri_base.to_string(),
            started: true,
            bump: 252,
        }
    }

    fn non_uri_fields(config: &BoxMinterConfig) -> NonUriFields {
        NonUriFields {
            admin: config.admin,
            treasury: config.treasury,
            core_collection: config.core_collection,
            price_lamports: config.price_lamports,
            discount_price_lamports: config.discount_price_lamports,
            discount_merkle_root: config.discount_merkle_root,
            max_supply: config.max_supply,
            max_per_tx: config.max_per_tx,
            minted: config.minted,
            name_prefix: config.name_prefix.clone(),
            symbol: config.symbol.clone(),
            started: config.started,
            bump: config.bump,
        }
    }

    #[test]
    fn config_layout_remains_289_bytes() {
        assert_eq!(BoxMinterConfig::SPACE, 289);
    }

    #[test]
    fn uri_base_normalization_accepts_new_and_rollback_roots() {
        assert_eq!(
            normalize_uri_base("https://cdn.lil.org/nft/little_swag_boxes///").unwrap(),
            "https://cdn.lil.org/nft/little_swag_boxes"
        );
        assert_eq!(
            normalize_uri_base(LEGACY_LITTLE_SWAG_BOXES_URI_BASE).unwrap(),
            LEGACY_LITTLE_SWAG_BOXES_URI_BASE
        );
    }

    #[test]
    fn uri_base_validation_rejects_overlong_and_metadata_paths() {
        let overlong = format!("https://cdn.lil.org/{}", "x".repeat(97));
        assert!(normalize_uri_base(&overlong).is_err());
        for invalid in [
            "",
            "http://cdn.lil.org/nft/little_swag_boxes",
            "https://cdn.lil.org/nft/little swag boxes",
            "https://cdn.lil.org/nft/little_swag_boxes?version=2",
            "https://cdn.lil.org/nft/little_swag_boxes#metadata",
            "https://cdn.lil.org/nft/little_swag_boxes.json",
            "https://cdn.lil.org/nft/little_swag_boxes/json/boxes",
            "https://cdn.lil.org/nft/little_swag_boxes/json/figures",
            "https://cdn.lil.org/nft/little_swag_boxes/json/receipts",
        ] {
            assert!(normalize_uri_base(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn uri_base_setter_requires_admin_and_preserves_other_config_fields() {
        let mut config = config(LEGACY_LITTLE_SWAG_BOXES_URI_BASE);
        let before = non_uri_fields(&config);
        let admin = config.admin;
        assert!(apply_uri_base(
            &mut config,
            Pubkey::new_unique(),
            "https://cdn.lil.org/nft/little_swag_boxes"
        )
        .is_err());
        assert_eq!(config.uri_base, LEGACY_LITTLE_SWAG_BOXES_URI_BASE);
        apply_uri_base(
            &mut config,
            admin,
            "https://cdn.lil.org/nft/little_swag_boxes",
        )
        .unwrap();
        assert_eq!(config.uri_base, "https://cdn.lil.org/nft/little_swag_boxes");
        assert_eq!(non_uri_fields(&config), before);
        apply_uri_base(&mut config, admin, LEGACY_LITTLE_SWAG_BOXES_URI_BASE).unwrap();
        assert_eq!(config.uri_base, LEGACY_LITTLE_SWAG_BOXES_URI_BASE);
        assert_eq!(non_uri_fields(&config), before);
    }

    #[test]
    fn box_uri_parser_accepts_current_and_legacy_roots() {
        let current = "https://cdn.lil.org/nft/little_swag_boxes";
        let legacy_uri = format!("{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_BOXES}7.json");
        let current_uri = format!("{current}{URI_SUFFIX_BOXES}8.json");
        assert_eq!(
            parse_ref_id_from_uri_bytes_with_alias(
                legacy_uri.as_bytes(),
                current,
                Some(LEGACY_LITTLE_SWAG_BOXES_URI_BASE),
                URI_SUFFIX_BOXES
            ),
            Some(7)
        );
        assert_eq!(
            parse_ref_id_from_uri_bytes_with_alias(
                current_uri.as_bytes(),
                current,
                Some(LEGACY_LITTLE_SWAG_BOXES_URI_BASE),
                URI_SUFFIX_BOXES
            ),
            Some(8)
        );
        assert_eq!(
            parse_ref_id_from_uri_bytes(
                b"https://cdn.lil.org/nft/unrelated/json/boxes/7.json",
                current,
                URI_SUFFIX_BOXES,
            ),
            None
        );
    }

    #[test]
    fn collection_parser_reads_authority_and_uri() {
        let authority = Pubkey::new_unique();
        let name = "Little Swag Boxes";
        let uri = format!("{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}/collection.json");
        let mut data = vec![5u8];
        data.extend_from_slice(authority.as_ref());
        data.extend_from_slice(&(name.len() as u32).to_le_bytes());
        data.extend_from_slice(name.as_bytes());
        data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
        data.extend_from_slice(uri.as_bytes());
        data.extend_from_slice(&333u32.to_le_bytes());
        data.extend_from_slice(&532u32.to_le_bytes());
        let parsed = parse_mpl_core_base_collection_v1(&data).unwrap();
        assert_eq!(parsed.update_authority, authority);
        assert_eq!(parsed.uri, uri.as_bytes());
        data[0] = 1;
        assert!(parse_mpl_core_base_collection_v1(&data).is_err());
    }

    #[test]
    fn core_uri_migration_is_exact_and_bounded() {
        assert_eq!(
            migrated_core_asset_uri(
                format!("{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_BOXES}333.json")
                    .as_bytes(),
                333,
                CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
            )
            .unwrap(),
            format!("{CURRENT_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_BOXES}333.json")
        );
        assert_eq!(
            migrated_core_asset_uri(
                format!("{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_FIGURES}999.json")
                    .as_bytes(),
                333,
                CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
            )
            .unwrap(),
            format!("{CURRENT_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_FIGURES}999.json")
        );
        for invalid in [
            format!("{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_BOXES}334.json"),
            format!("{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_FIGURES}1000.json"),
            format!("{CURRENT_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_BOXES}1.json"),
            "https://cdn.lil.org/nft/unrelated/json/boxes/1.json".to_string(),
        ] {
            assert!(migrated_core_asset_uri(
                invalid.as_bytes(),
                333,
                CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
            )
            .is_err());
        }
        assert_eq!(
            migrated_core_asset_uri(
                format!("{CURRENT_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_BOXES}1.json")
                    .as_bytes(),
                333,
                LEGACY_LITTLE_SWAG_BOXES_URI_BASE,
            )
            .unwrap(),
            format!("{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_BOXES}1.json")
        );
        assert!(core_asset_uri_matches_base(
            format!("{CURRENT_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_BOXES}1.json").as_bytes(),
            333,
            CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
        ));
        assert!(!core_asset_uri_matches_base(
            format!("{CURRENT_LITTLE_SWAG_BOXES_URI_BASE}/json/unrelated/1.json").as_bytes(),
            333,
            CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
        ));
        assert!(!core_asset_uri_matches_base(
            b"https://cdn.lil.org/nft/little_swag_boxes_evil/json/boxes/1.json",
            333,
            CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
        ));
    }

    #[test]
    fn receipt_uri_migration_reconstructs_exact_metadata() {
        assert_eq!(
            receipt_migration_metadata(
                RECEIPT_KIND_BOX,
                9,
                333,
                CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
            )
            .unwrap(),
            (
                "receipt · box 9".to_string(),
                format!("{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_RECEIPTS_BOXES}9.json"),
                format!("{CURRENT_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_RECEIPTS_BOXES}9.json"),
            )
        );
        assert_eq!(
            receipt_migration_metadata(
                RECEIPT_KIND_FIGURE,
                999,
                333,
                CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
            )
            .unwrap(),
            (
                "receipt · figure 999".to_string(),
                format!(
                    "{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_RECEIPTS_FIGURES}999.json"
                ),
                format!(
                    "{CURRENT_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_RECEIPTS_FIGURES}999.json"
                ),
            )
        );
        assert!(receipt_migration_metadata(
            RECEIPT_KIND_BOX,
            334,
            333,
            CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
        )
        .is_err());
        assert!(receipt_migration_metadata(
            RECEIPT_KIND_FIGURE,
            1000,
            333,
            CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
        )
        .is_err());
        assert!(receipt_migration_metadata(
            2,
            1,
            333,
            CURRENT_LITTLE_SWAG_BOXES_URI_BASE,
        )
        .is_err());
        assert_eq!(
            receipt_migration_metadata(
                RECEIPT_KIND_BOX,
                9,
                333,
                LEGACY_LITTLE_SWAG_BOXES_URI_BASE,
            )
            .unwrap()
            .2,
            format!("{LEGACY_LITTLE_SWAG_BOXES_URI_BASE}{URI_SUFFIX_RECEIPTS_BOXES}9.json")
        );
    }
}
