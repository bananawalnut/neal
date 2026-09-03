use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub enum BountyInstruction {
    InitializeFactory {
        factory_id: u64,
        creation_fee_amount: u64,
    },
    SetPaused {
        paused: bool,
    },
    CreateBounty {
        reward_amount: u64,
        expires_at: i64,
        token_decimals: u8,
        brief_digest: [u8; 32],
    },
    SubmitProof {
        proof_digest: [u8; 32],
        uri_digest: [u8; 32],
    },
    CompleteProof {
        token_decimals: u8,
    },
    CancelBounty {
        token_decimals: u8,
    },
}
