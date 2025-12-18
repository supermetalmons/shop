use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use borsh::BorshSerialize;
use core::fmt::Write;

declare_id!("CXCXHYVRh5QMCxBYZv58ubAcwnycPwyAy9SNHbtGCv8p");

// Bubblegum instruction discriminator for `mint_to_collection_v1` (mpl-bubblegum 2.1.1).
const IX_MINT_TO_COLLECTION_V1: [u8; 8] = [153, 18, 178, 47, 197, 158, 86, 15];
// Bubblegum instruction discriminator for `burn` (mpl-bubblegum 2.1.1 / mpl-bubblegum JS 0.11.0).
const IX_BURN: [u8; 8] = [116, 110, 29, 56, 107, 219, 42, 93];
// Hard safety cap: Bubblegum minting triggers multiple inner instructions per NFT, and Solana enforces
// a max instruction trace length per transaction. Empirically on devnet this caps out at 15 mints/tx.
const MAX_SAFE_MINTS_PER_TX: u8 = 15;

// Figure IDs are globally unique, 1..=999 for a 333 box supply (3 figures per box).
const DUDES_PER_BOX: usize = 3;
const MAX_DUDE_ID: u16 = 999;

#[program]
pub mod box_minter {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        args: InitializeArgs,
    ) -> Result<()> {
        require!(args.max_supply > 0, BoxMinterError::InvalidMaxSupply);
        require!(args.max_per_tx > 0, BoxMinterError::InvalidMaxPerTx);
        require!(args.max_per_tx <= MAX_SAFE_MINTS_PER_TX, BoxMinterError::InvalidMaxPerTx);
        require!(args.price_lamports > 0, BoxMinterError::InvalidPrice);
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

        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.treasury = ctx.accounts.treasury.key();
        cfg.merkle_tree = ctx.accounts.merkle_tree.key();
        cfg.collection_mint = ctx.accounts.collection_mint.key();
        cfg.collection_metadata = ctx.accounts.collection_metadata.key();
        cfg.collection_master_edition = ctx.accounts.collection_master_edition.key();
        cfg.price_lamports = args.price_lamports;
        cfg.max_supply = args.max_supply;
        cfg.max_per_tx = args.max_per_tx;
        cfg.minted = 0;
        cfg.name_prefix = args.name_prefix;
        cfg.symbol = args.symbol;
        cfg.uri_base = args.uri_base;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_treasury(ctx: Context<SetTreasury>, treasury: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.treasury = treasury;
        Ok(())
    }

    pub fn mint_boxes(ctx: Context<MintBoxes>, quantity: u8) -> Result<()> {
        let cfg = &ctx.accounts.config;

        require_keys_eq!(
            ctx.accounts.bubblegum_program.key(),
            mpl_bubblegum::ID,
            BoxMinterError::InvalidBubblegumProgram
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
        let cost = (cfg.price_lamports as u128)
            .checked_mul(quantity as u128)
            .ok_or(BoxMinterError::MathOverflow)?;
        require!(cost <= u64::MAX as u128, BoxMinterError::MathOverflow);
        let cost_u64 = cost as u64;
        if cost_u64 > 0 {
            let ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.treasury.key(),
                cost_u64,
            );
            anchor_lang::solana_program::program::invoke(
                &ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.treasury.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // Defensive: verify PDAs that are easy to spoof on the client (once per tx).
        verify_tree_authority(ctx.accounts.merkle_tree.key(), ctx.accounts.tree_authority.key())?;
        verify_bubblegum_signer(ctx.accounts.bubblegum_signer.key())?;
        verify_collection_authority_record(
            ctx.accounts.token_metadata_program.key(),
            cfg.collection_mint,
            ctx.accounts.config.key(),
            ctx.accounts.collection_authority_record_pda.key(),
        )?;

        // Mint via Bubblegum CPI; config PDA is both tree delegate and collection authority.
        // Optimization notes:
        // - Solana programs use a bump allocator; allocations are not freed until the instruction ends.
        // - The autogenerated mpl-bubblegum CPI helper allocates multiple Vecs per call.
        // - For batch mints this causes OOM long before compute is exhausted.
        // We avoid per-mint allocations by reusing instruction buffers and metadata structs.
        let bubblegum_program = ctx.accounts.bubblegum_program.to_account_info();
        let tree_config = ctx.accounts.tree_authority.to_account_info();
        let leaf_owner = ctx.accounts.payer.to_account_info();
        let leaf_delegate = ctx.accounts.payer.to_account_info();
        let merkle_tree = ctx.accounts.merkle_tree.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let tree_creator_or_delegate = ctx.accounts.config.to_account_info();
        let collection_authority = ctx.accounts.config.to_account_info();
        let collection_authority_record_pda = ctx.accounts.collection_authority_record_pda.to_account_info();
        let collection_mint = ctx.accounts.collection_mint.to_account_info();
        let collection_metadata = ctx.accounts.collection_metadata.to_account_info();
        let collection_edition = ctx.accounts.collection_master_edition.to_account_info();
        let bubblegum_signer = ctx.accounts.bubblegum_signer.to_account_info();
        let log_wrapper = ctx.accounts.log_wrapper.to_account_info();
        let compression_program = ctx.accounts.compression_program.to_account_info();
        let token_metadata_program = ctx.accounts.token_metadata_program.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();

        // Instruction metas are constant across all mints.
        let mut ix = Instruction {
            program_id: mpl_bubblegum::ID,
            accounts: vec![
                AccountMeta::new(*tree_config.key, false),
                AccountMeta::new_readonly(*leaf_owner.key, false),
                AccountMeta::new_readonly(*leaf_delegate.key, false),
                AccountMeta::new(*merkle_tree.key, false),
                AccountMeta::new_readonly(*payer.key, true),
                AccountMeta::new_readonly(*tree_creator_or_delegate.key, true),
                AccountMeta::new_readonly(*collection_authority.key, true),
                AccountMeta::new_readonly(*collection_authority_record_pda.key, false),
                AccountMeta::new_readonly(*collection_mint.key, false),
                AccountMeta::new(*collection_metadata.key, false),
                AccountMeta::new_readonly(*collection_edition.key, false),
                AccountMeta::new_readonly(*bubblegum_signer.key, false),
                AccountMeta::new_readonly(*log_wrapper.key, false),
                AccountMeta::new_readonly(*compression_program.key, false),
                AccountMeta::new_readonly(*token_metadata_program.key, false),
                AccountMeta::new_readonly(*system_program.key, false),
            ],
            // Discriminator + small metadata args; reserve to avoid reallocations.
            data: Vec::with_capacity(256),
        };

        // AccountInfo list is constant across all mints (program + all accounts in the same order).
        let mut account_infos = Vec::with_capacity(17);
        account_infos.push(bubblegum_program);
        account_infos.push(tree_config);
        account_infos.push(leaf_owner);
        account_infos.push(leaf_delegate);
        account_infos.push(merkle_tree);
        account_infos.push(payer);
        account_infos.push(tree_creator_or_delegate);
        account_infos.push(collection_authority);
        account_infos.push(collection_authority_record_pda);
        account_infos.push(collection_mint);
        account_infos.push(collection_metadata);
        account_infos.push(collection_edition);
        account_infos.push(bubblegum_signer);
        account_infos.push(log_wrapper);
        account_infos.push(compression_program);
        account_infos.push(token_metadata_program);
        account_infos.push(system_program);

        let creator = mpl_bubblegum::types::Creator {
            address: ctx.accounts.config.key(),
            verified: true,
            share: 100,
        };
        let mut creators = Vec::with_capacity(1);
        creators.push(creator);

        let mut metadata = mpl_bubblegum::types::MetadataArgs {
            // Build name into a preallocated String to avoid per-mint heap allocations.
            name: String::with_capacity(BoxMinterConfig::MAX_NAME_PREFIX + 12),
            symbol: cfg.symbol.clone(),
            // Build URI into a preallocated String to avoid per-mint heap allocations.
            // `cfg.uri_base` is treated as a prefix, and we append `<idx>.json` (unless it already ends in `.json`).
            uri: String::with_capacity(BoxMinterConfig::MAX_URI_BASE + 16),
            seller_fee_basis_points: 0,
            creators,
            primary_sale_happened: false,
            is_mutable: false,
            edition_nonce: None,
            token_standard: Some(mpl_bubblegum::types::TokenStandard::NonFungible),
            collection: Some(mpl_bubblegum::types::Collection {
                key: cfg.collection_mint,
                verified: true,
            }),
            uses: None,
            token_program_version: mpl_bubblegum::types::TokenProgramVersion::Original,
        };

        let signer_seeds: &[&[&[u8]]] = &[&[BoxMinterConfig::SEED, &[cfg.bump]]];
        let start_index = cfg.minted + 1;
        for i in 0..qty_u32 {
            let idx = start_index + i;

            // Update name in-place (no allocations).
            metadata.name.clear();
            metadata.name.push_str(&cfg.name_prefix);
            if !cfg.name_prefix.is_empty() && !cfg.name_prefix.ends_with(" ") {
                metadata.name.push(' ');
            }
            write!(&mut metadata.name, "{}", idx).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            // Update uri in-place (no allocations).
            metadata.uri.clear();
            metadata.uri.push_str(&cfg.uri_base);
            if !cfg.uri_base.is_empty() && !cfg.uri_base.ends_with(".json") {
                if !cfg.uri_base.ends_with('/') {
                    metadata.uri.push('/');
                }
                write!(&mut metadata.uri, "{}", idx).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
                metadata.uri.push_str(".json");
            }

            // Rebuild Bubblegum instruction data in-place: discriminator + borsh(metadata).
            ix.data.clear();
            ix.data.extend_from_slice(&IX_MINT_TO_COLLECTION_V1);
            metadata
                .serialize(&mut ix.data)
                .map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            invoke_signed(&ix, &account_infos, signer_seeds)
                .map_err(anchor_lang::error::Error::from)?;
        }

        ctx.accounts.config.minted = new_total;
        Ok(())
    }

    pub fn open_box<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, OpenBox<'info>>,
        args: OpenBoxArgs,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;

        // Require a cloud-held signer so users cannot pick arbitrary figure IDs.
        // (The config PDA signs Bubblegum CPI internally; without this, opening would be permissionless.)
        require_keys_eq!(
            ctx.accounts.cosigner.key(),
            cfg.admin,
            BoxMinterError::InvalidCosigner
        );

        require!(args.dude_ids.len() == DUDES_PER_BOX, BoxMinterError::InvalidQuantity);
        for id in args.dude_ids {
            require!(id >= 1 && id <= MAX_DUDE_ID, BoxMinterError::InvalidDudeId);
        }
        // Ensure the 3 revealed dudes are distinct.
        require!(
            args.dude_ids[0] != args.dude_ids[1]
                && args.dude_ids[0] != args.dude_ids[2]
                && args.dude_ids[1] != args.dude_ids[2],
            BoxMinterError::DuplicateDudeId
        );

        require_keys_eq!(
            ctx.accounts.bubblegum_program.key(),
            mpl_bubblegum::ID,
            BoxMinterError::InvalidBubblegumProgram
        );

        // Defensive: verify PDAs that are easy to spoof on the client.
        verify_tree_authority(ctx.accounts.merkle_tree.key(), ctx.accounts.tree_authority.key())?;
        verify_bubblegum_signer(ctx.accounts.bubblegum_signer.key())?;
        verify_collection_authority_record(
            ctx.accounts.token_metadata_program.key(),
            cfg.collection_mint,
            ctx.accounts.config.key(),
            ctx.accounts.collection_authority_record_pda.key(),
        )?;

        // 1) Burn the selected box leaf. The owner wallet must sign the tx (as payer), and the proof is passed
        // via `remaining_accounts` (optionally truncated by the canopy).
        {
            let mut data = Vec::with_capacity(8 + 32 * 3 + 8 + 4);
            data.extend_from_slice(&IX_BURN);
            data.extend_from_slice(&args.root);
            data.extend_from_slice(&args.data_hash);
            data.extend_from_slice(&args.creator_hash);
            data.extend_from_slice(&args.nonce.to_le_bytes());
            data.extend_from_slice(&args.index.to_le_bytes());

            let mut metas = Vec::with_capacity(7 + ctx.remaining_accounts.len());
            metas.push(AccountMeta::new_readonly(*ctx.accounts.tree_authority.key, false));
            // Bubblegum burn requires the leaf owner or leaf delegate to be a signer.
            // The outer tx is signed by `payer`, so we forward signer privilege here.
            metas.push(AccountMeta::new_readonly(*ctx.accounts.payer.key, true)); // leafOwner
            metas.push(AccountMeta::new_readonly(*ctx.accounts.payer.key, true)); // leafDelegate
            metas.push(AccountMeta::new(*ctx.accounts.merkle_tree.key, false));
            metas.push(AccountMeta::new_readonly(*ctx.accounts.log_wrapper.key, false));
            metas.push(AccountMeta::new_readonly(*ctx.accounts.compression_program.key, false));
            metas.push(AccountMeta::new_readonly(*ctx.accounts.system_program.key, false));
            for acc in ctx.remaining_accounts.iter() {
                metas.push(AccountMeta::new_readonly(acc.key(), false));
            }

            let ix = Instruction {
                program_id: mpl_bubblegum::ID,
                accounts: metas,
                data,
            };

            let mut infos = Vec::with_capacity(1 + 7 + ctx.remaining_accounts.len());
            infos.push(ctx.accounts.bubblegum_program.to_account_info());
            infos.push(ctx.accounts.tree_authority.to_account_info());
            infos.push(ctx.accounts.payer.to_account_info());
            infos.push(ctx.accounts.payer.to_account_info());
            infos.push(ctx.accounts.merkle_tree.to_account_info());
            infos.push(ctx.accounts.log_wrapper.to_account_info());
            infos.push(ctx.accounts.compression_program.to_account_info());
            infos.push(ctx.accounts.system_program.to_account_info());
            for acc in ctx.remaining_accounts.iter() {
                infos.push(acc.clone());
            }

            invoke(&ix, &infos).map_err(anchor_lang::error::Error::from)?;
        }

        // 2) Mint 3 figure cNFTs into the same collection + tree.
        // We derive the figures URI base from the on-chain boxes uri base to keep drop configuration on-chain.
        let figures_uri_base = derive_figures_uri_base(&cfg.uri_base)?;

        let bubblegum_program = ctx.accounts.bubblegum_program.to_account_info();
        let tree_config = ctx.accounts.tree_authority.to_account_info();
        let leaf_owner = ctx.accounts.payer.to_account_info();
        let leaf_delegate = ctx.accounts.payer.to_account_info();
        let merkle_tree = ctx.accounts.merkle_tree.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let tree_creator_or_delegate = ctx.accounts.config.to_account_info();
        let collection_authority = ctx.accounts.config.to_account_info();
        let collection_authority_record_pda = ctx.accounts.collection_authority_record_pda.to_account_info();
        let collection_mint = ctx.accounts.collection_mint.to_account_info();
        let collection_metadata = ctx.accounts.collection_metadata.to_account_info();
        let collection_edition = ctx.accounts.collection_master_edition.to_account_info();
        let bubblegum_signer = ctx.accounts.bubblegum_signer.to_account_info();
        let log_wrapper = ctx.accounts.log_wrapper.to_account_info();
        let compression_program = ctx.accounts.compression_program.to_account_info();
        let token_metadata_program = ctx.accounts.token_metadata_program.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();

        let mut ix = Instruction {
            program_id: mpl_bubblegum::ID,
            accounts: vec![
                AccountMeta::new(*tree_config.key, false),
                AccountMeta::new_readonly(*leaf_owner.key, false),
                AccountMeta::new_readonly(*leaf_delegate.key, false),
                AccountMeta::new(*merkle_tree.key, false),
                AccountMeta::new_readonly(*payer.key, true),
                AccountMeta::new_readonly(*tree_creator_or_delegate.key, true),
                AccountMeta::new_readonly(*collection_authority.key, true),
                AccountMeta::new_readonly(*collection_authority_record_pda.key, false),
                AccountMeta::new_readonly(*collection_mint.key, false),
                AccountMeta::new(*collection_metadata.key, false),
                AccountMeta::new_readonly(*collection_edition.key, false),
                AccountMeta::new_readonly(*bubblegum_signer.key, false),
                AccountMeta::new_readonly(*log_wrapper.key, false),
                AccountMeta::new_readonly(*compression_program.key, false),
                AccountMeta::new_readonly(*token_metadata_program.key, false),
                AccountMeta::new_readonly(*system_program.key, false),
            ],
            data: Vec::with_capacity(256),
        };

        let mut account_infos = Vec::with_capacity(17);
        account_infos.push(bubblegum_program);
        account_infos.push(tree_config);
        account_infos.push(leaf_owner);
        account_infos.push(leaf_delegate);
        account_infos.push(merkle_tree);
        account_infos.push(payer);
        account_infos.push(tree_creator_or_delegate);
        account_infos.push(collection_authority);
        account_infos.push(collection_authority_record_pda);
        account_infos.push(collection_mint);
        account_infos.push(collection_metadata);
        account_infos.push(collection_edition);
        account_infos.push(bubblegum_signer);
        account_infos.push(log_wrapper);
        account_infos.push(compression_program);
        account_infos.push(token_metadata_program);
        account_infos.push(system_program);

        let creator = mpl_bubblegum::types::Creator {
            address: ctx.accounts.config.key(),
            verified: true,
            share: 100,
        };
        let mut creators = Vec::with_capacity(1);
        creators.push(creator);

        let mut metadata = mpl_bubblegum::types::MetadataArgs {
            name: String::with_capacity(32),
            symbol: "MONS".to_string(),
            uri: String::with_capacity(128),
            seller_fee_basis_points: 0,
            creators,
            primary_sale_happened: false,
            is_mutable: false,
            edition_nonce: None,
            token_standard: Some(mpl_bubblegum::types::TokenStandard::NonFungible),
            collection: Some(mpl_bubblegum::types::Collection {
                key: cfg.collection_mint,
                verified: true,
            }),
            uses: None,
            token_program_version: mpl_bubblegum::types::TokenProgramVersion::Original,
        };

        let signer_seeds: &[&[&[u8]]] = &[&[BoxMinterConfig::SEED, &[cfg.bump]]];
        for dude_id in args.dude_ids {
            let id_u32 = dude_id as u32;

            metadata.name.clear();
            metadata.name.push_str("mons figure #");
            write!(&mut metadata.name, "{}", id_u32).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            metadata.uri.clear();
            metadata.uri.push_str(&figures_uri_base);
            write!(&mut metadata.uri, "{}", id_u32).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
            metadata.uri.push_str(".json");

            ix.data.clear();
            ix.data.extend_from_slice(&IX_MINT_TO_COLLECTION_V1);
            metadata
                .serialize(&mut ix.data)
                .map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            invoke_signed(&ix, &account_infos, signer_seeds).map_err(anchor_lang::error::Error::from)?;
        }

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct OpenBoxArgs {
    pub dude_ids: [u16; DUDES_PER_BOX],
    pub root: [u8; 32],
    pub data_hash: [u8; 32],
    pub creator_hash: [u8; 32],
    pub nonce: u64,
    pub index: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub price_lamports: u64,
    pub max_supply: u32,
    pub max_per_tx: u8,
    pub name_prefix: String,
    pub symbol: String,
    pub uri_base: String,
}

#[account]
pub struct BoxMinterConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub merkle_tree: Pubkey,
    pub collection_mint: Pubkey,
    pub collection_metadata: Pubkey,
    pub collection_master_edition: Pubkey,
    pub price_lamports: u64,
    pub max_supply: u32,
    pub max_per_tx: u8,
    pub minted: u32,
    pub name_prefix: String,
    pub symbol: String,
    pub uri_base: String,
    pub bump: u8,
}

impl BoxMinterConfig {
    pub const SEED: &'static [u8] = b"config";

    // Keep these tiny by design; minting up to 30 cNFTs in one tx is compute-bound.
    pub const MAX_NAME_PREFIX: usize = 8;
    pub const MAX_SYMBOL: usize = 10;
    pub const MAX_URI_BASE: usize = 96;

    pub const SPACE: usize = 8 // anchor account discriminator
        + 32 * 6 // pubkeys
        + 8 // price_lamports
        + 4 // max_supply
        + 1 // max_per_tx
        + 4 // minted
        + 4 + Self::MAX_NAME_PREFIX // name_prefix
        + 4 + Self::MAX_SYMBOL // symbol
        + 4 + Self::MAX_URI_BASE // uri_base
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

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Any SOL receiver is fine; stored in config.
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Stored in config and later validated against CPI accounts.
    pub merkle_tree: UncheckedAccount<'info>,

    /// CHECK: Stored in config and later validated against CPI accounts.
    pub collection_mint: UncheckedAccount<'info>,

    /// CHECK: Stored in config and later validated against CPI accounts.
    pub collection_metadata: UncheckedAccount<'info>,

    /// CHECK: Stored in config and later validated against CPI accounts.
    pub collection_master_edition: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetTreasury<'info> {
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

    /// CHECK: Must match config.merkle_tree
    #[account(mut, address = config.merkle_tree)]
    pub merkle_tree: UncheckedAccount<'info>,

    /// CHECK: Bubblegum TreeConfig PDA derived from merkle_tree.
    #[account(mut)]
    pub tree_authority: UncheckedAccount<'info>,

    /// CHECK: Metaplex collection mint (verified collection)
    #[account(address = config.collection_mint)]
    pub collection_mint: UncheckedAccount<'info>,

    /// CHECK: Metadata PDA for collection mint
    #[account(mut, address = config.collection_metadata)]
    pub collection_metadata: UncheckedAccount<'info>,

    /// CHECK: Master edition PDA for collection mint
    #[account(address = config.collection_master_edition)]
    pub collection_master_edition: UncheckedAccount<'info>,

    /// CHECK: Token Metadata collection authority record PDA for (collection_mint, config PDA)
    pub collection_authority_record_pda: UncheckedAccount<'info>,

    /// CHECK: Bubblegum's CPI signer PDA for collection verification
    pub bubblegum_signer: UncheckedAccount<'info>,

    /// CHECK: Metaplex Bubblegum program
    pub bubblegum_program: UncheckedAccount<'info>,

    /// CHECK: SPL Account Compression program
    pub compression_program: UncheckedAccount<'info>,

    /// CHECK: SPL Noop program
    pub log_wrapper: UncheckedAccount<'info>,

    /// CHECK: Metaplex Token Metadata program
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenBox<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (typically the same key used to deploy/initialize the config PDA).
    pub cosigner: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Must match config.merkle_tree
    #[account(mut, address = config.merkle_tree)]
    pub merkle_tree: UncheckedAccount<'info>,

    /// CHECK: Bubblegum TreeConfig PDA derived from merkle_tree.
    #[account(mut)]
    pub tree_authority: UncheckedAccount<'info>,

    /// CHECK: Metaplex collection mint (verified collection)
    #[account(address = config.collection_mint)]
    pub collection_mint: UncheckedAccount<'info>,

    /// CHECK: Metadata PDA for collection mint
    #[account(mut, address = config.collection_metadata)]
    pub collection_metadata: UncheckedAccount<'info>,

    /// CHECK: Master edition PDA for collection mint
    #[account(address = config.collection_master_edition)]
    pub collection_master_edition: UncheckedAccount<'info>,

    /// CHECK: Token Metadata collection authority record PDA for (collection_mint, config PDA)
    pub collection_authority_record_pda: UncheckedAccount<'info>,

    /// CHECK: Bubblegum's CPI signer PDA for collection verification
    pub bubblegum_signer: UncheckedAccount<'info>,

    /// CHECK: Metaplex Bubblegum program
    pub bubblegum_program: UncheckedAccount<'info>,

    /// CHECK: SPL Account Compression program
    pub compression_program: UncheckedAccount<'info>,

    /// CHECK: SPL Noop program
    pub log_wrapper: UncheckedAccount<'info>,

    /// CHECK: Metaplex Token Metadata program
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

fn verify_tree_authority(merkle_tree: Pubkey, tree_authority: Pubkey) -> Result<()> {
    let (expected, _bump) =
        Pubkey::find_program_address(&[merkle_tree.as_ref()], &mpl_bubblegum::ID);
    require_keys_eq!(tree_authority, expected, BoxMinterError::InvalidTreeAuthority);
    Ok(())
}

fn verify_bubblegum_signer(bubblegum_signer: Pubkey) -> Result<()> {
    let (expected, _bump) =
        Pubkey::find_program_address(&[b"collection_cpi"], &mpl_bubblegum::ID);
    require_keys_eq!(
        bubblegum_signer,
        expected,
        BoxMinterError::InvalidBubblegumSigner
    );
    Ok(())
}

fn verify_collection_authority_record(
    token_metadata_program: Pubkey,
    collection_mint: Pubkey,
    authority: Pubkey,
    collection_authority_record_pda: Pubkey,
) -> Result<()> {
    // PDA = ['metadata', token_metadata_program_id, collection_mint, 'collection_authority', authority]
    let (expected, _bump) = Pubkey::find_program_address(
        &[
            b"metadata",
            token_metadata_program.as_ref(),
            collection_mint.as_ref(),
            b"collection_authority",
            authority.as_ref(),
        ],
        &token_metadata_program,
    );
    require_keys_eq!(
        collection_authority_record_pda,
        expected,
        BoxMinterError::InvalidCollectionAuthorityRecord
    );
    Ok(())
}

fn derive_figures_uri_base(boxes_uri_base: &str) -> Result<String> {
    if boxes_uri_base.ends_with(".json") {
        // Shared single-URI metadata isn't compatible with per-figure IDs.
        return Err(error!(BoxMinterError::InvalidFigureUriBase));
    }

    let mut out = boxes_uri_base.to_string();
    if out.contains("/json/boxes/") {
        out = out.replace("/json/boxes/", "/json/figures/");
    } else if out.contains("/boxes/") {
        out = out.replace("/boxes/", "/figures/");
    } else if out.contains("boxes") {
        out = out.replace("boxes", "figures");
    } else {
        return Err(error!(BoxMinterError::InvalidFigureUriBase));
    }

    if !out.ends_with('/') {
        out.push('/');
    }
    Ok(out)
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
    #[msg("Name prefix too long")]
    NameTooLong,
    #[msg("Symbol too long")]
    SymbolTooLong,
    #[msg("URI base too long")]
    UriTooLong,
    #[msg("Invalid tree authority PDA")]
    InvalidTreeAuthority,
    #[msg("Invalid bubblegum signer PDA")]
    InvalidBubblegumSigner,
    #[msg("Invalid Bubblegum program id")]
    InvalidBubblegumProgram,
    #[msg("Invalid collection authority record PDA")]
    InvalidCollectionAuthorityRecord,
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
}


