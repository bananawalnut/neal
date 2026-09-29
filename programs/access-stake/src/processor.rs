use borsh::BorshDeserialize;
use solana_program::{
    account_info::{AccountInfo, next_account_info},
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_sdk_ids::system_program;
use solana_system_interface::instruction as system_instruction;

use crate::{
    client::TOKEN_2022_PROGRAM_ID,
    error::AccessStakeError,
    instruction::AccessStakeInstruction,
    state::{
        AccessConfig, CONFIG_DISCRIMINATOR, CONFIG_SEED, STAKE_DISCRIMINATOR, STAKE_SEED,
        StakeReceipt, StakeStatus, decode, encode,
    },
};

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = AccessStakeInstruction::try_from_slice(instruction_data)
        .map_err(|_| AccessStakeError::InvalidInstruction)?;

    match instruction {
        AccessStakeInstruction::InitializeConfig {
            config_id,
            required_amount,
            minimum_lock_seconds,
        } => initialize_config(
            program_id,
            accounts,
            config_id,
            required_amount,
            minimum_lock_seconds,
        ),
        AccessStakeInstruction::UpdateConfig {
            required_amount,
            minimum_lock_seconds,
            paused,
        } => update_config(
            program_id,
            accounts,
            required_amount,
            minimum_lock_seconds,
            paused,
        ),
        AccessStakeInstruction::Stake { token_decimals } => {
            stake(program_id, accounts, token_decimals)
        }
        AccessStakeInstruction::ClaimAccess => claim_access(program_id, accounts),
        AccessStakeInstruction::Unstake { token_decimals } => {
            unstake(program_id, accounts, token_decimals)
        }
    }
}

fn initialize_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config_id: u64,
    required_amount: u64,
    minimum_lock_seconds: i64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let authority = next_account_info(iter)?;
    let config_info = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system_program_info = next_account_info(iter)?;

    require_signer(payer)?;
    require_signer(authority)?;
    require_key(system_program_info, &system_program::id())?;
    validate_token_program(token_program)?;
    validate_mint(mint, token_program, None)?;
    AccessConfig::validate_terms(required_amount, minimum_lock_seconds)?;

    let config_id_bytes = config_id.to_le_bytes();
    let (expected, bump) = Pubkey::find_program_address(
        &[CONFIG_SEED, authority.key.as_ref(), &config_id_bytes],
        program_id,
    );
    require_key(config_info, &expected)?;
    create_pda_account(
        payer,
        config_info,
        system_program_info,
        program_id,
        AccessConfig::SPACE,
        &[
            CONFIG_SEED,
            authority.key.as_ref(),
            &config_id_bytes,
            &[bump],
        ],
    )?;

    encode(
        &AccessConfig {
            discriminator: CONFIG_DISCRIMINATOR,
            version: 1,
            authority: *authority.key,
            config_id,
            mint: *mint.key,
            token_program: *token_program.key,
            required_amount,
            minimum_lock_seconds,
            paused: false,
            bump,
        },
        &mut config_info.try_borrow_mut_data()?,
    )?;
    msg!(
        "NEAL_ACCESS_CONFIG_INITIALIZED {} {} {}",
        config_info.key,
        required_amount,
        minimum_lock_seconds
    );
    Ok(())
}

fn update_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    required_amount: Option<u64>,
    minimum_lock_seconds: Option<i64>,
    paused: Option<bool>,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config_info = next_account_info(iter)?;

    require_signer(authority)?;
    require_owner(config_info, program_id)?;
    let mut config: AccessConfig = decode(&config_info.try_borrow_data()?)?;
    validate_config(&config)?;
    validate_config_address(program_id, config_info.key, &config)?;
    if config.authority != *authority.key {
        return Err(AccessStakeError::InvalidAuthority.into());
    }

    let next_amount = required_amount.unwrap_or(config.required_amount);
    let next_lock = minimum_lock_seconds.unwrap_or(config.minimum_lock_seconds);
    AccessConfig::validate_terms(next_amount, next_lock)?;
    config.required_amount = next_amount;
    config.minimum_lock_seconds = next_lock;
    if let Some(next_paused) = paused {
        config.paused = next_paused;
    }
    encode(&config, &mut config_info.try_borrow_mut_data()?)?;
    msg!(
        "NEAL_ACCESS_CONFIG_UPDATED {} {} {} {}",
        config_info.key,
        config.required_amount,
        config.minimum_lock_seconds,
        config.paused
    );
    Ok(())
}

