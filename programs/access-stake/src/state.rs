use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::error::AccessStakeError;

pub const CONFIG_SEED: &[u8] = b"access-config";
pub const STAKE_SEED: &[u8] = b"access-stake";
pub const CONFIG_DISCRIMINATOR: [u8; 8] = *b"NEALACFG";
pub const STAKE_DISCRIMINATOR: [u8; 8] = *b"NEALSTAK";
pub const MAXIMUM_LOCK_SECONDS: i64 = 365 * 24 * 60 * 60;

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub struct AccessConfig {
    pub discriminator: [u8; 8],
    pub version: u8,
    pub authority: Pubkey,
    pub issuer_authority: Pubkey,
    pub config_id: u64,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub revision: u64,
    pub required_amount: u64,
    pub minimum_lock_seconds: i64,
    pub paused: bool,
    pub bump: u8,
}

impl AccessConfig {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1;

    pub fn validate_terms(
        required_amount: u64,
        minimum_lock_seconds: i64,
    ) -> Result<(), ProgramError> {
        if required_amount == 0 {
            return Err(AccessStakeError::InvalidAmount.into());
        }
        if !(1..=MAXIMUM_LOCK_SECONDS).contains(&minimum_lock_seconds) {
            return Err(AccessStakeError::InvalidLockDuration.into());
        }
        Ok(())
    }
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum StakeStatus {
    Active,
    Released,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub struct StakeReceipt {
    pub discriminator: [u8; 8],
    pub version: u8,
    pub config: Pubkey,
    pub staker: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub config_revision: u64,
    pub staked_at: i64,
    pub unlock_at: i64,
    pub claimed_at: i64,
    pub issued_at: i64,
    pub released_at: i64,
    pub status: StakeStatus,
    pub bump: u8,
}

impl StakeReceipt {
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1;

    pub fn claim(&mut self, now: i64) -> Result<(), ProgramError> {
        if self.status != StakeStatus::Active {
            return Err(AccessStakeError::InvalidState.into());
        }
        if self.claimed_at != 0 {
            return Err(AccessStakeError::AlreadyClaimed.into());
        }
        self.claimed_at = now;
        Ok(())
    }

    pub fn release(&mut self, now: i64) -> Result<(), ProgramError> {
        if self.status != StakeStatus::Active {
            return Err(AccessStakeError::InvalidState.into());
        }
        if now < self.unlock_at {
            return Err(AccessStakeError::StakeLocked.into());
        }
        self.status = StakeStatus::Released;
        self.released_at = now;
        Ok(())
    }

    pub fn consume(&mut self, now: i64) -> Result<(), ProgramError> {
        if self.status != StakeStatus::Active || self.claimed_at == 0 {
            return Err(AccessStakeError::InvalidState.into());
        }
        if self.issued_at != 0 {
            return Err(AccessStakeError::AlreadyConsumed.into());
        }
        self.issued_at = now;
        Ok(())
    }
}

pub fn decode<T: BorshDeserialize>(data: &[u8]) -> Result<T, ProgramError> {
    T::try_from_slice(data).map_err(|_| AccessStakeError::InvalidState.into())
}

pub fn encode<T: BorshSerialize>(value: &T, data: &mut [u8]) -> Result<(), ProgramError> {
    let bytes = borsh::to_vec(value).map_err(|_| AccessStakeError::InvalidState)?;
    if bytes.len() != data.len() {
        return Err(AccessStakeError::InvalidState.into());
    }
    data.copy_from_slice(&bytes);
    Ok(())
}
