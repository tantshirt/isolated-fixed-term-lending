//! Gate 8.4: program-controlled eSPL custody. A custody PDA owns an eATA,
//! funds it from the base layer, moves tokens PDA-signed inside the ER,
//! and withdraws back to the base layer.

use crate::constants::{CUSTODY_SEED, TEE_VALIDATOR};
use crate::error::PrivateLoanError;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::commit;
use crate::espl::{self, ESPL_PROGRAM_ID};

#[account]
#[derive(InitSpace)]
pub struct Custody {
    pub id: [u8; 32],
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
}

fn custody_seeds(c: &Custody) -> [&[u8]; 3] {
    [CUSTODY_SEED, &c.id, core::slice::from_ref(&c.bump)]
}

pub fn create_custody(ctx: Context<CreateCustody>, id: [u8; 32]) -> Result<()> {
    let c = &mut ctx.accounts.custody;
    c.id = id;
    c.authority = ctx.accounts.authority.key();
    c.mint = ctx.accounts.mint.key();
    c.bump = ctx.bumps.custody;

    let a = &ctx.accounts;
    espl::initialize_ephemeral_ata(
        &a.espl_program,
        &a.eata,
        &a.authority,
        &a.custody.to_account_info(),
        &a.mint.to_account_info(),
        &a.system_program,
    )
}

pub fn fund_and_delegate(ctx: Context<FundAndDelegate>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    let seeds = custody_seeds(&a.custody);
    if amount > 0 {
        token::transfer(
            CpiContext::new(
                a.token_program.key(),
                Transfer {
                    from: a.authority_ata.to_account_info(),
                    to: a.custody_ata.to_account_info(),
                    authority: a.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        espl::deposit(
            &a.espl_program,
            &a.eata,
            &a.vault,
            &a.mint.to_account_info(),
            &a.custody_ata.to_account_info(),
            &a.vault_ata.to_account_info(),
            &a.custody.to_account_info(),
            &a.token_program,
            amount,
            &[&seeds],
        )?;
    }
    espl::delegate(
        &a.espl_program,
        &a.authority,
        &a.eata,
        &a.eata_buffer,
        &a.eata_record,
        &a.eata_metadata,
        &a.delegation_program,
        &a.system_program,
        TEE_VALIDATOR,
    )
}

pub fn custody_transfer(ctx: Context<CustodyTransfer>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    let seeds = custody_seeds(&a.custody);
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.key(),
            Transfer {
                from: a.from_ata.to_account_info(),
                to: a.to_ata.to_account_info(),
                authority: a.custody.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
    )
}

pub fn undelegate_custody(ctx: Context<UndelegateCustody>) -> Result<()> {
    let a = &ctx.accounts;
    let seeds = custody_seeds(&a.custody);
    espl::undelegate(
        &a.espl_program,
        &a.custody.to_account_info(),
        &a.custody_ata,
        &a.eata,
        &a.magic_context,
        &a.magic_program,
        &[&seeds],
    )
}

pub fn withdraw_custody(ctx: Context<WithdrawCustody>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    let seeds = custody_seeds(&a.custody);
    espl::withdraw(
        &a.espl_program,
        &a.eata,
        &a.vault,
        &a.mint.to_account_info(),
        &a.vault_ata.to_account_info(),
        &a.custody_ata.to_account_info(),
        &a.custody.to_account_info(),
        &a.token_program,
        amount,
        &[&seeds],
    )?;
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.key(),
            Transfer {
                from: a.custody_ata.to_account_info(),
                to: a.authority_ata.to_account_info(),
                authority: a.custody.to_account_info(),
            },
            &[&seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
#[instruction(id: [u8; 32])]
pub struct CreateCustody<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Custody::INIT_SPACE, seeds = [CUSTODY_SEED, id.as_ref()], bump)]
    pub custody: Account<'info, Custody>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = authority, associated_token::mint = mint, associated_token::authority = custody)]
    pub custody_ata: Account<'info, TokenAccount>,
    /// CHECK: eATA PDA [custody, mint] under the eSPL program, created by that program.
    #[account(mut, seeds = [custody.key().as_ref(), mint.key().as_ref()], bump, seeds::program = espl_program.key())]
    pub eata: UncheckedAccount<'info>,
    /// CHECK: Fixed eSPL program id.
    #[account(address = ESPL_PROGRAM_ID)]
    pub espl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundAndDelegate<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ PrivateLoanError::Unauthorized, has_one = mint)]
    pub custody: Account<'info, Custody>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = authority)]
    pub authority_ata: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = custody)]
    pub custody_ata: Account<'info, TokenAccount>,
    /// CHECK: eATA PDA for this custody.
    #[account(mut, seeds = [custody.key().as_ref(), mint.key().as_ref()], bump, seeds::program = espl_program.key())]
    pub eata: UncheckedAccount<'info>,
    /// CHECK: Global vault PDA [mint] under the eSPL program.
    #[account(seeds = [mint.key().as_ref()], bump, seeds::program = espl_program.key())]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_ata: Account<'info, TokenAccount>,
    /// CHECK: Delegation buffer for the eATA, checked by the delegation program.
    #[account(mut)]
    pub eata_buffer: UncheckedAccount<'info>,
    /// CHECK: Delegation record for the eATA, checked by the delegation program.
    #[account(mut)]
    pub eata_record: UncheckedAccount<'info>,
    /// CHECK: Delegation metadata for the eATA, checked by the delegation program.
    #[account(mut)]
    pub eata_metadata: UncheckedAccount<'info>,
    /// CHECK: Fixed eSPL program id.
    #[account(address = ESPL_PROGRAM_ID)]
    pub espl_program: UncheckedAccount<'info>,
    /// CHECK: Fixed delegation program id.
    #[account(address = ephemeral_rollups_sdk::id())]
    pub delegation_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CustodyTransfer<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority @ PrivateLoanError::Unauthorized)]
    pub custody: Account<'info, Custody>,
    #[account(mut, associated_token::mint = custody.mint, associated_token::authority = custody)]
    pub from_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = custody.mint)]
    pub to_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[commit]
