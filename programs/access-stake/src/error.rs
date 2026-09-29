use solana_program::program_error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccessStakeError {
    InvalidInstruction = 0,
    InvalidPda,
    InvalidOwner,
    InvalidState,
    InvalidAuthority,
    ConfigPaused,
    InvalidAmount,
    InvalidLockDuration,
    StakeLocked,
    AlreadyClaimed,
    InvalidMint,
    InvalidTokenAccount,
    ArithmeticOverflow,
}

impl From<AccessStakeError> for ProgramError {
    fn from(value: AccessStakeError) -> Self {
        ProgramError::Custom(value as u32)
    }
}
