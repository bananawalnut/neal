use borsh::BorshDeserialize;
use neal_bounty_factory::{
    client,
    error::BountyError,
    processor,
    state::{Bounty, BountyStatus, Factory, Proof, ProofStatus},
};
use solana_program::{
    clock::Clock, instruction::InstructionError, program_pack::Pack, pubkey::Pubkey, rent::Rent,
};
use solana_program_test::{BanksClientError, ProgramTest, ProgramTestContext, processor};
use solana_sdk::{
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};
use solana_system_interface::instruction as system_instruction;
use spl_token::{
    instruction as token_instruction,
    state::{Account as TokenAccount, Mint},
};

const DECIMALS: u8 = 6;
const CREATION_FEE: u64 = 100;
const REWARD: u64 = 1_000;

struct Harness {
    context: ProgramTestContext,
    program_id: Pubkey,
    mint: Pubkey,
    factory: Pubkey,
    creator_source: Pubkey,
    fee_account: Pubkey,
}

async fn process(
    context: &mut ProgramTestContext,
    instructions: &[solana_program::instruction::Instruction],
    additional_signers: &[&Keypair],
) -> Result<(), BanksClientError> {
    let mut signers: Vec<&dyn Signer> = vec![&context.payer];
    signers.extend(
        additional_signers
            .iter()
            .map(|signer| *signer as &dyn Signer),
    );
    let transaction = Transaction::new_signed_with_payer(
        instructions,
        Some(&context.payer.pubkey()),
        &signers,
        context.last_blockhash,
    );
    let result = context.banks_client.process_transaction(transaction).await;
    context.last_blockhash = context.get_new_latest_blockhash().await.unwrap();
    result
}

async fn send(
    context: &mut ProgramTestContext,
    instructions: &[solana_program::instruction::Instruction],
    additional_signers: &[&Keypair],
    should_succeed: bool,
) {
    let result = process(context, instructions, additional_signers).await;
    assert_eq!(
        result.is_ok(),
        should_succeed,
        "transaction result: {result:?}"
    );
}

async fn send_expect_error(
    context: &mut ProgramTestContext,
    instructions: &[solana_program::instruction::Instruction],
    additional_signers: &[&Keypair],
    expected: InstructionError,
) {
    let error = process(context, instructions, additional_signers)
        .await
        .expect_err("transaction unexpectedly succeeded")
        .unwrap();
    assert_eq!(error, TransactionError::InstructionError(0, expected));
}

async fn send_expect_bounty_error(
    context: &mut ProgramTestContext,
    instructions: &[solana_program::instruction::Instruction],
    additional_signers: &[&Keypair],
    expected: BountyError,
) {
    send_expect_error(
        context,
        instructions,
        additional_signers,
        InstructionError::Custom(expected as u32),
    )
    .await;
}

async fn create_token_account(
    context: &mut ProgramTestContext,
    mint: &Pubkey,
    authority: &Pubkey,
) -> Keypair {
    let account = Keypair::new();
    let rent = Rent::default().minimum_balance(TokenAccount::LEN);
    let instructions = [
        system_instruction::create_account(
            &context.payer.pubkey(),
            &account.pubkey(),
            rent,
            TokenAccount::LEN as u64,
            &spl_token::id(),
        ),
        token_instruction::initialize_account3(
            &spl_token::id(),
            &account.pubkey(),
            mint,
            authority,
        )
        .unwrap(),
    ];
    send(context, &instructions, &[&account], true).await;
    account
}

async fn token_balance(context: &mut ProgramTestContext, address: Pubkey) -> u64 {
    let account = context
        .banks_client
        .get_account(address)
        .await
        .unwrap()
        .unwrap();
    TokenAccount::unpack(&account.data).unwrap().amount
}

async fn account_state<T: BorshDeserialize>(
    context: &mut ProgramTestContext,
    address: Pubkey,
) -> T {
    let account = context
        .banks_client
        .get_account(address)
        .await
        .unwrap()
        .unwrap();
    T::try_from_slice(&account.data).unwrap()
}

