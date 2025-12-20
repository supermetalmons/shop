use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::sysvar::instructions as sysvar_instructions;
use core::fmt::Write;

declare_id!("49euba421M3MfEMbYZeduZU4UoXQ3oCWCQoJnvwVErnP");

// Uncompressed Core NFTs are much heavier than cNFTs, but they don't require proofs.
// Keep conservative caps to avoid compute/tx-size failures.
// NOTE: Uncompressed Core mints are expensive; keep this reasonably low.
const MAX_SAFE_MINTS_PER_TX: u8 = 15;
// Delivery is mostly limited by tx size; keep this high enough to not be the limiting factor.
const MAX_SAFE_DELIVERY_ITEMS_PER_TX: u8 = 32;

// Random delivery fee bounds (0.001..=0.003 SOL).
const MIN_DELIVERY_LAMPORTS: u64 = 1_000_000;
const MAX_DELIVERY_LAMPORTS: u64 = 3_000_000;

// Figure IDs are globally unique, 1..=999 for a 333 box supply (3 figures per box).
const DUDES_PER_BOX: usize = 3;
const MAX_DUDE_ID: u16 = 999;

// Asset PDA namespaces (owned by mpl-core; signed for via our program).
const SEED_BOX_ASSET: &[u8] = b"box";
const SEED_DELIVERY: &[u8] = b"delivery";
// Pending (two-step) box open flow.
const SEED_PENDING_OPEN: &[u8] = b"open";
const SEED_PENDING_DUDE_ASSET: &[u8] = b"pdude";

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

#[program]
pub mod box_minter {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        require!(args.max_supply > 0, BoxMinterError::InvalidMaxSupply);
        require!(args.max_per_tx > 0, BoxMinterError::InvalidMaxPerTx);
        require!(
            args.max_per_tx <= MAX_SAFE_MINTS_PER_TX,
            BoxMinterError::InvalidMaxPerTx
        );
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
        let cfg = &ctx.accounts.config;

        require_keys_eq!(
            ctx.accounts.mpl_core_program.key(),
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
            invoke(
                &ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.treasury.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // Remaining accounts: `quantity` PDA addresses for the new box assets.
        require!(
            ctx.remaining_accounts.len() == quantity as usize,
            BoxMinterError::InvalidRemainingAccounts
        );
        require!(
            box_bumps.len() == quantity as usize,
            BoxMinterError::InvalidRemainingAccounts
        );

        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let cfg_ai = ctx.accounts.config.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();

        let cfg_signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];
        let start_index = cfg.minted + 1;
        let payer_key = ctx.accounts.payer.key();
        let mint_id_bytes = mint_id.to_le_bytes();

        // IMPORTANT (memory): kinobi CPI builders allocate fresh Vec/Box per mint and the SBF heap is tiny.
        // Reuse buffers across the loop so minting 10+ assets doesn't OOM.
        let mut name_buf = String::with_capacity(BoxMinterConfig::MAX_NAME_PREFIX + 12);
        let mut uri_buf = String::with_capacity(BoxMinterConfig::MAX_URI_BASE + 16);

        let mut create_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: Vec::with_capacity(8),
            data: Vec::with_capacity(
                1 // discriminator
                + 1 // data_state
                + 4 + (BoxMinterConfig::MAX_NAME_PREFIX + 12) // name
                + 4 + (BoxMinterConfig::MAX_URI_BASE + 16) // uri
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
                ctx.program_id,
            )
            .map_err(|_| error!(BoxMinterError::InvalidAssetPda))?;

            let asset_ai = &ctx.remaining_accounts[i as usize];
            require_keys_eq!(asset_ai.key(), expected, BoxMinterError::InvalidAssetPda);
            // Ensure the account is uninitialized (otherwise Create will fail and waste compute).
            require_keys_eq!(
                *asset_ai.owner,
                anchor_lang::solana_program::system_program::ID,
                BoxMinterError::InvalidAssetPda
            );

            // Build metadata without allocating fresh Strings each loop.
            name_buf.clear();
            name_buf.push_str(&cfg.name_prefix);
            if !cfg.name_prefix.is_empty() && !cfg.name_prefix.ends_with(' ') {
                name_buf.push(' ');
            }
            write!(&mut name_buf, "{}", idx).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(&cfg.uri_base);
            if !cfg.uri_base.is_empty() && !cfg.uri_base.ends_with(".json") {
                if !cfg.uri_base.ends_with('/') {
                    uri_buf.push('/');
                }
                write!(&mut uri_buf, "{}", idx).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
                uri_buf.push_str(".json");
            }
            let asset_seeds: &[&[u8]] = &[
                SEED_BOX_ASSET,
                payer_key.as_ref(),
                &mint_id_bytes,
                &i_seed,
                &asset_bump_bytes,
            ];
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

        ctx.accounts.config.minted = new_total;
        Ok(())
    }

