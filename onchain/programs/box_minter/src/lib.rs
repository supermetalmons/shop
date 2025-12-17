use anchor_lang::prelude::*;

declare_id!("FPAzYdh8rdSRSXYQBneqwniqWGn3out5eQg2n1qyotxd");

#[program]
pub mod box_minter {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        args: InitializeArgs,
    ) -> Result<()> {
        require!(args.max_supply > 0, BoxMinterError::InvalidMaxSupply);
        require!(args.max_per_tx > 0, BoxMinterError::InvalidMaxPerTx);
        require!(args.max_per_tx <= 30, BoxMinterError::InvalidMaxPerTx);
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
        require!(quantity <= cfg.max_per_tx, BoxMinterError::InvalidQuantity);

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

        // Mint via Bubblegum CPI; config PDA is both tree delegate and collection authority.
        // NOTE: We keep metadata intentionally tiny so 30 mints stay within compute limits.
        let start_index = cfg.minted + 1;
        for i in 0..qty_u32 {
            let idx = start_index + i;
            mint_one_box_cpi(&*ctx.accounts, cfg, idx)?;
        }

        ctx.accounts.config.minted = new_total;
        Ok(())
    }
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

fn mint_one_box_cpi<'info>(
    accounts: &MintBoxes<'info>,
    cfg: &BoxMinterConfig,
    index: u32,
) -> Result<()> {
    // Defensive: verify PDAs that are easy to spoof on the client.
    verify_tree_authority(accounts)?;
    verify_bubblegum_signer(accounts)?;
    verify_collection_authority_record(accounts, cfg)?;

    let name = format!("{}{}", cfg.name_prefix, index);
    let symbol = cfg.symbol.clone();
    let uri = cfg.uri_base.clone();

    let creator = mpl_bubblegum::types::Creator {
        address: accounts.config.key(),
        verified: false,
        share: 100,
    };

    let metadata_args = mpl_bubblegum::types::MetadataArgs {
        name,
        symbol,
        uri,
        seller_fee_basis_points: 0,
        creators: vec![creator],
        primary_sale_happened: false,
        is_mutable: false,
        edition_nonce: None,
        token_standard: Some(mpl_bubblegum::types::TokenStandard::NonFungible),
        collection: Some(mpl_bubblegum::types::Collection {
            key: cfg.collection_mint,
            verified: false,
        }),
        uses: None,
        token_program_version: mpl_bubblegum::types::TokenProgramVersion::Original,
    };

    // mpl-bubblegum CPI expects references; bind AccountInfos so they live long enough.
    let bubblegum_program = accounts.bubblegum_program.to_account_info();
    let tree_config = accounts.tree_authority.to_account_info();
    let leaf_owner = accounts.payer.to_account_info();
    let leaf_delegate = accounts.payer.to_account_info();
    let merkle_tree = accounts.merkle_tree.to_account_info();
    let payer = accounts.payer.to_account_info();
    let tree_creator_or_delegate = accounts.config.to_account_info();
    let collection_authority = accounts.config.to_account_info();
    let collection_authority_record_pda = accounts.collection_authority_record_pda.to_account_info();
    let collection_mint = accounts.collection_mint.to_account_info();
    let collection_metadata = accounts.collection_metadata.to_account_info();
    let collection_edition = accounts.collection_master_edition.to_account_info();
    let bubblegum_signer = accounts.bubblegum_signer.to_account_info();
    let log_wrapper = accounts.log_wrapper.to_account_info();
    let compression_program = accounts.compression_program.to_account_info();
    let token_metadata_program = accounts.token_metadata_program.to_account_info();
    let system_program = accounts.system_program.to_account_info();

    let cpi = mpl_bubblegum::instructions::MintToCollectionV1Cpi::new(
        &bubblegum_program,
        mpl_bubblegum::instructions::MintToCollectionV1CpiAccounts {
            tree_config: &tree_config,
            leaf_owner: &leaf_owner,
            leaf_delegate: &leaf_delegate,
            merkle_tree: &merkle_tree,
            payer: &payer,
            tree_creator_or_delegate: &tree_creator_or_delegate,
            collection_authority: &collection_authority,
            collection_authority_record_pda: Some(&collection_authority_record_pda),
            collection_mint: &collection_mint,
            collection_metadata: &collection_metadata,
            collection_edition: &collection_edition,
            bubblegum_signer: &bubblegum_signer,
            log_wrapper: &log_wrapper,
            compression_program: &compression_program,
            token_metadata_program: &token_metadata_program,
            system_program: &system_program,
        },
        mpl_bubblegum::instructions::MintToCollectionV1InstructionArgs {
            metadata: metadata_args,
        },
    );

    let seeds: &[&[u8]] = &[
        BoxMinterConfig::SEED,
        &[cfg.bump],
    ];
    cpi.invoke_signed(&[seeds])
        .map_err(anchor_lang::error::Error::from)?;
    Ok(())
}

fn verify_tree_authority<'info>(accounts: &MintBoxes<'info>) -> Result<()> {
    let (expected, _bump) = Pubkey::find_program_address(
        &[accounts.merkle_tree.key().as_ref()],
        &mpl_bubblegum::ID,
    );
    require_keys_eq!(accounts.tree_authority.key(), expected, BoxMinterError::InvalidTreeAuthority);
    Ok(())
}

fn verify_bubblegum_signer<'info>(accounts: &MintBoxes<'info>) -> Result<()> {
    let (expected, _bump) = Pubkey::find_program_address(
        &[b"collection_cpi"],
        &mpl_bubblegum::ID,
    );
    require_keys_eq!(accounts.bubblegum_signer.key(), expected, BoxMinterError::InvalidBubblegumSigner);
    Ok(())
}

fn verify_collection_authority_record<'info>(
    accounts: &MintBoxes<'info>,
    cfg: &BoxMinterConfig,
) -> Result<()> {
    // PDA = ['metadata', token_metadata_program_id, collection_mint, 'collection_authority', authority]
    let token_md = accounts.token_metadata_program.key();
    let (expected, _bump) = Pubkey::find_program_address(
        &[
            b"metadata",
            token_md.as_ref(),
            cfg.collection_mint.as_ref(),
            b"collection_authority",
            accounts.config.key().as_ref(),
        ],
        &token_md,
    );
    require_keys_eq!(
        accounts.collection_authority_record_pda.key(),
        expected,
        BoxMinterError::InvalidCollectionAuthorityRecord
    );
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
}


