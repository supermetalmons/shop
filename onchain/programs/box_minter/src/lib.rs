use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::program::invoke_signed;
use core::fmt::Write;

declare_id!("7qRds7SWuvnf78tRTCfD3JupXi8dcndrwdUTzw5t3LYi");

// Uncompressed Core NFTs are much heavier than cNFTs, but they don't require proofs.
// Keep conservative caps to avoid compute/tx-size failures.
// NOTE: Uncompressed Core mints are expensive; keep this reasonably low.
const MAX_SAFE_MINTS_PER_TX: u8 = 15;
const MAX_SAFE_DELIVERY_ITEMS_PER_TX: u8 = 8;
const MAX_SAFE_RECEIPTS_PER_TX: u8 = 12;

// Random delivery fee bounds (0.001..=0.003 SOL).
const MIN_DELIVERY_LAMPORTS: u64 = 1_000_000;
const MAX_DELIVERY_LAMPORTS: u64 = 3_000_000;

// Figure IDs are globally unique, 1..=999 for a 333 box supply (3 figures per box).
const DUDES_PER_BOX: usize = 3;
const MAX_DUDE_ID: u16 = 999;

// Asset PDA namespaces (owned by mpl-core; signed for via our program).
const SEED_BOX_ASSET: &[u8] = b"box";
const SEED_DUDE_ASSET: &[u8] = b"dude";
const SEED_RECEIPT_ASSET: &[u8] = b"receipt";