    /// Starts a two-step box open flow.
    ///
    /// This instruction must be immediately followed by an MPL-Core `TransferV1` that transfers
    /// `box_asset` from the user to `config.treasury` (vault). If the transfer fails, the whole
    /// transaction fails (so no pending state is created and no placeholder assets are minted).
    ///
    /// Side effects (all in this one transaction):
    /// - creates a `PendingOpenBox` PDA keyed by the box asset pubkey
    /// - mints 3 placeholder Core assets (empty metadata, no collection) owned by `config.treasury`
    pub fn start_open_box<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, StartOpenBox<'info>>,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;

        require_keys_eq!(
            ctx.accounts.mpl_core_program.key(),
            MPL_CORE_PROGRAM_ID,
            BoxMinterError::InvalidMplCoreProgram
        );

        // Defensive: ensure the provided asset is a Mons *box* owned by payer.
        verify_core_asset_owned_by_uri(
            &ctx.accounts.box_asset.to_account_info(),
            ctx.accounts.payer.key(),
            cfg.core_collection,
            &cfg.uri_base,
            None,
        )?;

        // IMPORTANT: wallets often won't show inner CPIs clearly; require an explicit top-level transfer.
        require_next_ix_is_mpl_core_transfer_of_asset_to(
            &ctx.accounts.instructions.to_account_info(),
            0,
            ctx.accounts.box_asset.key(),
            ctx.accounts.core_collection.key(),
            ctx.accounts.payer.key(),
            cfg.treasury,
        )?;

        // Remaining accounts: exactly 3 new placeholder dude asset PDAs.
        require!(
            ctx.remaining_accounts.len() == DUDES_PER_BOX,
            BoxMinterError::InvalidRemainingAccounts
        );

