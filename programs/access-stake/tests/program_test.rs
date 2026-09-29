use borsh::BorshDeserialize;
use neal_access_stake::{
    client,
    error::AccessStakeError,
    processor,
    state::{StakeReceipt, StakeStatus},
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
use spl_token_2022::{
    instruction::{self as token_instruction, AuthorityType},
    state::{Account as TokenAccount, Mint},
};

const DECIMALS: u8 = 6;
const REQUIRED_AMOUNT: u64 = 25_000_000;
const LOCK_SECONDS: i64 = 60;

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
) {
    process(context, instructions, additional_signers)
        .await
        .unwrap();
}

async fn expect_access_error(
    context: &mut ProgramTestContext,
    instruction: solana_program::instruction::Instruction,
    expected: AccessStakeError,
) {
    let error = process(context, &[instruction], &[])
        .await
        .expect_err("transaction unexpectedly succeeded")
        .unwrap();
    assert_eq!(
        error,
        TransactionError::InstructionError(0, InstructionError::Custom(expected as u32))
    );
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
            &spl_token_2022::id(),
        ),
        token_instruction::initialize_account3(
            &spl_token_2022::id(),
            &account.pubkey(),
            mint,
            authority,
        )
        .unwrap(),
    ];
    send(context, &instructions, &[&account]).await;
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

async fn receipt(context: &mut ProgramTestContext, address: Pubkey) -> StakeReceipt {
    let account = context
        .banks_client
        .get_account(address)
        .await
        .unwrap()
        .unwrap();
    StakeReceipt::try_from_slice(&account.data).unwrap()
}

#[tokio::test]
async fn validator_executes_token_2022_stake_claim_and_refund_lifecycle() {
    let program_id = Pubkey::new_unique();
    let mut program_test = ProgramTest::new(
        "neal_access_stake",
        program_id,
        processor!(processor::process_instruction),
    );
    program_test.prefer_bpf(false);
    program_test.add_program(
        "spl_token_2022",
        spl_token_2022::id(),
        processor!(spl_token_2022::processor::Processor::process),
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
            &spl_token_2022::id(),
        ),
        token_instruction::initialize_mint2(
            &spl_token_2022::id(),
            &mint.pubkey(),
            &context.payer.pubkey(),
            None,
            DECIMALS,
        )
        .unwrap(),
    ];
    send(&mut context, &mint_instructions, &[&mint]).await;

    let authority = context.payer.pubkey();
    let (config, _) = client::config_address(&program_id, &authority, 0);
    let (receipt_address, _) = client::stake_address(&program_id, &config, &authority);
    let source = create_token_account(&mut context, &mint.pubkey(), &authority).await;
    let vault = create_token_account(&mut context, &mint.pubkey(), &receipt_address).await;
    let destination = create_token_account(&mut context, &mint.pubkey(), &authority).await;
    let mint_to = token_instruction::mint_to(
        &spl_token_2022::id(),
        &mint.pubkey(),
        &source.pubkey(),
        &authority,
        &[],
        REQUIRED_AMOUNT,
    )
    .unwrap();
    send(&mut context, &[mint_to], &[]).await;
    let revoke_mint_authority = token_instruction::set_authority(
        &spl_token_2022::id(),
        &mint.pubkey(),
        None,
        AuthorityType::MintTokens,
        &authority,
        &[],
    )
    .unwrap();
    send(&mut context, &[revoke_mint_authority], &[]).await;

    send(
        &mut context,
        &[client::initialize_config(
            program_id,
            authority,
            authority,
            0,
            mint.pubkey(),
            REQUIRED_AMOUNT,
            LOCK_SECONDS,
        )
        .unwrap()],
        &[],
    )
    .await;
    send(
        &mut context,
        &[client::stake(
            program_id,
            authority,
            config,
            source.pubkey(),
            vault.pubkey(),
            mint.pubkey(),
            DECIMALS,
        )
        .unwrap()],
        &[],
    )
    .await;
    assert_eq!(token_balance(&mut context, source.pubkey()).await, 0);
    assert_eq!(
        token_balance(&mut context, vault.pubkey()).await,
        REQUIRED_AMOUNT
    );

    send(
        &mut context,
        &[client::claim_access(program_id, authority, config).unwrap()],
        &[],
    )
    .await;
    assert!(receipt(&mut context, receipt_address).await.claimed_at > 0);
    expect_access_error(
        &mut context,
        client::claim_access(program_id, authority, config).unwrap(),
        AccessStakeError::AlreadyClaimed,
    )
    .await;

    let unstake = || {
        client::unstake(
            program_id,
            authority,
            config,
            vault.pubkey(),
            destination.pubkey(),
            mint.pubkey(),
            DECIMALS,
        )
        .unwrap()
    };
    expect_access_error(&mut context, unstake(), AccessStakeError::StakeLocked).await;

    let mut clock: Clock = context.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp += LOCK_SECONDS;
    context.set_sysvar(&clock);
    send(
        &mut context,
        &[client::update_config(program_id, authority, config, None, None, Some(true)).unwrap()],
        &[],
    )
    .await;
    send(&mut context, &[unstake()], &[]).await;

    assert_eq!(token_balance(&mut context, vault.pubkey()).await, 0);
    assert_eq!(
        token_balance(&mut context, destination.pubkey()).await,
        REQUIRED_AMOUNT
    );
    let released = receipt(&mut context, receipt_address).await;
    assert_eq!(released.status, StakeStatus::Released);
    assert!(released.released_at >= released.unlock_at);
}
