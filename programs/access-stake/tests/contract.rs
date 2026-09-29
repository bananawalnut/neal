use borsh::BorshDeserialize;
use neal_access_stake::{
    client,
    instruction::AccessStakeInstruction,
    state::{
        AccessConfig, CONFIG_DISCRIMINATOR, MAXIMUM_LOCK_SECONDS, STAKE_DISCRIMINATOR,
        StakeReceipt, StakeStatus,
    },
};
use solana_program::pubkey::Pubkey;

fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

fn config() -> AccessConfig {
    AccessConfig {
        discriminator: CONFIG_DISCRIMINATOR,
        version: 1,
        authority: key(1),
        config_id: 7,
        mint: key(2),
        token_program: client::TOKEN_2022_PROGRAM_ID,
        required_amount: 25_000_000,
        minimum_lock_seconds: 604_800,
        paused: false,
        bump: 254,
    }
}

fn active_receipt() -> StakeReceipt {
    StakeReceipt {
        discriminator: STAKE_DISCRIMINATOR,
        version: 1,
        config: key(3),
        staker: key(4),
        vault: key(5),
        amount: 25_000_000,
        staked_at: 1_000,
        unlock_at: 2_000,
        claimed_at: 0,
        released_at: 0,
        status: StakeStatus::Active,
        bump: 253,
    }
}

#[test]
fn account_space_constants_match_wire_encoding() {
    assert_eq!(borsh::to_vec(&config()).unwrap().len(), AccessConfig::SPACE);
    assert_eq!(
        borsh::to_vec(&active_receipt()).unwrap().len(),
        StakeReceipt::SPACE
    );
}

#[test]
fn config_terms_reject_free_or_unbounded_stakes() {
    assert!(AccessConfig::validate_terms(0, 60).is_err());
    assert!(AccessConfig::validate_terms(1, 0).is_err());
    assert!(AccessConfig::validate_terms(1, MAXIMUM_LOCK_SECONDS + 1).is_err());
    assert!(AccessConfig::validate_terms(1, MAXIMUM_LOCK_SECONDS).is_ok());
}

#[test]
fn access_claim_is_one_time_and_release_waits_for_unlock() {
    let mut receipt = active_receipt();
    assert!(receipt.release(1_999).is_err());
    receipt.claim(1_500).unwrap();
    assert_eq!(receipt.claimed_at, 1_500);
    assert!(receipt.claim(1_501).is_err());
    receipt.release(2_000).unwrap();
    assert_eq!(receipt.status, StakeStatus::Released);
    assert_eq!(receipt.released_at, 2_000);
    assert!(receipt.release(2_001).is_err());
}

#[test]
fn receipt_address_is_unique_per_config_and_wallet() {
    let program_id = key(10);
    let (first, _) = client::stake_address(&program_id, &key(11), &key(12));
    let (other_config, _) = client::stake_address(&program_id, &key(13), &key(12));
    let (other_wallet, _) = client::stake_address(&program_id, &key(11), &key(14));
    assert_ne!(first, other_config);
    assert_ne!(first, other_wallet);
}

#[test]
fn instruction_encoding_is_deterministic_and_round_trips() {
    let instruction = AccessStakeInstruction::UpdateConfig {
        required_amount: Some(50_000_000),
        minimum_lock_seconds: None,
        paused: Some(true),
    };
    let bytes = borsh::to_vec(&instruction).unwrap();
    assert_eq!(bytes[0], 1);
    assert_eq!(
        AccessStakeInstruction::try_from_slice(&bytes).unwrap(),
        instruction
    );
}

#[test]
fn client_builders_pin_token_2022_and_expected_receipt() {
    assert_eq!(
        client::TOKEN_2022_PROGRAM_ID.to_string(),
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    );
    let program_id = key(20);
    let staker = key(21);
    let config = key(22);
    let source = key(23);
    let vault = key(24);
    let mint = key(25);
    let (receipt, _) = client::stake_address(&program_id, &config, &staker);
    let instruction = client::stake(program_id, staker, config, source, vault, mint, 6).unwrap();

    assert_eq!(instruction.accounts[0].pubkey, staker);
    assert_eq!(instruction.accounts[2].pubkey, receipt);
    assert_eq!(
        instruction.accounts[6].pubkey,
        client::TOKEN_2022_PROGRAM_ID
    );
    assert_eq!(
        AccessStakeInstruction::try_from_slice(&instruction.data).unwrap(),
        AccessStakeInstruction::Stake { token_decimals: 6 }
    );
}

#[test]
fn unstake_builder_returns_only_to_the_signing_wallet_destination() {
    let program_id = key(30);
    let staker = key(31);
    let config = key(32);
    let instruction =
        client::unstake(program_id, staker, config, key(33), key(34), key(35), 6).unwrap();
    assert_eq!(instruction.accounts[0].pubkey, staker);
    assert!(instruction.accounts[0].is_signer);
    assert_eq!(
        instruction.accounts[6].pubkey,
        client::TOKEN_2022_PROGRAM_ID
    );
}
