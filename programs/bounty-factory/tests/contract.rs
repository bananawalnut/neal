use borsh::BorshDeserialize;
use neal_bounty_factory::{
    client,
    instruction::BountyInstruction,
    state::{
        BOUNTY_DISCRIMINATOR, BOUNTY_SEED, Bounty, BountyStatus, FACTORY_DISCRIMINATOR, Factory,
        PROOF_DISCRIMINATOR, PROOF_SEED, Proof, ProofStatus,
    },
};
use solana_program::pubkey::Pubkey;

fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

fn open_bounty() -> Bounty {
    Bounty {
        discriminator: BOUNTY_DISCRIMINATOR,
        factory: key(1),
        id: 7,
        creator: key(2),
        reviewer: key(3),
        reward_mint: key(4),
        vault: key(5),
        reward_amount: 1_000_000,
        creation_fee_amount: 25_000,
        expires_at: 2_000,
        proof_count: 1,
        brief_digest: [6; 32],
        status: BountyStatus::Open,
        winning_proof: Pubkey::default(),
        bump: 254,
    }
}

fn submitted_proof(bounty_key: Pubkey) -> Proof {
    Proof {
        discriminator: PROOF_DISCRIMINATOR,
        bounty: bounty_key,
        number: 0,
        submitter: key(8),
        proof_digest: [9; 32],
        uri_digest: [10; 32],
        submitted_at: 1_500,
        completed_at: 0,
        status: ProofStatus::Submitted,
        bump: 253,
    }
}

#[test]
fn account_space_constants_match_wire_encoding() {
    let factory = Factory {
        discriminator: FACTORY_DISCRIMINATOR,
        version: 1,
        authority: key(1),
        reward_mint: key(2),
        token_program: key(3),
        fee_recipient: key(4),
        creation_fee_amount: 25_000,
        paused: false,
        bounty_count: 0,
        bump: 255,
    };
    let bounty = open_bounty();
    let proof = submitted_proof(key(7));

    assert_eq!(borsh::to_vec(&factory).unwrap().len(), Factory::SPACE);
    assert_eq!(borsh::to_vec(&bounty).unwrap().len(), Bounty::SPACE);
    assert_eq!(borsh::to_vec(&proof).unwrap().len(), Proof::SPACE);
}

#[test]
fn creation_fee_is_a_fixed_snapshotted_amount() {
    let mut bounty = open_bounty();
    let mut proof = submitted_proof(key(7));
    assert_eq!(bounty.reward_amount, 1_000_000);
    assert_eq!(bounty.creation_fee_amount, 25_000);
    bounty.complete_with(&mut proof, key(11), 1_700).unwrap();
    assert_eq!(bounty.reward_amount, 1_000_000);
    assert_eq!(bounty.creation_fee_amount, 25_000);
}

#[test]
fn completing_a_proof_is_the_bounty_completion_transition() {
    let bounty_key = key(7);
    let proof_key = key(11);
    let mut bounty = open_bounty();
    let mut proof = submitted_proof(bounty_key);

    bounty.complete_with(&mut proof, proof_key, 1_700).unwrap();

    assert_eq!(proof.status, ProofStatus::Completed);
    assert_eq!(proof.completed_at, 1_700);
    assert_eq!(bounty.status, BountyStatus::Completed);
    assert_eq!(bounty.winning_proof, proof_key);
    assert!(bounty.complete_with(&mut proof, proof_key, 1_701).is_err());
}

#[test]
fn instruction_encoding_is_deterministic_and_round_trips() {
    let instruction = BountyInstruction::SubmitProof {
        proof_digest: [42; 32],
        uri_digest: [99; 32],
    };
    let bytes = borsh::to_vec(&instruction).unwrap();
    assert_eq!(bytes[0], 3);
    assert_eq!(
        BountyInstruction::try_from_slice(&bytes).unwrap(),
        instruction
    );
}

#[test]
fn proof_addresses_are_ordered_append_only_slots() {
    let program_id = key(200);
    let bounty = key(201);
    let zero = 0_u64.to_le_bytes();
    let one = 1_u64.to_le_bytes();
    let (proof_zero, _) =
        Pubkey::find_program_address(&[PROOF_SEED, bounty.as_ref(), &zero], &program_id);
    let (proof_one, _) =
        Pubkey::find_program_address(&[PROOF_SEED, bounty.as_ref(), &one], &program_id);
    assert_ne!(proof_zero, proof_one);

    let (bounty_domain, _) =
        Pubkey::find_program_address(&[BOUNTY_SEED, bounty.as_ref(), &zero], &program_id);
    assert_ne!(proof_zero, bounty_domain);
}

#[test]
fn client_builders_derive_the_expected_bounty_and_proof_accounts() {
    let program_id = key(20);
    let factory = key(21);
    let submitter = key(22);
    let (bounty, _) = client::bounty_address(&program_id, &factory, 4);
    let (proof, _) = client::proof_address(&program_id, &bounty, 2);
    let instruction = client::submit_proof(
        program_id, submitter, factory, bounty, 2, [23; 32], [24; 32],
    )
    .unwrap();

    assert_eq!(
        instruction.accounts[0],
        solana_program::instruction::AccountMeta::new(submitter, true)
    );
    assert_eq!(
        instruction.accounts[3],
        solana_program::instruction::AccountMeta::new(proof, false)
    );
    assert_eq!(
        BountyInstruction::try_from_slice(&instruction.data).unwrap(),
        BountyInstruction::SubmitProof {
            proof_digest: [23; 32],
            uri_digest: [24; 32],
        }
    );
}

#[test]
fn creation_builder_separates_fee_destination_from_escrow_vault() {
    let program_id = key(30);
    let creator = key(31);
    let reviewer = key(32);
    let factory = key(33);
    let source = key(34);
    let vault = key(35);
    let fee_recipient = key(36);
    let mint = key(37);
    let instruction = client::create_bounty(
        program_id,
        creator,
        reviewer,
        factory,
        0,
        source,
        vault,
        fee_recipient,
        mint,
        1_000_000,
        2_000,
        6,
        [38; 32],
    )
    .unwrap();

    assert_eq!(instruction.accounts[5].pubkey, vault);
    assert_eq!(instruction.accounts[6].pubkey, fee_recipient);
    assert_eq!(
        BountyInstruction::try_from_slice(&instruction.data).unwrap(),
        BountyInstruction::CreateBounty {
            reward_amount: 1_000_000,
            expires_at: 2_000,
            token_decimals: 6,
            brief_digest: [38; 32],
        }
    );
}