async fn setup(source_amount: u64) -> Harness {
    let program_id = Pubkey::new_unique();
    let mut program_test = ProgramTest::new(
        "neal_bounty_factory",
        program_id,
        processor!(processor::process_instruction),
    );
    // Always execute the official SPL Token processor natively, even when the
    // bounty program itself is loaded from an SBF artifact via SBF_OUT_DIR.
    program_test.prefer_bpf(false);
    program_test.add_program(
        "spl_token",
        spl_token::id(),
        processor!(spl_token::processor::Processor::process),
    );
    let mut context = program_test.start_with_context().await;

    let mint = Keypair::new();
    let mint_rent = Rent::default().minimum_balance(Mint::LEN);
    let mint_instructions = [
        system_instruction::create_account(
            &context.payer.pubkey(),
            &mint.pubkey(),
            mint_rent,
            Mint::LEN as u64,
            &spl_token::id(),
        ),
        token_instruction::initialize_mint2(
            &spl_token::id(),
            &mint.pubkey(),
            &context.payer.pubkey(),
            None,
            DECIMALS,
        )
        .unwrap(),
    ];
    send(&mut context, &mint_instructions, &[&mint], true).await;

    let payer = context.payer.pubkey();
    let creator_source = create_token_account(&mut context, &mint.pubkey(), &payer).await;
    let fee_account = create_token_account(&mut context, &mint.pubkey(), &payer).await;
    let mint_to = token_instruction::mint_to(
        &spl_token::id(),
        &mint.pubkey(),
        &creator_source.pubkey(),
        &context.payer.pubkey(),
        &[],
        source_amount,
    )
    .unwrap();
    send(&mut context, &[mint_to], &[], true).await;

    let (factory, _) = client::factory_address(&program_id, &context.payer.pubkey(), 0);
    let initialize = client::initialize_factory(
        program_id,
        context.payer.pubkey(),
        context.payer.pubkey(),
        0,
        mint.pubkey(),
        fee_account.pubkey(),
        CREATION_FEE,
    )
    .unwrap();
    send(&mut context, &[initialize], &[], true).await;

    Harness {
        context,
        program_id,
        mint: mint.pubkey(),
        factory,
        creator_source: creator_source.pubkey(),
        fee_account: fee_account.pubkey(),
    }
}

async fn create_bounty(
    harness: &mut Harness,
    bounty_number: u64,
    reviewer: Pubkey,
    expires_at: i64,
) -> (Pubkey, Pubkey) {
    let (bounty, _) = client::bounty_address(&harness.program_id, &harness.factory, bounty_number);
    let vault = create_token_account(&mut harness.context, &harness.mint, &bounty).await;
    let instruction = client::create_bounty(
        harness.program_id,
        harness.context.payer.pubkey(),
        reviewer,
        harness.factory,
        bounty_number,
        harness.creator_source,
        vault.pubkey(),
        harness.fee_account,
        harness.mint,
        REWARD,
        expires_at,
        DECIMALS,
        [42; 32],
    )
    .unwrap();
    send(&mut harness.context, &[instruction], &[], true).await;
    (bounty, vault.pubkey())
}

