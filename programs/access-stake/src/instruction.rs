use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub enum AccessStakeInstruction {
    InitializeConfig {
        config_id: u64,
        required_amount: u64,
        minimum_lock_seconds: i64,
    },
    UpdateConfig {
        required_amount: Option<u64>,
        minimum_lock_seconds: Option<i64>,
        paused: Option<bool>,
    },
    Stake {
        token_decimals: u8,
    },
    ClaimAccess,
    Unstake {
        token_decimals: u8,
    },
}
