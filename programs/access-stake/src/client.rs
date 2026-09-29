use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    sysvar,
};
use solana_sdk_ids::system_program;

use crate::{
    error::AccessStakeError,
    instruction::AccessStakeInstruction,
    state::{CONFIG_SEED, STAKE_SEED},
};

pub const TOKEN_2022_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);

pub fn config_address(program_id: &Pubkey, authority: &Pubkey, config_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[CONFIG_SEED, authority.as_ref(), &config_id.to_le_bytes()],
        program_id,
    )
}

pub fn stake_address(program_id: &Pubkey, config: &Pubkey, staker: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[STAKE_SEED, config.as_ref(), staker.as_ref()], program_id)
}

fn build(
    program_id: Pubkey,
    accounts: Vec<AccountMeta>,
    instruction: AccessStakeInstruction,
) -> Result<Instruction, AccessStakeError> {
    Ok(Instruction {
        program_id,
        accounts,
        data: borsh::to_vec(&instruction).map_err(|_| AccessStakeError::InvalidInstruction)?,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn initialize_config(
    program_id: Pubkey,
    payer: Pubkey,
    authority: Pubkey,
    config_id: u64,
    mint: Pubkey,
    required_amount: u64,
    minimum_lock_seconds: i64,
) -> Result<Instruction, AccessStakeError> {
    let (config, _) = config_address(&program_id, &authority, config_id);
    build(
        program_id,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        AccessStakeInstruction::InitializeConfig {
            config_id,
            required_amount,
            minimum_lock_seconds,
        },
    )
}

pub fn update_config(
    program_id: Pubkey,
    authority: Pubkey,
    config: Pubkey,
    required_amount: Option<u64>,
    minimum_lock_seconds: Option<i64>,
    paused: Option<bool>,
) -> Result<Instruction, AccessStakeError> {
    build(
        program_id,
        vec![
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(config, false),
        ],
        AccessStakeInstruction::UpdateConfig {
            required_amount,
            minimum_lock_seconds,
            paused,
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn stake(
    program_id: Pubkey,
    staker: Pubkey,
    config: Pubkey,
    source: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    token_decimals: u8,
) -> Result<Instruction, AccessStakeError> {
    let (receipt, _) = stake_address(&program_id, &config, &staker);
    build(
        program_id,
        vec![
            AccountMeta::new(staker, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(receipt, false),
            AccountMeta::new(source, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(sysvar::clock::id(), false),
        ],
        AccessStakeInstruction::Stake { token_decimals },
    )
}

pub fn claim_access(
    program_id: Pubkey,
    staker: Pubkey,
    config: Pubkey,
) -> Result<Instruction, AccessStakeError> {
    let (receipt, _) = stake_address(&program_id, &config, &staker);
    build(
        program_id,
        vec![
            AccountMeta::new_readonly(staker, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(receipt, false),
            AccountMeta::new_readonly(sysvar::clock::id(), false),
        ],
        AccessStakeInstruction::ClaimAccess,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn unstake(
    program_id: Pubkey,
    staker: Pubkey,
    config: Pubkey,
    vault: Pubkey,
    destination: Pubkey,
    mint: Pubkey,
    token_decimals: u8,
) -> Result<Instruction, AccessStakeError> {
    let (receipt, _) = stake_address(&program_id, &config, &staker);
    build(
        program_id,
        vec![
            AccountMeta::new_readonly(staker, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(receipt, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
            AccountMeta::new_readonly(sysvar::clock::id(), false),
        ],
        AccessStakeInstruction::Unstake { token_decimals },
    )
}
