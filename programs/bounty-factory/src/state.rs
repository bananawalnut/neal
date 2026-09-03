use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::error::BountyError;

pub const FACTORY_SEED: &[u8] = b"factory";
pub const BOUNTY_SEED: &[u8] = b"bounty";
pub const PROOF_SEED: &[u8] = b"proof";

pub const FACTORY_DISCRIMINATOR: [u8; 8] = *b"NEALFACT";
pub const BOUNTY_DISCRIMINATOR: [u8; 8] = *b"NEALBNTY";
pub const PROOF_DISCRIMINATOR: [u8; 8] = *b"NEALPROF";

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub struct Factory {
    pub discriminator: [u8; 8],
    pub version: u8,
    pub authority: Pubkey,
    pub reward_mint: Pubkey,
    pub token_program: Pubkey,
    pub fee_recipient: Pubkey,
    pub creation_fee_amount: u64,
    pub paused: bool,
    pub bounty_count: u64,
    pub bump: u8,
}

impl Factory {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 32 + 32 + 8 + 1 + 8 + 1;
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum BountyStatus {
    Open,
    Completed,
    Cancelled,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub struct Bounty {
    pub discriminator: [u8; 8],
    pub factory: Pubkey,
    pub id: u64,
    pub creator: Pubkey,
    pub reviewer: Pubkey,
    pub reward_mint: Pubkey,
    pub vault: Pubkey,
    pub reward_amount: u64,
    pub creation_fee_amount: u64,
    pub expires_at: i64,
    pub proof_count: u64,
    pub brief_digest: [u8; 32],
    pub status: BountyStatus,
    pub winning_proof: Pubkey,
    pub bump: u8,
}

impl Bounty {
    pub const SPACE: usize = 8 + 32 + 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 32 + 1 + 32 + 1;

    pub fn complete_with(
        &mut self,
        proof: &mut Proof,
        proof_key: Pubkey,
        completed_at: i64,
    ) -> Result<(), ProgramError> {
        if self.status != BountyStatus::Open || proof.status != ProofStatus::Submitted {
            return Err(BountyError::InvalidState.into());
        }
        if proof.bounty == Pubkey::default() || proof.submitter == Pubkey::default() {
            return Err(BountyError::ProofMismatch.into());
        }
        proof.status = ProofStatus::Completed;
        proof.completed_at = completed_at;
        self.status = BountyStatus::Completed;
        self.winning_proof = proof_key;
        Ok(())
    }
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProofStatus {
    Submitted,
    Completed,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub struct Proof {
    pub discriminator: [u8; 8],
    pub bounty: Pubkey,
    pub number: u64,
    pub submitter: Pubkey,
    pub proof_digest: [u8; 32],
    pub uri_digest: [u8; 32],
    pub submitted_at: i64,
    pub completed_at: i64,
    pub status: ProofStatus,
    pub bump: u8,
}

impl Proof {
    pub const SPACE: usize = 8 + 32 + 8 + 32 + 32 + 32 + 8 + 8 + 1 + 1;
}

pub fn decode<T: BorshDeserialize>(data: &[u8]) -> Result<T, ProgramError> {
    T::try_from_slice(data).map_err(|_| BountyError::InvalidState.into())
}

pub fn encode<T: BorshSerialize>(value: &T, data: &mut [u8]) -> Result<(), ProgramError> {
    let bytes = borsh::to_vec(value).map_err(|_| BountyError::InvalidState)?;
    if bytes.len() != data.len() {
        return Err(BountyError::InvalidState.into());
    }
    data.copy_from_slice(&bytes);
    Ok(())
}