        // Create 3 placeholder Core assets:
        // - owner: config.treasury (vault/admin)
        // - update authority: config PDA (so only the program can later "reveal" by updating metadata + setting collection)
        // - collection: None (placeholder) so the assets do NOT appear in the collection until reveal.
        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let treasury = ctx.accounts.treasury.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let cfg_ai = ctx.accounts.config.to_account_info();
        let cfg_signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];

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
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(treasury.key(), false),
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
                treasury.clone(),
                cfg_ai.clone(),
                system_program.clone(),
            ];
            invoke_signed(&create_ix, &create_infos, signer_seeds)
                .map_err(anchor_lang::error::Error::from)?;
        }

        // Persist the pending flow record so the admin can later finalize it.
        let record = &mut ctx.accounts.pending;
        record.owner = ctx.accounts.payer.key();
        record.box_asset = ctx.accounts.box_asset.key();
        record.dudes = dudes;
        record.created_slot = Clock::get()?.slot;
        record.bump = ctx.bumps.pending;

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

        // Admin-only. In this repo we run single-master-key mode (admin == treasury).
        require_keys_eq!(
            ctx.accounts.cosigner.key(),
            cfg.admin,
            BoxMinterError::InvalidCosigner
        );
        require_keys_eq!(
            ctx.accounts.cosigner.key(),
            cfg.treasury,
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
        verify_core_asset_owned_by_uri(
            &ctx.accounts.box_asset.to_account_info(),
            cfg.treasury,
            cfg.core_collection,
            &cfg.uri_base,
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
        let figures_uri_base = derive_figures_uri_base(&cfg.uri_base)?;
        let mut name_buf = String::with_capacity(32);
        let mut uri_buf = String::with_capacity(figures_uri_base.len() + 16);

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
            name_buf.push_str("mons figure #");
            write!(&mut name_buf, "{}", dude_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(&figures_uri_base);
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
        require_keys_eq!(
            ctx.accounts.cosigner.key(),
            cfg.admin,
            BoxMinterError::InvalidCosigner
        );

        require!(
            args.delivery_fee_lamports >= MIN_DELIVERY_LAMPORTS
                && args.delivery_fee_lamports <= MAX_DELIVERY_LAMPORTS,
            BoxMinterError::InvalidDeliveryFee
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
        require!(
            ctx.accounts.delivery.to_account_info().data_is_empty(),
            BoxMinterError::DeliveryAlreadyExists
        );

        // Create the tiny on-chain delivery record (presence == paid order).
        let delivery_space: usize = DeliveryRecord::SPACE;
        let rent_lamports = Rent::get()?.minimum_balance(delivery_space);
        let create_delivery_ix = anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.payer.key(),
            &ctx.accounts.delivery.key(),
            rent_lamports,
            delivery_space as u64,
            ctx.program_id,
        );
        let delivery_seeds: &[&[u8]] = &[SEED_DELIVERY, &delivery_id_bytes, &[args.delivery_bump]];
        invoke_signed(
            &create_delivery_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.delivery.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[delivery_seeds],
        )?;

        let record = DeliveryRecord {
            payer: ctx.accounts.payer.key(),
            delivery_fee_lamports: args.delivery_fee_lamports,
            item_count: ctx.remaining_accounts.len() as u16,
        };
        record.try_serialize(&mut &mut ctx.accounts.delivery.to_account_info().data.borrow_mut()[..])?;

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

        // Transfer all delivered assets to the vault (config.treasury) via MPL-Core `TransferV1`.
        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let treasury = ctx.accounts.treasury.to_account_info();
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
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(treasury.key(), false),
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
                    treasury.clone(),
                    system_program.clone(),
                    log_wrapper.clone(),
                    mpl_core_program.clone(),
                ],
            )?;
        }

        msg!("delivery_id:{}", args.delivery_id);
        Ok(())
    }

    pub fn close_delivery(ctx: Context<CloseDelivery>, args: CloseDeliveryArgs) -> Result<()> {
        let cfg = &ctx.accounts.config;

        // Require a cloud-held signer (same admin as initialize).
        require_keys_eq!(
            ctx.accounts.cosigner.key(),
            cfg.admin,
            BoxMinterError::InvalidCosigner
        );

        // Validate delivery PDA.
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
        require_keys_eq!(
            *ctx.accounts.delivery.owner,
            *ctx.program_id,
            BoxMinterError::InvalidDeliveryPda
        );

        // Drain lamports to the treasury and close the account (reclaim rent).
        let delivery_ai = ctx.accounts.delivery.to_account_info();
        let treasury_ai = ctx.accounts.treasury.to_account_info();
        let lamports = delivery_ai.lamports();
        if lamports > 0 {
            **treasury_ai.lamports.borrow_mut() = treasury_ai
                .lamports()
                .checked_add(lamports)
                .ok_or(BoxMinterError::MathOverflow)?;
            **delivery_ai.lamports.borrow_mut() = 0;
        }

        // Mark as system-owned + shrink data so it can be reclaimed.
        delivery_ai.assign(&anchor_lang::solana_program::system_program::ID);
        delivery_ai.resize(0)?;

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
        // Single-master-key mode in this repo.
        require_keys_eq!(
            ctx.accounts.cosigner.key(),
            cfg.treasury,
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

        let receipts_boxes_uri_base = derive_receipts_boxes_uri_base(&cfg.uri_base)?;
        let receipts_figures_uri_base = derive_receipts_figures_uri_base(&cfg.uri_base)?;

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
        let mut uri_buf = String::with_capacity(receipts_boxes_uri_base.len().max(receipts_figures_uri_base.len()) + 16);

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
            name_buf.push_str("mons receipt · box ");
            write!(&mut name_buf, "{}", *box_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(&receipts_boxes_uri_base);
            write!(&mut uri_buf, "{}", *box_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
            uri_buf.push_str(".json");
            mint_one(&name_buf, &uri_buf)?;
        }

        for dude_id in dude_ids.iter() {
            name_buf.clear();
            name_buf.push_str("mons receipt · figure #");
            write!(&mut name_buf, "{}", *dude_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(&receipts_figures_uri_base);
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

#[account]
pub struct BoxMinterConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub core_collection: Pubkey,
    pub price_lamports: u64,
    pub max_supply: u32,
    pub max_per_tx: u8,
    pub minted: u32,
    pub name_prefix: String,
    pub symbol: String,
    pub uri_base: String,
    pub bump: u8,
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
        + 4 // max_supply
        + 1 // max_per_tx
        + 4 // minted
        + 4 + Self::MAX_NAME_PREFIX // name_prefix
        + 4 + Self::MAX_SYMBOL // symbol
        + 4 + Self::MAX_URI_BASE // uri_base
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

    #[account(mut)]
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
pub struct StartOpenBox<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Existing box Core asset account to transfer to the vault.
    #[account(mut)]
    pub box_asset: UncheckedAccount<'info>,

    /// CHECK: Must match config.treasury (owner for placeholder dudes).
    #[account(address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Instructions sysvar (for requiring an explicit MPL-Core transfer after `start_open_box`).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = PendingOpenBox::SPACE,
        seeds = [SEED_PENDING_OPEN, box_asset.key().as_ref()],
        bump,
    )]
    pub pending: Account<'info, PendingOpenBox>,
}

#[derive(Accounts)]
pub struct FinalizeOpenBox<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin and config.treasury in this repo).
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
pub struct CloseDelivery<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin).
    pub cosigner: Signer<'info>,

    /// CHECK: Must match config.treasury
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Delivery record PDA to close.
    #[account(mut)]
    pub delivery: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintReceipts<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin and config.treasury in this repo).
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