fn stake(program_id: &Pubkey, accounts: &[AccountInfo], token_decimals: u8) -> ProgramResult {
    let iter = &mut accounts.iter();
    let staker = next_account_info(iter)?;
    let config_info = next_account_info(iter)?;
    let receipt_info = next_account_info(iter)?;
    let source = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system_program_info = next_account_info(iter)?;
    let clock_info = next_account_info(iter)?;

    require_signer(staker)?;
    require_owner(config_info, program_id)?;
    require_key(system_program_info, &system_program::id())?;
    let clock = Clock::from_account_info(clock_info)?;
    let config: AccessConfig = decode(&config_info.try_borrow_data()?)?;
    validate_config(&config)?;
    validate_config_address(program_id, config_info.key, &config)?;
    require_not_paused(&config)?;
    require_key(mint, &config.mint)?;
    require_key(token_program, &config.token_program)?;
    validate_token_program(token_program)?;
    validate_mint(mint, token_program, Some(token_decimals))?;

    let (expected, bump) = Pubkey::find_program_address(
        &[STAKE_SEED, config_info.key.as_ref(), staker.key.as_ref()],
        program_id,
    );
    require_key(receipt_info, &expected)?;
    create_pda_account(
        staker,
        receipt_info,
        system_program_info,
        program_id,
        StakeReceipt::SPACE,
        &[
            STAKE_SEED,
            config_info.key.as_ref(),
            staker.key.as_ref(),
            &[bump],
        ],
    )?;

    validate_token_account(source, token_program, mint.key, Some(staker.key))?;
    if validate_token_account(vault, token_program, mint.key, Some(receipt_info.key))? != 0 {
        return Err(AccessStakeError::InvalidAmount.into());
    }
    transfer_checked(
        token_program,
        source,
        mint,
        vault,
        staker,
        config.required_amount,
        token_decimals,
        None,
    )?;
    if validate_token_account(vault, token_program, mint.key, Some(receipt_info.key))?
        != config.required_amount
    {
        return Err(AccessStakeError::InvalidAmount.into());
    }

    let unlock_at = clock
        .unix_timestamp
        .checked_add(config.minimum_lock_seconds)
        .ok_or(AccessStakeError::ArithmeticOverflow)?;
    encode(
        &StakeReceipt {
            discriminator: STAKE_DISCRIMINATOR,
            version: 1,
            config: *config_info.key,
            staker: *staker.key,
            vault: *vault.key,
            amount: config.required_amount,
            staked_at: clock.unix_timestamp,
            unlock_at,
            claimed_at: 0,
            released_at: 0,
            status: StakeStatus::Active,
            bump,
        },
        &mut receipt_info.try_borrow_mut_data()?,
    )?;
    msg!(
        "NEAL_ACCESS_STAKED {} {} {} {}",
        receipt_info.key,
        staker.key,
        config.required_amount,
        unlock_at
    );
    Ok(())
}

fn claim_access(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let staker = next_account_info(iter)?;
    let config_info = next_account_info(iter)?;
    let receipt_info = next_account_info(iter)?;
    let clock_info = next_account_info(iter)?;

    require_signer(staker)?;
    require_owner(config_info, program_id)?;
    require_owner(receipt_info, program_id)?;
    let clock = Clock::from_account_info(clock_info)?;
    let config: AccessConfig = decode(&config_info.try_borrow_data()?)?;
    validate_config(&config)?;
    validate_config_address(program_id, config_info.key, &config)?;
    require_not_paused(&config)?;
    let mut receipt: StakeReceipt = decode(&receipt_info.try_borrow_data()?)?;
    validate_receipt(&receipt, config_info.key, staker.key)?;
    validate_receipt_address(program_id, receipt_info.key, &receipt)?;
    receipt.claim(clock.unix_timestamp)?;
    encode(&receipt, &mut receipt_info.try_borrow_mut_data()?)?;
    msg!(
        "NEAL_ACCESS_CLAIMED {} {} {}",
        receipt_info.key,
        staker.key,
        receipt.claimed_at
    );
    Ok(())
}