#[tokio::test]
async fn validator_executes_fee_escrow_proof_and_full_reward_lifecycle() {
    let mut harness = setup(10_000).await;
    let reviewer = Keypair::new();
    let submitter = Keypair::new();
    let intruder = Keypair::new();
    let current_clock: Clock = harness.context.banks_client.get_sysvar().await.unwrap();
    let expires_at = current_clock.unix_timestamp + 60;
    let (bounty, _) = client::bounty_address(&harness.program_id, &harness.factory, 0);
    let vault = create_token_account(&mut harness.context, &harness.mint, &bounty).await;

    let pause = client::set_paused(
        harness.program_id,
        harness.context.payer.pubkey(),
        harness.factory,
        true,
    )
    .unwrap();
    send(&mut harness.context, &[pause], &[], true).await;
    let create_while_paused = client::create_bounty(
        harness.program_id,
        harness.context.payer.pubkey(),
        reviewer.pubkey(),
        harness.factory,
        0,
        harness.creator_source,
        vault.pubkey(),
        harness.fee_account,
        harness.mint,
        REWARD,
        expires_at,
        DECIMALS,
        [42; 32],
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[create_while_paused],
        &[],
        BountyError::FactoryPaused,
    )
    .await;
    assert_eq!(token_balance(&mut harness.context, vault.pubkey()).await, 0);
    assert_eq!(
        token_balance(&mut harness.context, harness.fee_account).await,
        0
    );

    let unpause = client::set_paused(
        harness.program_id,
        harness.context.payer.pubkey(),
        harness.factory,
        false,
    )
    .unwrap();
    send(&mut harness.context, &[unpause], &[], true).await;
    let wrong_decimals = client::create_bounty(
        harness.program_id,
        harness.context.payer.pubkey(),
        reviewer.pubkey(),
        harness.factory,
        0,
        harness.creator_source,
        vault.pubkey(),
        harness.fee_account,
        harness.mint,
        REWARD,
        expires_at,
        DECIMALS + 1,
        [42; 32],
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[wrong_decimals],
        &[],
        BountyError::InvalidMint,
    )
    .await;
    assert_eq!(token_balance(&mut harness.context, vault.pubkey()).await, 0);
    assert_eq!(
        token_balance(&mut harness.context, harness.fee_account).await,
        0
    );
    let create = client::create_bounty(
        harness.program_id,
        harness.context.payer.pubkey(),
        reviewer.pubkey(),
        harness.factory,
        0,
        harness.creator_source,
        vault.pubkey(),
        harness.fee_account,
        harness.mint,
        REWARD,
        expires_at,
        DECIMALS,
        [42; 32],
    )
    .unwrap();
    send(
        &mut harness.context,
        std::slice::from_ref(&create),
        &[],
        true,
    )
    .await;

    assert_eq!(
        token_balance(&mut harness.context, vault.pubkey()).await,
        REWARD
    );
    assert_eq!(
        token_balance(&mut harness.context, harness.fee_account).await,
        CREATION_FEE
    );
    assert_eq!(
        token_balance(&mut harness.context, harness.creator_source).await,
        10_000 - REWARD - CREATION_FEE
    );
    let factory_state: Factory = account_state(&mut harness.context, harness.factory).await;
    assert_eq!(factory_state.bounty_count, 1);
    let bounty_state: Bounty = account_state(&mut harness.context, bounty).await;
    assert_eq!(bounty_state.status, BountyStatus::Open);
    assert_eq!(bounty_state.creation_fee_amount, CREATION_FEE);
    send_expect_bounty_error(
        &mut harness.context,
        &[create],
        &[],
        BountyError::InvalidPda,
    )
    .await;
    assert_eq!(
        token_balance(&mut harness.context, harness.fee_account).await,
        CREATION_FEE
    );

    let fund_submitter = system_instruction::transfer(
        &harness.context.payer.pubkey(),
        &submitter.pubkey(),
        5_000_000,
    );
    send(&mut harness.context, &[fund_submitter], &[], true).await;
    let recipient =
        create_token_account(&mut harness.context, &harness.mint, &submitter.pubkey()).await;
    let (proof, _) = client::proof_address(&harness.program_id, &bounty, 0);
    let submit = client::submit_proof(
        harness.program_id,
        submitter.pubkey(),
        harness.factory,
        bounty,
        0,
        [51; 32],
        [52; 32],
    )
    .unwrap();
    send(&mut harness.context, &[submit], &[&submitter], true).await;
    let proof_state: Proof = account_state(&mut harness.context, proof).await;
    assert_eq!(proof_state.status, ProofStatus::Submitted);

    let unauthorized = client::complete_proof(
        harness.program_id,
        intruder.pubkey(),
        harness.factory,
        bounty,
        proof,
        vault.pubkey(),
        recipient.pubkey(),
        harness.mint,
        DECIMALS,
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[unauthorized],
        &[&intruder],
        BountyError::InvalidAuthority,
    )
    .await;
    assert_eq!(
        token_balance(&mut harness.context, vault.pubkey()).await,
        REWARD
    );
    assert_eq!(
        token_balance(&mut harness.context, recipient.pubkey()).await,
        0
    );

    let wrong_recipient =
        create_token_account(&mut harness.context, &harness.mint, &intruder.pubkey()).await;
    let wrong_destination = client::complete_proof(
        harness.program_id,
        reviewer.pubkey(),
        harness.factory,
        bounty,
        proof,
        vault.pubkey(),
        wrong_recipient.pubkey(),
        harness.mint,
        DECIMALS,
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[wrong_destination],
        &[&reviewer],
        BountyError::InvalidTokenAccount,
    )
    .await;

    let pause = client::set_paused(
        harness.program_id,
        harness.context.payer.pubkey(),
        harness.factory,
        true,
    )
    .unwrap();
    send(&mut harness.context, &[pause], &[], true).await;
    let complete_while_paused = client::complete_proof(
        harness.program_id,
        reviewer.pubkey(),
        harness.factory,
        bounty,
        proof,
        vault.pubkey(),
        recipient.pubkey(),
        harness.mint,
        DECIMALS,
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[complete_while_paused],
        &[&reviewer],
        BountyError::FactoryPaused,
    )
    .await;
    let unpause = client::set_paused(
        harness.program_id,
        harness.context.payer.pubkey(),
        harness.factory,
        false,
    )
    .unwrap();
    send(&mut harness.context, &[unpause], &[], true).await;

    let complete = client::complete_proof(
        harness.program_id,
        reviewer.pubkey(),
        harness.factory,
        bounty,
        proof,
        vault.pubkey(),
        recipient.pubkey(),
        harness.mint,
        DECIMALS,
    )
    .unwrap();
    send(
        &mut harness.context,
        std::slice::from_ref(&complete),
        &[&reviewer],
        true,
    )
    .await;
    assert_eq!(token_balance(&mut harness.context, vault.pubkey()).await, 0);
    assert_eq!(
        token_balance(&mut harness.context, recipient.pubkey()).await,
        REWARD
    );
    assert_eq!(
        token_balance(&mut harness.context, harness.fee_account).await,
        CREATION_FEE
    );
    let bounty_state: Bounty = account_state(&mut harness.context, bounty).await;
    let proof_state: Proof = account_state(&mut harness.context, proof).await;
    assert_eq!(bounty_state.status, BountyStatus::Completed);
    assert_eq!(bounty_state.winning_proof, proof);
    assert_eq!(proof_state.status, ProofStatus::Completed);

    send_expect_bounty_error(
        &mut harness.context,
        &[complete],
        &[&reviewer],
        BountyError::InvalidState,
    )
    .await;
    assert_eq!(
        token_balance(&mut harness.context, recipient.pubkey()).await,
        REWARD
    );

    let fresh_clock: Clock = harness.context.banks_client.get_sysvar().await.unwrap();
    let second_expiry = fresh_clock.unix_timestamp + 5;
    let (second_bounty, second_vault) =
        create_bounty(&mut harness, 1, reviewer.pubkey(), second_expiry).await;
    let creator = harness.context.payer.pubkey();
    let refund = create_token_account(&mut harness.context, &harness.mint, &creator).await;
    let early_cancel = client::cancel_bounty(
        harness.program_id,
        harness.context.payer.pubkey(),
        harness.factory,
        second_bounty,
        second_vault,
        refund.pubkey(),
        harness.mint,
        DECIMALS,
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[early_cancel],
        &[],
        BountyError::BountyNotExpired,
    )
    .await;

    let (second_proof, _) = client::proof_address(&harness.program_id, &second_bounty, 0);
    let second_submit = client::submit_proof(
        harness.program_id,
        submitter.pubkey(),
        harness.factory,
        second_bounty,
        0,
        [71; 32],
        [72; 32],
    )
    .unwrap();
    send(&mut harness.context, &[second_submit], &[&submitter], true).await;

    let mut boundary_clock: Clock = harness.context.banks_client.get_sysvar().await.unwrap();
    boundary_clock.unix_timestamp = second_expiry;
    harness.context.set_sysvar(&boundary_clock);
    let boundary_cancel = client::cancel_bounty(
        harness.program_id,
        harness.context.payer.pubkey(),
        harness.factory,
        second_bounty,
        second_vault,
        refund.pubkey(),
        harness.mint,
        DECIMALS,
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[boundary_cancel],
        &[],
        BountyError::BountyNotExpired,
    )
    .await;

    let mut expired_clock: Clock = harness.context.banks_client.get_sysvar().await.unwrap();
    expired_clock.unix_timestamp = second_expiry + 1;
    harness.context.set_sysvar(&expired_clock);
    let expired_complete = client::complete_proof(
        harness.program_id,
        reviewer.pubkey(),
        harness.factory,
        second_bounty,
        second_proof,
        second_vault,
        recipient.pubkey(),
        harness.mint,
        DECIMALS,
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[expired_complete],
        &[&reviewer],
        BountyError::BountyExpired,
    )
    .await;

    let unauthorized_cancel = client::cancel_bounty(
        harness.program_id,
        intruder.pubkey(),
        harness.factory,
        second_bounty,
        second_vault,
        refund.pubkey(),
        harness.mint,
        DECIMALS,
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[unauthorized_cancel],
        &[&intruder],
        BountyError::InvalidAuthority,
    )
    .await;

    let pause = client::set_paused(
        harness.program_id,
        harness.context.payer.pubkey(),
        harness.factory,
        true,
    )
    .unwrap();
    send(&mut harness.context, &[pause], &[], true).await;
    let cancel_while_paused = client::cancel_bounty(
        harness.program_id,
        harness.context.payer.pubkey(),
        harness.factory,
        second_bounty,
        second_vault,
        refund.pubkey(),
        harness.mint,
        DECIMALS,
    )
    .unwrap();
    send(&mut harness.context, &[cancel_while_paused], &[], true).await;
    assert_eq!(
        token_balance(&mut harness.context, refund.pubkey()).await,
        REWARD
    );
    assert_eq!(
        token_balance(&mut harness.context, harness.fee_account).await,
        CREATION_FEE * 2
    );
    let second_state: Bounty = account_state(&mut harness.context, second_bounty).await;
    assert_eq!(second_state.status, BountyStatus::Cancelled);
}