fn parse_ref_id_from_uri_bytes(uri: &[u8], uri_base: &str) -> Option<u32> {
    if uri_base.ends_with(".json") {
        // Single shared metadata URI (no numeric id to extract).
        return None;
    }
    let base = uri_base.as_bytes();
    if !uri.starts_with(base) {
        return None;
    }
    let mut rest = &uri[base.len()..];
    if !uri_base.ends_with('/') {
        if rest.first().copied() != Some(b'/') {
            return None;
        }
        rest = &rest[1..];
    }
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

fn require_next_ix_is_mpl_core_transfer_of_asset_to(
    instructions_ai: &AccountInfo,
    offset: usize,
    asset: Pubkey,
    core_collection: Pubkey,
    owner: Pubkey,
    new_owner: Pubkey,
) -> Result<()> {
    let current_index = sysvar_instructions::load_current_index_checked(instructions_ai)? as usize;
    let ix_index = current_index
        .checked_add(1)
        .and_then(|v| v.checked_add(offset))
        .ok_or(error!(BoxMinterError::InvalidTransferInstruction))?;
    let next_ix = sysvar_instructions::load_instruction_at_checked(ix_index, instructions_ai)
        .map_err(|_| error!(BoxMinterError::MissingTransferInstruction))?;

    require_keys_eq!(
        next_ix.program_id,
        MPL_CORE_PROGRAM_ID,
        BoxMinterError::InvalidTransferInstruction
    );
    require!(
        next_ix.data.len() >= 2,
        BoxMinterError::InvalidTransferInstruction
    );
    // TransferV1 discriminator = 14; compression_proof = None (0)
    require!(
        next_ix.data[0] == 14u8 && next_ix.data[1] == 0u8,
        BoxMinterError::InvalidTransferInstruction
    );

    // Enforce a stable account layout so the client/backend can construct deterministic transactions:
    //   0: asset
    //   1: collection
    //   2: payer (signer)
    //   3: owner/authority (signer)  (same as payer here)
    //   4: new_owner (vault)
    //
    // Additional accounts (system_program, log_wrapper, etc.) may follow.
    let a0 = next_ix
        .accounts
        .get(0)
        .ok_or(error!(BoxMinterError::InvalidTransferInstruction))?;
    require_keys_eq!(a0.pubkey, asset, BoxMinterError::InvalidTransferInstruction);

    let a1 = next_ix
        .accounts
        .get(1)
        .ok_or(error!(BoxMinterError::InvalidTransferInstruction))?;
    require_keys_eq!(
        a1.pubkey,
        core_collection,
        BoxMinterError::InvalidTransferInstruction
    );

    let a2 = next_ix
        .accounts
        .get(2)
        .ok_or(error!(BoxMinterError::InvalidTransferInstruction))?;
    require_keys_eq!(a2.pubkey, owner, BoxMinterError::InvalidTransferInstruction);
    require!(a2.is_signer, BoxMinterError::InvalidTransferInstruction);

    let a3 = next_ix
        .accounts
        .get(3)
        .ok_or(error!(BoxMinterError::InvalidTransferInstruction))?;
    require_keys_eq!(a3.pubkey, owner, BoxMinterError::InvalidTransferInstruction);
    require!(a3.is_signer, BoxMinterError::InvalidTransferInstruction);

    let a4 = next_ix
        .accounts
        .get(4)
        .ok_or(error!(BoxMinterError::InvalidTransferInstruction))?;
    require_keys_eq!(
        a4.pubkey,
        new_owner,
        BoxMinterError::InvalidTransferInstruction
    );

    Ok(())
}

fn verify_core_asset_owned_by_uri(
    asset_ai: &AccountInfo,
    owner: Pubkey,
    core_collection: Pubkey,
    expected_uri_base: &str,
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
    if expected_uri_base.ends_with(".json") {
        require!(base.uri == expected_uri_base.as_bytes(), BoxMinterError::InvalidAssetMetadata);
        require!(expected_ref_id.is_none(), BoxMinterError::InvalidAssetMetadata);
        return Ok(());
    }

    let parsed =
        parse_ref_id_from_uri_bytes(base.uri, expected_uri_base).ok_or(error!(BoxMinterError::InvalidAssetMetadata))?;
    if let Some(expected) = expected_ref_id {
        require!(parsed == expected, BoxMinterError::InvalidAssetMetadata);
    }
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

fn derive_receipts_figures_uri_base(boxes_uri_base: &str) -> Result<String> {
    if boxes_uri_base.ends_with(".json") {
        // Shared single-URI metadata isn't compatible with per-figure receipt IDs.
        return Err(error!(BoxMinterError::InvalidReceiptUriBase));
    }

    let mut out = boxes_uri_base.to_string();
    if out.contains("/json/boxes/") {
        out = out.replace("/json/boxes/", "/json/receipts/figures/");
    } else if out.contains("/boxes/") {
        out = out.replace("/boxes/", "/receipts/figures/");
    } else if out.contains("boxes") {
        out = out.replace("boxes", "receipts/figures");
    } else {
        return Err(error!(BoxMinterError::InvalidReceiptUriBase));
    }

    if !out.ends_with('/') {
        out.push('/');
    }
    Ok(out)
}

fn derive_receipts_boxes_uri_base(boxes_uri_base: &str) -> Result<String> {
    if boxes_uri_base.ends_with(".json") {
        // Shared single-URI metadata isn't compatible with per-box receipt IDs.
        return Err(error!(BoxMinterError::InvalidReceiptUriBase));
    }

    let mut out = boxes_uri_base.to_string();
    if out.contains("/json/boxes/") {
        out = out.replace("/json/boxes/", "/json/receipts/boxes/");
    } else if out.contains("/boxes/") {
        out = out.replace("/boxes/", "/receipts/boxes/");
    } else if out.contains("boxes") {
        out = out.replace("boxes", "receipts/boxes");
    } else {
        return Err(error!(BoxMinterError::InvalidReceiptUriBase));
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
}