fn unstake(program_id: &Pubkey, accounts: &[AccountInfo], token_decimals: u8) -> ProgramResult {
    let iter = &mut accounts.iter();
    let staker = next_account_info(iter)?;
    let config_info = next_account_info(iter)?;
    let receipt_info = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let clock_info = next_account_info(iter)?;

    require_signer(staker)?;
    require_owner(config_info, program_id)?;
    require_owner(receipt_info, program_id)?;
    let clock = Clock::from_account_info(clock_info)?;
    let config: AccessConfig = decode(&config_info.try_borrow_data()?)?;
    validate_config(&config)?;
    validate_config_address(program_id, config_info.key, &config)?;
    require_key(mint, &config.mint)?;
    require_key(token_program, &config.token_program)?;
    validate_token_program(token_program)?;
    validate_mint(mint, token_program, Some(token_decimals))?;
    let mut receipt: StakeReceipt = decode(&receipt_info.try_borrow_data()?)?;
    validate_receipt(&receipt, config_info.key, staker.key)?;
    validate_receipt_address(program_id, receipt_info.key, &receipt)?;
    require_key(vault, &receipt.vault)?;

    let vault_amount =
        validate_token_account(vault, token_program, mint.key, Some(receipt_info.key))?;
    if vault_amount < receipt.amount {
        return Err(AccessStakeError::InvalidAmount.into());
    }
    let destination_before =
        validate_token_account(destination, token_program, mint.key, Some(staker.key))?;
    receipt.release(clock.unix_timestamp)?;

    let bump = [receipt.bump];
    let signer_seeds = [
        STAKE_SEED,
        config_info.key.as_ref(),
        staker.key.as_ref(),
        bump.as_ref(),
    ];
    transfer_checked(
        token_program,
        vault,
        mint,
        destination,
        receipt_info,
        vault_amount,
        token_decimals,
        Some(&signer_seeds),
    )?;
    if validate_token_account(vault, token_program, mint.key, Some(receipt_info.key))? != 0 {
        return Err(AccessStakeError::InvalidAmount.into());
    }
    let expected_destination = destination_before
        .checked_add(vault_amount)
        .ok_or(AccessStakeError::ArithmeticOverflow)?;
    if validate_token_account(destination, token_program, mint.key, Some(staker.key))?
        != expected_destination
    {
        return Err(AccessStakeError::InvalidAmount.into());
    }

    encode(&receipt, &mut receipt_info.try_borrow_mut_data()?)?;
    msg!(
        "NEAL_ACCESS_UNSTAKED {} {} {}",
        receipt_info.key,
        staker.key,
        vault_amount
    );
    Ok(())
}

fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system_program_info: &AccountInfo<'a>,
    owner: &Pubkey,
    space: usize,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    if !account.data_is_empty() || account.owner != &system_program::id() {
        return Err(AccessStakeError::InvalidState.into());
    }
    let required_lamports = Rent::get()?.minimum_balance(space);
    let top_up = required_lamports.saturating_sub(account.lamports());
    if top_up > 0 {
        invoke(
            &system_instruction::transfer(payer.key, account.key, top_up),
            &[payer.clone(), account.clone(), system_program_info.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(account.key, space as u64),
        &[account.clone(), system_program_info.clone()],
        &[signer_seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(account.key, owner),
        &[account.clone(), system_program_info.clone()],
        &[signer_seeds],
    )
}

#[allow(clippy::too_many_arguments)]
fn transfer_checked<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    signer_seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    let mut data = Vec::with_capacity(10);
    data.push(12); // Token-2022 TransferChecked discriminator.
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let instruction = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    let account_infos = [
        source.clone(),
        mint.clone(),
        destination.clone(),
        authority.clone(),
        token_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&instruction, &account_infos, &[seeds]),
        None => invoke(&instruction, &account_infos),
    }
}

