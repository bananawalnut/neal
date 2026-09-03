use solana_program::program_error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BountyError {
    InvalidInstruction = 0,
    InvalidPda,
    InvalidOwner,
    InvalidState,
    InvalidAuthority,
    FactoryPaused,
    InvalidAmount,
    InvalidExpiry,
    BountyExpired,
    BountyNotExpired,
    InvalidMint,
    InvalidTokenAccount,
    ArithmeticOverflow,
    ProofMismatch,
}

impl From<BountyError> for ProgramError {
    fn from(value: BountyError) -> Self {
        ProgramError::Custom(value as u32)
    }
}