#[tokio::test]
async fn validator_rolls_back_escrow_when_fixed_fee_cannot_be_paid() {
    let mut harness = setup(REWARD + CREATION_FEE - 1).await;
    let reviewer = Pubkey::new_unique();
    let clock: Clock = harness.context.banks_client.get_sysvar().await.unwrap();

    let wrong_fee_owner = Pubkey::new_unique();
    let wrong_fee_account =
        create_token_account(&mut harness.context, &harness.mint, &wrong_fee_owner).await;
    let (invalid_factory, _) =
        client::factory_address(&harness.program_id, &harness.context.payer.pubkey(), 1);
    let invalid_initialize = client::initialize_factory(
        harness.program_id,
        harness.context.payer.pubkey(),
        harness.context.payer.pubkey(),
        1,
        harness.mint,
        wrong_fee_account.pubkey(),
        CREATION_FEE,
    )
    .unwrap();
    send_expect_bounty_error(
        &mut harness.context,
        &[invalid_initialize],
        &[],
        BountyError::InvalidTokenAccount,
    )
    .await;
    assert!(
        harness
            .context
            .banks_client
            .get_account(invalid_factory)
            .await
            .unwrap()
            .is_none()
    );

    let (bounty, _) = client::bounty_address(&harness.program_id, &harness.factory, 0);
    let vault = create_token_account(&mut harness.context, &harness.mint, &bounty).await;
    let create = client::create_bounty(
        harness.program_id,
        harness.context.payer.pubkey(),
        reviewer,
        harness.factory,
        0,
        harness.creator_source,
        vault.pubkey(),
        harness.fee_account,
        harness.mint,
        REWARD,
        clock.unix_timestamp + 60,
        DECIMALS,
        [61; 32],
    )
    .unwrap();
    send_expect_error(
        &mut harness.context,
        &[create],
        &[],
        InstructionError::Custom(spl_token::error::TokenError::InsufficientFunds as u32),
    )
    .await;

    assert_eq!(
        token_balance(&mut harness.context, harness.creator_source).await,
        REWARD + CREATION_FEE - 1
    );
    assert_eq!(token_balance(&mut harness.context, vault.pubkey()).await, 0);
    assert_eq!(
        token_balance(&mut harness.context, harness.fee_account).await,
        0
    );
    assert!(
        harness
            .context
            .banks_client
            .get_account(bounty)
            .await
            .unwrap()
            .is_none()
    );
    let factory: Factory = account_state(&mut harness.context, harness.factory).await;
    assert_eq!(factory.bounty_count, 0);
}