fn validate_token_program(account: &AccountInfo) -> ProgramResult {
    if *account.key != TOKEN_2022_PROGRAM_ID || !account.executable {
        return Err(AccessStakeError::InvalidTokenAccount.into());
    }
    Ok(())
}

fn validate_mint(
    mint: &AccountInfo,
    token_program: &AccountInfo,
    expected_decimals: Option<u8>,
) -> ProgramResult {
    require_owner(mint, token_program.key)?;
    let data = mint.try_borrow_data()?;
    if data.len() < 82 || data[45] != 1 || data[0..4] != [0; 4] || data[46..50] != [0; 4] {
        return Err(AccessStakeError::InvalidMint.into());
    }
    if expected_decimals.is_some_and(|decimals| decimals != data[44]) {
        return Err(AccessStakeError::InvalidMint.into());
    }
    Ok(())
}

fn validate_token_account(
    account: &AccountInfo,
    token_program: &AccountInfo,
    expected_mint: &Pubkey,
    expected_authority: Option<&Pubkey>,
) -> Result<u64, ProgramError> {
    require_owner(account, token_program.key)?;
    let data = account.try_borrow_data()?;
    if data.len() < 165 || data[108] == 0 {
        return Err(AccessStakeError::InvalidTokenAccount.into());
    }
    if &data[0..32] != expected_mint.as_ref()
        || expected_authority.is_some_and(|authority| &data[32..64] != authority.as_ref())
    {
        return Err(AccessStakeError::InvalidTokenAccount.into());
    }
    let amount = u64::from_le_bytes(
        data[64..72]
            .try_into()
            .map_err(|_| AccessStakeError::InvalidTokenAccount)?,
    );
    Ok(amount)
}

fn validate_config(config: &AccessConfig) -> ProgramResult {
    if config.discriminator != CONFIG_DISCRIMINATOR
        || config.version != 1
        || config.token_program != TOKEN_2022_PROGRAM_ID
    {
        return Err(AccessStakeError::InvalidState.into());
    }
    AccessConfig::validate_terms(config.required_amount, config.minimum_lock_seconds)
}

fn validate_config_address(
    program_id: &Pubkey,
    address: &Pubkey,
    config: &AccessConfig,
) -> ProgramResult {
    let config_id = config.config_id.to_le_bytes();
    let expected = Pubkey::create_program_address(
        &[
            CONFIG_SEED,
            config.authority.as_ref(),
            &config_id,
            &[config.bump],
        ],
        program_id,
    )
    .map_err(|_| AccessStakeError::InvalidPda)?;
    require_key_raw(address, &expected)
}

fn validate_receipt(receipt: &StakeReceipt, config: &Pubkey, staker: &Pubkey) -> ProgramResult {
    if receipt.discriminator != STAKE_DISCRIMINATOR
        || receipt.version != 1
        || receipt.config != *config
        || receipt.staker != *staker
    {
        return Err(AccessStakeError::InvalidState.into());
    }
    Ok(())
}

fn validate_receipt_address(
    program_id: &Pubkey,
    address: &Pubkey,
    receipt: &StakeReceipt,
) -> ProgramResult {
    let expected = Pubkey::create_program_address(
        &[
            STAKE_SEED,
            receipt.config.as_ref(),
            receipt.staker.as_ref(),
            &[receipt.bump],
        ],
        program_id,
    )
    .map_err(|_| AccessStakeError::InvalidPda)?;
    require_key_raw(address, &expected)
}

fn require_not_paused(config: &AccessConfig) -> ProgramResult {
    if config.paused {
        return Err(AccessStakeError::ConfigPaused.into());
    }
    Ok(())
}

fn require_signer(account: &AccountInfo) -> ProgramResult {
    if !account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

fn require_owner(account: &AccountInfo, owner: &Pubkey) -> ProgramResult {
    if account.owner != owner {
        return Err(AccessStakeError::InvalidOwner.into());
    }
    Ok(())
}

fn require_key(account: &AccountInfo, expected: &Pubkey) -> ProgramResult {
    require_key_raw(account.key, expected)
}

fn require_key_raw(actual: &Pubkey, expected: &Pubkey) -> ProgramResult {
    if actual != expected {
        return Err(AccessStakeError::InvalidPda.into());
    }
    Ok(())
}
