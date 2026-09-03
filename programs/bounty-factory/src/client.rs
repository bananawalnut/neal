use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    sysvar,
};
use solana_sdk_ids::system_program;

use crate::{
    error::BountyError,
    instruction::BountyInstruction,
    state::{BOUNTY_SEED, FACTORY_SEED, PROOF_SEED},
};

pub const SPL_TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);

pub fn factory_address(program_id: &Pubkey, authority: &Pubkey, factory_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[FACTORY_SEED, authority.as_ref(), &factory_id.to_le_bytes()],
        program_id,
    )
}

pub fn bounty_address(program_id: &Pubkey, factory: &Pubkey, bounty_number: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[BOUNTY_SEED, factory.as_ref(), &bounty_number.to_le_bytes()],
        program_id,
    )
}

pub fn proof_address(program_id: &Pubkey, bounty: &Pubkey, proof_number: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[PROOF_SEED, bounty.as_ref(), &proof_number.to_le_bytes()],
        program_id,
    )
}

fn build(
    program_id: Pubkey,
    accounts: Vec<AccountMeta>,
    instruction: BountyInstruction,
) -> Result<Instruction, BountyError> {
    Ok(Instruction {
        program_id,
        accounts,
        data: borsh::to_vec(&instruction).map_err(|_| BountyError::InvalidInstruction)?,
    })
}

pub fn initialize_factory(
    program_id: Pubkey,
    payer: Pubkey,
    authority: Pubkey,
    factory_id: u64,
    reward_mint: Pubkey,
    fee_recipient: Pubkey,
    creation_fee_amount: u64,
) -> Result<Instruction, BountyError> {
    let (factory, _) = factory_address(&program_id, &authority, factory_id);
    build(
        program_id,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(factory, false),
            AccountMeta::new_readonly(reward_mint, false),
            AccountMeta::new_readonly(fee_recipient, false),
            AccountMeta::new_readonly(SPL_TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        BountyInstruction::InitializeFactory {
            factory_id,
            creation_fee_amount,
        },
    )
}

pub fn set_paused(
    program_id: Pubkey,
    authority: Pubkey,
    factory: Pubkey,
    paused: bool,
) -> Result<Instruction, BountyError> {
    build(
        program_id,
        vec![
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(factory, false),
        ],
        BountyInstruction::SetPaused { paused },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn create_bounty(
    program_id: Pubkey,
    creator: Pubkey,
    reviewer: Pubkey,
    factory: Pubkey,
    bounty_number: u64,
    creator_source: Pubkey,
    vault: Pubkey,
    fee_recipient: Pubkey,
    reward_mint: Pubkey,
    reward_amount: u64,
    expires_at: i64,
    token_decimals: u8,
    brief_digest: [u8; 32],
) -> Result<Instruction, BountyError> {
    let (bounty, _) = bounty_address(&program_id, &factory, bounty_number);
    build(
        program_id,
        vec![
            AccountMeta::new(creator, true),
            AccountMeta::new_readonly(reviewer, false),
            AccountMeta::new(factory, false),
            AccountMeta::new(bounty, false),
            AccountMeta::new(creator_source, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fee_recipient, false),
            AccountMeta::new_readonly(reward_mint, false),
            AccountMeta::new_readonly(SPL_TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(sysvar::clock::id(), false),
        ],
        BountyInstruction::CreateBounty {
            reward_amount,
            expires_at,
            token_decimals,
            brief_digest,
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn submit_proof(
    program_id: Pubkey,
    submitter: Pubkey,
    factory: Pubkey,
    bounty: Pubkey,
    proof_number: u64,
    proof_digest: [u8; 32],
    uri_digest: [u8; 32],
) -> Result<Instruction, BountyError> {
    let (proof, _) = proof_address(&program_id, &bounty, proof_number);
    build(
        program_id,
        vec![
            AccountMeta::new(submitter, true),
            AccountMeta::new_readonly(factory, false),
            AccountMeta::new(bounty, false),
            AccountMeta::new(proof, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(sysvar::clock::id(), false),
        ],
        BountyInstruction::SubmitProof {
            proof_digest,
            uri_digest,
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn complete_proof(
    program_id: Pubkey,
    reviewer: Pubkey,
    factory: Pubkey,
    bounty: Pubkey,
    proof: Pubkey,
    vault: Pubkey,
    recipient: Pubkey,
    reward_mint: Pubkey,
    token_decimals: u8,
) -> Result<Instruction, BountyError> {
    build(
        program_id,
        vec![
            AccountMeta::new_readonly(reviewer, true),
            AccountMeta::new_readonly(factory, false),
            AccountMeta::new(bounty, false),
            AccountMeta::new(proof, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(recipient, false),
            AccountMeta::new_readonly(reward_mint, false),
            AccountMeta::new_readonly(SPL_TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(sysvar::clock::id(), false),
        ],
        BountyInstruction::CompleteProof { token_decimals },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn cancel_bounty(
    program_id: Pubkey,
    caller: Pubkey,
    factory: Pubkey,
    bounty: Pubkey,
    vault: Pubkey,
    refund_destination: Pubkey,
    reward_mint: Pubkey,
    token_decimals: u8,
) -> Result<Instruction, BountyError> {
    build(
        program_id,
        vec![
            AccountMeta::new_readonly(caller, true),
            AccountMeta::new_readonly(factory, false),
            AccountMeta::new(bounty, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(refund_destination, false),
            AccountMeta::new_readonly(reward_mint, false),
            AccountMeta::new_readonly(SPL_TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(sysvar::clock::id(), false),
        ],
        BountyInstruction::CancelBounty { token_decimals },
    )
}