#[derive(Accounts)]
pub struct UndelegateCustody<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ PrivateLoanError::Unauthorized)]
    pub custody: Account<'info, Custody>,
    /// CHECK: The custody's ATA as projected by the ER.
    #[account(mut, address = anchor_spl::associated_token::get_associated_token_address(&custody.key(), &custody.mint))]
    pub custody_ata: UncheckedAccount<'info>,
    /// CHECK: eATA PDA for this custody.
    #[account(seeds = [custody.key().as_ref(), custody.mint.as_ref()], bump, seeds::program = ESPL_PROGRAM_ID)]
    pub eata: UncheckedAccount<'info>,
    /// CHECK: Fixed eSPL program id, invoked by CPI.
    #[account(address = ESPL_PROGRAM_ID)]
    pub espl_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WithdrawCustody<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ PrivateLoanError::Unauthorized, has_one = mint)]
    pub custody: Account<'info, Custody>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = authority)]
    pub authority_ata: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = custody)]
    pub custody_ata: Account<'info, TokenAccount>,
    /// CHECK: eATA PDA for this custody.
    #[account(mut, seeds = [custody.key().as_ref(), mint.key().as_ref()], bump, seeds::program = espl_program.key())]
    pub eata: UncheckedAccount<'info>,
    /// CHECK: Global vault PDA [mint] under the eSPL program.
    #[account(seeds = [mint.key().as_ref()], bump, seeds::program = espl_program.key())]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_ata: Account<'info, TokenAccount>,
    /// CHECK: Fixed eSPL program id.
    #[account(address = ESPL_PROGRAM_ID)]
    pub espl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