// Metaplex Core program id.
const MPL_CORE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    175, 84, 171, 16, 189, 151, 165, 66, 160, 158, 247, 179, 152, 137, 221, 12, 211, 148,
    164, 204, 233, 223, 166, 205, 201, 126, 190, 45, 35, 91, 167, 72,
]);

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

    pub fn open_box<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, OpenBox<'info>>,
        args: OpenBoxArgs,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;

        // Require a cloud-held signer so users cannot pick arbitrary figure IDs.
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

        // Remaining accounts: exactly 3 new figure asset PDAs, in the same order as dude_ids.
        require!(
            ctx.remaining_accounts.len() == DUDES_PER_BOX,
            BoxMinterError::InvalidRemainingAccounts
        );

        // Defensive: ensure the provided asset is a Mons *box* owned by payer.
        verify_core_asset_owned_by_uri(
            &ctx.accounts.box_asset.to_account_info(),
            ctx.accounts.payer.key(),
            cfg.core_collection,
            &cfg.uri_base,
            None,
        )?;

        // 1) Burn the box asset (MPL Core `BurnV1`).
        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let box_asset_ai = ctx.accounts.box_asset.to_account_info();

        let burn_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(box_asset_ai.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(core_collection.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(payer.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(payer.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false),
                // log_wrapper: None (placeholder)
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false),
            ],
            // discriminator=12, compression_proof=None
            data: vec![12u8, 0u8],
        };
        let burn_infos = [
            mpl_core_program.clone(),
            box_asset_ai.clone(),
            core_collection.clone(),
            payer.clone(),
            payer.clone(), // authority
            system_program.clone(),
        ];
        invoke(&burn_ix, &burn_infos).map_err(anchor_lang::error::Error::from)?;

        // 2) Mint 3 figure Core assets into the same collection.
        let figures_uri_base = derive_figures_uri_base(&cfg.uri_base)?;
        let cfg_ai = ctx.accounts.config.to_account_info();
        let cfg_signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];

        let mut create_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(Pubkey::default(), true), // asset placeholder
                anchor_lang::solana_program::instruction::AccountMeta::new(core_collection.key(), false), // collection
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cfg_ai.key(), true), // authority (config PDA)
                anchor_lang::solana_program::instruction::AccountMeta::new(payer.key(), true), // payer
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(payer.key(), false), // owner
                // update_authority: None (placeholder)
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false), // system
                // log_wrapper: None (placeholder)
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false),
            ],
            data: Vec::with_capacity(256),
        };
        let mut name_buf = String::with_capacity(32);
        let mut uri_buf = String::with_capacity(figures_uri_base.len() + 16);

        for (i, dude_id) in args.dude_ids.iter().enumerate() {
            let id_u16 = *dude_id;
            let id_bytes = id_u16.to_le_bytes();
            let (expected, asset_bump) =
                Pubkey::find_program_address(&[SEED_DUDE_ASSET, &id_bytes], ctx.program_id);

            let asset_ai = &ctx.remaining_accounts[i];
            require_keys_eq!(asset_ai.key(), expected, BoxMinterError::InvalidAssetPda);

            name_buf.clear();
            name_buf.push_str("mons figure #");
            write!(&mut name_buf, "{}", id_u16).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(&figures_uri_base);
            write!(&mut uri_buf, "{}", id_u16).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
            uri_buf.push_str(".json");

            let asset_seeds: &[&[u8]] = &[SEED_DUDE_ASSET, &id_bytes, &[asset_bump]];
            let signer_seeds: &[&[&[u8]]] = &[cfg_signer_seeds, asset_seeds];

            create_ix.accounts[0].pubkey = asset_ai.key();
            create_ix.data.clear();
            // CreateV1 discriminator=0, DataState::AccountState=0
            create_ix.data.push(0u8);
            create_ix.data.push(0u8);
            create_ix
                .data
                .extend_from_slice(&(name_buf.len() as u32).to_le_bytes());
            create_ix.data.extend_from_slice(name_buf.as_bytes());
            create_ix
                .data
                .extend_from_slice(&(uri_buf.len() as u32).to_le_bytes());
            create_ix.data.extend_from_slice(uri_buf.as_bytes());
            // plugins: None
            create_ix.data.push(0u8);

            let create_infos = [
                mpl_core_program.clone(),
                asset_ai.clone(),
                core_collection.clone(),
                cfg_ai.clone(),
                payer.clone(),
                payer.clone(),
                system_program.clone(),
            ];
            invoke_signed(&create_ix, &create_infos, signer_seeds).map_err(anchor_lang::error::Error::from)?;
        }

        Ok(())
    }

    pub fn deliver<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, Deliver<'info>>,
        args: DeliverArgs,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;

        // Require a cloud-held signer (same admin as initialize/open_box) so users can't choose arbitrary fees.
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

        require!(!args.items.is_empty(), BoxMinterError::InvalidQuantity);
        require!(
            (args.items.len() as u8) <= MAX_SAFE_DELIVERY_ITEMS_PER_TX,
            BoxMinterError::InvalidQuantity
        );

        require_keys_eq!(
            ctx.accounts.mpl_core_program.key(),
            MPL_CORE_PROGRAM_ID,
            BoxMinterError::InvalidMplCoreProgram
        );

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

        // Derive URI bases from the on-chain boxes uri base to keep configuration on-chain.
        let figures_uri_base = derive_figures_uri_base(&cfg.uri_base)?;
        let receipts_boxes_uri_base = derive_receipts_uri_base(&cfg.uri_base, ReceiptKind::Box)?;
        let receipts_figures_uri_base = derive_receipts_uri_base(&cfg.uri_base, ReceiptKind::Figure)?;

        // Remaining accounts: for each item => (asset_to_burn, receipt_asset_pda_to_create).
        require!(
            ctx.remaining_accounts.len() == args.items.len().saturating_mul(2),
            BoxMinterError::InvalidRemainingAccounts
        );

        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let cfg_ai = ctx.accounts.config.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let cfg_signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];

        // Reuse CPI buffers to avoid heap OOM under load.
        let mut burn_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(Pubkey::default(), false), // asset placeholder
                anchor_lang::solana_program::instruction::AccountMeta::new(core_collection.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(payer.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(payer.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false), // log_wrapper None
            ],
            // discriminator=12, compression_proof=None
            data: vec![12u8, 0u8],
        };

        let mut create_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(Pubkey::default(), true), // asset placeholder
                anchor_lang::solana_program::instruction::AccountMeta::new(core_collection.key(), false), // collection
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cfg_ai.key(), true), // authority (config PDA)
                anchor_lang::solana_program::instruction::AccountMeta::new(payer.key(), true), // payer
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(payer.key(), false), // owner
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false), // update_authority None
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false), // system
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false), // log_wrapper None
            ],
            data: Vec::with_capacity(256),
        };

        let mut name_buf = String::with_capacity(64);
        let mut uri_buf = String::with_capacity(128);

        for (i, item) in args.items.iter().enumerate() {
            let burn_ai = &ctx.remaining_accounts[i * 2];
            let receipt_ai = &ctx.remaining_accounts[i * 2 + 1];

            // Burn input must be a Mons asset owned by payer, and its metadata must match the claimed kind/ref_id.
            let expected_uri_base = match item.kind {
                0 => cfg.uri_base.as_str(),
                1 => figures_uri_base.as_str(),
                _ => return Err(error!(BoxMinterError::InvalidDeliveryItemKind)),
            };
            verify_core_asset_owned_by_uri(
                burn_ai,
                ctx.accounts.payer.key(),
                cfg.core_collection,
                expected_uri_base,
                Some(item.ref_id),
            )?;

            // 1) Burn the asset (MPL Core `BurnV1`).
            burn_ix.accounts[0].pubkey = burn_ai.key();
            let burn_infos = [
                mpl_core_program.clone(),
                burn_ai.clone(),
                core_collection.clone(),
                payer.clone(),
                payer.clone(), // authority
                system_program.clone(),
            ];
            invoke(&burn_ix, &burn_infos).map_err(anchor_lang::error::Error::from)?;

            // 2) Mint a receipt Core asset (same collection).
            let (kind_byte, uri_base, name_prefix) = match item.kind {
                0 => (0u8, &receipts_boxes_uri_base, "mons receipt · box "),
                1 => (1u8, &receipts_figures_uri_base, "mons receipt · figure #"),
                _ => return Err(error!(BoxMinterError::InvalidDeliveryItemKind)),
            };

            // Receipt PDA derived from (kind, ref_id) so it is globally unique.
            let ref_bytes = item.ref_id.to_le_bytes();
            let kind_seed = [kind_byte];
            let (expected, receipt_bump) = Pubkey::find_program_address(
                &[SEED_RECEIPT_ASSET, &kind_seed, &ref_bytes],
                ctx.program_id,
            );
            require_keys_eq!(receipt_ai.key(), expected, BoxMinterError::InvalidAssetPda);

            name_buf.clear();
            name_buf.push_str(name_prefix);
            write!(&mut name_buf, "{}", item.ref_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(uri_base);
            write!(&mut uri_buf, "{}", item.ref_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
            uri_buf.push_str(".json");

            let receipt_seeds: &[&[u8]] = &[SEED_RECEIPT_ASSET, &kind_seed, &ref_bytes, &[receipt_bump]];
            let signer_seeds: &[&[&[u8]]] = &[cfg_signer_seeds, receipt_seeds];

            create_ix.accounts[0].pubkey = receipt_ai.key();
            create_ix.data.clear();
            // CreateV1 discriminator=0, DataState::AccountState=0
            create_ix.data.push(0u8);
            create_ix.data.push(0u8);
            create_ix
                .data
                .extend_from_slice(&(name_buf.len() as u32).to_le_bytes());
            create_ix.data.extend_from_slice(name_buf.as_bytes());
            create_ix
                .data
                .extend_from_slice(&(uri_buf.len() as u32).to_le_bytes());
            create_ix.data.extend_from_slice(uri_buf.as_bytes());
            create_ix.data.push(0u8); // plugins: None

            let create_infos = [
                mpl_core_program.clone(),
                receipt_ai.clone(),
                core_collection.clone(),
                cfg_ai.clone(),
                payer.clone(),
                payer.clone(),
                system_program.clone(),
            ];
            invoke_signed(&create_ix, &create_infos, signer_seeds).map_err(anchor_lang::error::Error::from)?;
        }

        msg!("delivery_id:{}", args.delivery_id);
        Ok(())
    }

    pub fn mint_receipts<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, MintReceipts<'info>>,
        args: MintReceiptsArgs,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
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

        require!(!args.ref_ids.is_empty(), BoxMinterError::InvalidQuantity);
        require!(
            (args.ref_ids.len() as u8) <= MAX_SAFE_RECEIPTS_PER_TX,
            BoxMinterError::InvalidQuantity
        );

        let kind_byte = args.kind;
        require!(kind_byte == 0 || kind_byte == 1, BoxMinterError::InvalidReceiptKind);

        require!(
            ctx.remaining_accounts.len() == args.ref_ids.len(),
            BoxMinterError::InvalidRemainingAccounts
        );

        let receipts_uri_base = derive_receipts_uri_base(
            &cfg.uri_base,
            if kind_byte == 0 { ReceiptKind::Box } else { ReceiptKind::Figure },
        )?;
        let name_prefix = if kind_byte == 0 {
            "mons receipt · box "
        } else {
            "mons receipt · figure #"
        };

        let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
        let core_collection = ctx.accounts.core_collection.to_account_info();
        let payer = ctx.accounts.payer.to_account_info();
        let cfg_ai = ctx.accounts.config.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();
        let cfg_signer_seeds: &[&[u8]] = &[BoxMinterConfig::SEED, &[cfg.bump]];

        let mut create_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: MPL_CORE_PROGRAM_ID,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(Pubkey::default(), true), // asset placeholder
                anchor_lang::solana_program::instruction::AccountMeta::new(core_collection.key(), false), // collection
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(cfg_ai.key(), true), // authority (config PDA)
                anchor_lang::solana_program::instruction::AccountMeta::new(payer.key(), true), // payer
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(payer.key(), false), // owner
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false), // update_authority None
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(system_program.key(), false), // system
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(MPL_CORE_PROGRAM_ID, false), // log_wrapper None
            ],
            data: Vec::with_capacity(256),
        };
        let mut name_buf = String::with_capacity(64);
        let mut uri_buf = String::with_capacity(receipts_uri_base.len() + 32);

        let kind_seed = [kind_byte];
        for (i, ref_id) in args.ref_ids.iter().enumerate() {
            let receipt_ai = &ctx.remaining_accounts[i];
            let ref_bytes = ref_id.to_le_bytes();
            let (expected, bump) = Pubkey::find_program_address(
                &[SEED_RECEIPT_ASSET, &kind_seed, &ref_bytes],
                ctx.program_id,
            );
            require_keys_eq!(receipt_ai.key(), expected, BoxMinterError::InvalidAssetPda);

            name_buf.clear();
            name_buf.push_str(name_prefix);
            write!(&mut name_buf, "{}", ref_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;

            uri_buf.clear();
            uri_buf.push_str(&receipts_uri_base);
            write!(&mut uri_buf, "{}", ref_id).map_err(|_| error!(BoxMinterError::SerializationFailed))?;
            uri_buf.push_str(".json");

            let receipt_seeds: &[&[u8]] = &[SEED_RECEIPT_ASSET, &kind_seed, &ref_bytes, &[bump]];
            let signer_seeds: &[&[&[u8]]] = &[cfg_signer_seeds, receipt_seeds];

            create_ix.accounts[0].pubkey = receipt_ai.key();
            create_ix.data.clear();
            // CreateV1 discriminator=0, DataState::AccountState=0
            create_ix.data.push(0u8);
            create_ix.data.push(0u8);
            create_ix
                .data
                .extend_from_slice(&(name_buf.len() as u32).to_le_bytes());
            create_ix.data.extend_from_slice(name_buf.as_bytes());
            create_ix
                .data
                .extend_from_slice(&(uri_buf.len() as u32).to_le_bytes());
            create_ix.data.extend_from_slice(uri_buf.as_bytes());
            create_ix.data.push(0u8); // plugins: None

            let create_infos = [
                mpl_core_program.clone(),
                receipt_ai.clone(),
                core_collection.clone(),
                cfg_ai.clone(),
                payer.clone(),
                payer.clone(),
                system_program.clone(),
            ];
            invoke_signed(&create_ix, &create_infos, signer_seeds).map_err(anchor_lang::error::Error::from)?;
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
pub struct OpenBoxArgs {
    pub dude_ids: [u16; DUDES_PER_BOX],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct DeliverItemArgs {
    /// 0 = box, 1 = figure
    pub kind: u8,
    /// box id or dude id (for receipt metadata)
    pub ref_id: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DeliverArgs {
    pub delivery_id: u32,
    pub delivery_fee_lamports: u64,
    pub items: Vec<DeliverItemArgs>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MintReceiptsArgs {
    /// 0 = box, 1 = figure
    pub kind: u8,
    /// box ids or dude ids (for receipt metadata)
    pub ref_ids: Vec<u32>,
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
pub struct OpenBox<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin).
    pub cosigner: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Existing box Core asset account to burn.
    #[account(mut)]
    pub box_asset: UncheckedAccount<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(mut, address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
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
    #[account(mut, address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintReceipts<'info> {
    #[account(seeds = [BoxMinterConfig::SEED], bump = config.bump)]
    pub config: Account<'info, BoxMinterConfig>,

    /// Cloud-held signer (must match config.admin).
    pub cosigner: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: MPL-Core collection. Must match config.core_collection.
    #[account(mut, address = config.core_collection)]
    pub core_collection: UncheckedAccount<'info>,

    /// CHECK: Metaplex Core program
    pub mpl_core_program: UncheckedAccount<'info>,

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

#[derive(Clone, Copy)]
enum ReceiptKind {
    Box,
    Figure,
}

fn derive_receipts_uri_base(boxes_uri_base: &str, kind: ReceiptKind) -> Result<String> {
    if boxes_uri_base.ends_with(".json") {
        // Shared single-URI metadata isn't compatible with per-item IDs.
        return Err(error!(BoxMinterError::InvalidReceiptUriBase));
    }

    let target = match kind {
        ReceiptKind::Box => "/json/receipts/boxes/",
        ReceiptKind::Figure => "/json/receipts/figures/",
    };

    let mut out = boxes_uri_base.to_string();
    if out.contains("/json/boxes/") {
        out = out.replace("/json/boxes/", target);
    } else if out.contains("/boxes/") {
        out = out.replace("/boxes/", target);
    } else if out.contains("boxes") {
        let replacement = match kind {
            ReceiptKind::Box => "receipts/boxes",
            ReceiptKind::Figure => "receipts/figures",
        };
        out = out.replace("boxes", replacement);
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
    #[msg("Invalid receipt URI base")]
    InvalidReceiptUriBase,
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
    #[msg("Invalid receipt kind")]
    InvalidReceiptKind,
}


