use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub enum AccessStakeInstruction {
    InitializeConfig {
        config_id: u64,
        issuer_authority: Pubkey,
        required_amount: u64,
        minimum_lock_seconds: i64,
    },
    SetPaused {
        paused: bool,
    },
    SetIssuerAuthority {
        issuer_authority: Pubkey,
    },
    Stake {
        token_decimals: u8,
        expected_required_amount: u64,
        expected_minimum_lock_seconds: i64,
        expected_revision: u64,
    },
    ClaimAccess,
    ConsumeClaim,
    Unstake {
        token_decimals: u8,
    },
}
