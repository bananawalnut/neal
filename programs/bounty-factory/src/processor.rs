use borsh::BorshDeserialize;
use solana_program::{
    account_info::{AccountInfo, next_account_info},
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_sdk_ids::system_program;
use solana_system_interface::instruction as system_instruction;

use crate::{
    error::BountyError,
    instruction::BountyInstruction,
    state::{
        BOUNTY_DISCRIMINATOR, BOUNTY_SEED, Bounty, BountyStatus, FACTORY_DISCRIMINATOR,
        FACTORY_SEED, Factory, PROOF_DISCRIMINATOR, PROOF_SEED, Proof, ProofStatus, decode, encode,
    },
};

const TOKEN_PROGRAM: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = BountyInstruction::try_from_slice(instruction_data)
        .map_err(|_| BountyError::InvalidInstruction)?;

    match instruction {
        BountyInstruction::InitializeFactory {
            factory_id,
            creation_fee_amount,
        } => initialize_factory(program_id, accounts, factory_id, creation_fee_amount),
        BountyInstruction::SetPaused { paused } => set_paused(program_id, accounts, paused),
        BountyInstruction::CreateBounty {
            reward_amount,
            expires_at,
            token_decimals,
            brief_digest,
        } => create_bounty(
            program_id,
            accounts,
            reward_amount,
            expires_at,
            token_decimals,
            brief_digest,
        ),
        BountyInstruction::SubmitProof {
            proof_digest,
            uri_digest,
        } => submit_proof(program_id, accounts, proof_digest, uri_digest),
        BountyInstruction::CompleteProof { token_decimals } => {
            complete_proof(program_id, accounts, token_decimals)
        }
        BountyInstruction::CancelBounty { token_decimals } => {
            cancel_bounty(program_id, accounts, token_decimals)
        }
    }
}

fn initialize_factory(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    factory_id: u64,
    creation_fee_amount: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let authority = next_account_info(iter)?;
    let factory_info = next_account_info(iter)?;
    let reward_mint = next_account_info(iter)?;
    let fee_recipient = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system_program_info = next_account_info(iter)?;

    require_signer(payer)?;
    require_signer(authority)?;
    require_key(system_program_info, &system_program::id())?;
    validate_token_program(token_program)?;
    validate_mint(reward_mint, token_program, None)?;
    validate_token_account(fee_recipient, token_program, reward_mint.key, None)?;

    let id_bytes = factory_id.to_le_bytes();
    let (expected, bump) = Pubkey::find_program_address(
        &[FACTORY_SEED, authority.key.as_ref(), &id_bytes],
        program_id,
    );
    require_key(factory_info, &expected)?;
    create_pda_account(
        payer,
        factory_info,
        system_program_info,
        program_id,
        Factory::SPACE,
        &[FACTORY_SEED, authority.key.as_ref(), &id_bytes, &[bump]],
    )?;

    encode(
        &Factory {
            discriminator: FACTORY_DISCRIMINATOR,
            version: 1,
            authority: *authority.key,
            reward_mint: *reward_mint.key,
            token_program: *token_program.key,
            fee_recipient: *fee_recipient.key,
            creation_fee_amount,
            paused: false,
            bounty_count: 0,
            bump,
        },
        &mut factory_info.try_borrow_mut_data()?,
    )?;
    msg!("NEAL_FACTORY_INITIALIZED {}", factory_info.key);
    Ok(())
}

fn set_paused(program_id: &Pubkey, accounts: &[AccountInfo], paused: bool) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let factory_info = next_account_info(iter)?;
    require_signer(authority)?;
    require_owner(factory_info, program_id)?;
    let mut factory: Factory = decode(&factory_info.try_borrow_data()?)?;
    validate_factory(&factory)?;
    if factory.authority != *authority.key {
        return Err(BountyError::InvalidAuthority.into());
    }
    factory.paused = paused;
    encode(&factory, &mut factory_info.try_borrow_mut_data()?)?;
    msg!("NEAL_FACTORY_PAUSED {} {}", factory_info.key, paused);
    Ok(())
}

fn create_bounty(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    reward_amount: u64,
    expires_at: i64,
    token_decimals: u8,
    brief_digest: [u8; 32],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let creator = next_account_info(iter)?;
    let reviewer = next_account_info(iter)?;
    let factory_info = next_account_info(iter)?;
    let bounty_info = next_account_info(iter)?;
    let creator_source = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let fee_recipient = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system_program_info = next_account_info(iter)?;
    let clock_info = next_account_info(iter)?;

    require_signer(creator)?;
    require_owner(factory_info, program_id)?;
    require_key(system_program_info, &system_program::id())?;
    let clock = Clock::from_account_info(clock_info)?;
    if reward_amount == 0 || brief_digest == [0; 32] {
        return Err(BountyError::InvalidAmount.into());
    }
    if expires_at <= clock.unix_timestamp {
        return Err(BountyError::InvalidExpiry.into());
    }

    let mut factory: Factory = decode(&factory_info.try_borrow_data()?)?;
    validate_factory(&factory)?;
    require_not_paused(&factory)?;
    require_key(mint, &factory.reward_mint)?;
    require_key(token_program, &factory.token_program)?;
    require_key(fee_recipient, &factory.fee_recipient)?;
    validate_token_program(token_program)?;
    validate_mint(mint, token_program, Some(token_decimals))?;
    validate_token_account(fee_recipient, token_program, mint.key, None)?;

    let id = factory.bounty_count;
    let id_bytes = id.to_le_bytes();
    let (expected, bump) = Pubkey::find_program_address(
        &[BOUNTY_SEED, factory_info.key.as_ref(), &id_bytes],
        program_id,
    );
    require_key(bounty_info, &expected)?;
    create_pda_account(
        creator,
        bounty_info,
        system_program_info,
        program_id,
        Bounty::SPACE,
        &[BOUNTY_SEED, factory_info.key.as_ref(), &id_bytes, &[bump]],
    )?;

    validate_token_account(creator_source, token_program, mint.key, Some(creator.key))?;
    if validate_token_account(vault, token_program, mint.key, Some(bounty_info.key))? != 0 {
        return Err(BountyError::InvalidAmount.into());
    }
    transfer_checked(
        token_program,
        creator_source,
        mint,
        vault,
        creator,
        reward_amount,
        token_decimals,
        None,
    )?;
    if factory.creation_fee_amount > 0 {
        transfer_checked(
            token_program,
            creator_source,
            mint,
            fee_recipient,
            creator,
            factory.creation_fee_amount,
            token_decimals,
            None,
        )?;
    }
    if validate_token_account(vault, token_program, mint.key, Some(bounty_info.key))?
        != reward_amount
    {
        return Err(BountyError::InvalidAmount.into());
    }

    let bounty = Bounty {
        discriminator: BOUNTY_DISCRIMINATOR,
        factory: *factory_info.key,
        id,
        creator: *creator.key,
        reviewer: *reviewer.key,
        reward_mint: *mint.key,
        vault: *vault.key,
        reward_amount,
        creation_fee_amount: factory.creation_fee_amount,
        expires_at,
        proof_count: 0,
        brief_digest,
        status: BountyStatus::Open,
        winning_proof: Pubkey::default(),
        bump,
    };
    factory.bounty_count = factory
        .bounty_count
        .checked_add(1)
        .ok_or(BountyError::ArithmeticOverflow)?;
    encode(&bounty, &mut bounty_info.try_borrow_mut_data()?)?;
    encode(&factory, &mut factory_info.try_borrow_mut_data()?)?;
    msg!(
        "NEAL_BOUNTY_CREATED {} {} {} {}",
        bounty_info.key,
        id,
        reward_amount,
        factory.creation_fee_amount
    );
    Ok(())
}

fn submit_proof(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    proof_digest: [u8; 32],
    uri_digest: [u8; 32],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let submitter = next_account_info(iter)?;
    let factory_info = next_account_info(iter)?;
    let bounty_info = next_account_info(iter)?;
    let proof_info = next_account_info(iter)?;
    let system_program_info = next_account_info(iter)?;
    let clock_info = next_account_info(iter)?;

    require_signer(submitter)?;
    require_owner(factory_info, program_id)?;
    require_owner(bounty_info, program_id)?;
    require_key(system_program_info, &system_program::id())?;
    if proof_digest == [0; 32] || uri_digest == [0; 32] {
        return Err(BountyError::InvalidState.into());
    }
    let clock = Clock::from_account_info(clock_info)?;
    let factory: Factory = decode(&factory_info.try_borrow_data()?)?;
    validate_factory(&factory)?;
    require_not_paused(&factory)?;
    let mut bounty: Bounty = decode(&bounty_info.try_borrow_data()?)?;
    validate_bounty(&bounty, factory_info.key)?;
    require_open(&bounty)?;
    if clock.unix_timestamp > bounty.expires_at {
        return Err(BountyError::BountyExpired.into());
    }

    let number = bounty.proof_count;
    let number_bytes = number.to_le_bytes();
    let (expected, bump) = Pubkey::find_program_address(
        &[PROOF_SEED, bounty_info.key.as_ref(), &number_bytes],
        program_id,
    );
    require_key(proof_info, &expected)?;
    create_pda_account(
        submitter,
        proof_info,
        system_program_info,
        program_id,
        Proof::SPACE,
        &[PROOF_SEED, bounty_info.key.as_ref(), &number_bytes, &[bump]],
    )?;

    let proof = Proof {
        discriminator: PROOF_DISCRIMINATOR,
        bounty: *bounty_info.key,
        number,
        submitter: *submitter.key,
        proof_digest,
        uri_digest,
        submitted_at: clock.unix_timestamp,
        completed_at: 0,
        status: ProofStatus::Submitted,
        bump,
    };
    bounty.proof_count = bounty
        .proof_count
        .checked_add(1)
        .ok_or(BountyError::ArithmeticOverflow)?;
    encode(&proof, &mut proof_info.try_borrow_mut_data()?)?;
    encode(&bounty, &mut bounty_info.try_borrow_mut_data()?)?;
    msg!(
        "NEAL_PROOF_SUBMITTED {} {} {}",
        proof_info.key,
        bounty_info.key,
        number
    );
    Ok(())
}

fn complete_proof(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_decimals: u8,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let reviewer = next_account_info(iter)?;
    let factory_info = next_account_info(iter)?;
    let bounty_info = next_account_info(iter)?;
    let proof_info = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let recipient = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let clock_info = next_account_info(iter)?;

    require_signer(reviewer)?;
    require_owner(factory_info, program_id)?;
    require_owner(bounty_info, program_id)?;
    require_owner(proof_info, program_id)?;
    let clock = Clock::from_account_info(clock_info)?;
    let factory: Factory = decode(&factory_info.try_borrow_data()?)?;
    validate_factory(&factory)?;
    require_not_paused(&factory)?;
    let mut bounty: Bounty = decode(&bounty_info.try_borrow_data()?)?;
    let mut proof: Proof = decode(&proof_info.try_borrow_data()?)?;
    validate_bounty(&bounty, factory_info.key)?;
    validate_proof(&proof, bounty_info.key)?;
    require_open(&bounty)?;
    if bounty.reviewer != *reviewer.key {
        return Err(BountyError::InvalidAuthority.into());
    }
    if clock.unix_timestamp > bounty.expires_at {
        return Err(BountyError::BountyExpired.into());
    }
    if proof.status != ProofStatus::Submitted {
        return Err(BountyError::InvalidState.into());
    }
    require_key(vault, &bounty.vault)?;
    require_key(mint, &bounty.reward_mint)?;
    require_key(token_program, &factory.token_program)?;
    validate_token_program(token_program)?;
    validate_mint(mint, token_program, Some(token_decimals))?;
    if validate_token_account(vault, token_program, mint.key, Some(bounty_info.key))?
        < bounty.reward_amount
    {
        return Err(BountyError::InvalidAmount.into());
    }
    validate_token_account(recipient, token_program, mint.key, Some(&proof.submitter))?;

    let id_bytes = bounty.id.to_le_bytes();
    let bump = [bounty.bump];
    let signer_seeds = [
        BOUNTY_SEED,
        factory_info.key.as_ref(),
        id_bytes.as_ref(),
        bump.as_ref(),
    ];
    transfer_checked(
        token_program,
        vault,
        mint,
        recipient,
        bounty_info,
        bounty.reward_amount,
        token_decimals,
        Some(&signer_seeds),
    )?;

    bounty.complete_with(&mut proof, *proof_info.key, clock.unix_timestamp)?;
    encode(&proof, &mut proof_info.try_borrow_mut_data()?)?;
    encode(&bounty, &mut bounty_info.try_borrow_mut_data()?)?;
    msg!(
        "NEAL_PROOF_COMPLETED {} {} {}",
        proof_info.key,
        bounty_info.key,
        bounty.reward_amount
    );
    Ok(())
}

fn cancel_bounty(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_decimals: u8,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let caller = next_account_info(iter)?;
    let factory_info = next_account_info(iter)?;
    let bounty_info = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let refund_destination = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let clock_info = next_account_info(iter)?;

    require_signer(caller)?;
    require_owner(factory_info, program_id)?;
    require_owner(bounty_info, program_id)?;
    let clock = Clock::from_account_info(clock_info)?;
    let factory: Factory = decode(&factory_info.try_borrow_data()?)?;
    validate_factory(&factory)?;
    let mut bounty: Bounty = decode(&bounty_info.try_borrow_data()?)?;
    validate_bounty(&bounty, factory_info.key)?;
    require_open(&bounty)?;
    if *caller.key != bounty.creator && *caller.key != factory.authority {
        return Err(BountyError::InvalidAuthority.into());
    }
    if clock.unix_timestamp <= bounty.expires_at {
        return Err(BountyError::BountyNotExpired.into());
    }
    require_key(vault, &bounty.vault)?;
    require_key(mint, &bounty.reward_mint)?;
    require_key(token_program, &factory.token_program)?;
    validate_token_program(token_program)?;
    validate_mint(mint, token_program, Some(token_decimals))?;
    if validate_token_account(vault, token_program, mint.key, Some(bounty_info.key))?
        < bounty.reward_amount
    {
        return Err(BountyError::InvalidAmount.into());
    }
    validate_token_account(
        refund_destination,
        token_program,
        mint.key,
        Some(&bounty.creator),
    )?;

    let id_bytes = bounty.id.to_le_bytes();
    let bump = [bounty.bump];
    let signer_seeds = [
        BOUNTY_SEED,
        factory_info.key.as_ref(),
        id_bytes.as_ref(),
        bump.as_ref(),
    ];
    transfer_checked(
        token_program,
        vault,
        mint,
        refund_destination,
        bounty_info,
        bounty.reward_amount,
        token_decimals,
        Some(&signer_seeds),
    )?;
    bounty.status = BountyStatus::Cancelled;
    encode(&bounty, &mut bounty_info.try_borrow_mut_data()?)?;
    msg!("NEAL_BOUNTY_CANCELLED {}", bounty_info.key);
    Ok(())
}

fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system_program_info: &AccountInfo<'a>,
    owner: &Pubkey,
    space: usize,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    if !account.data_is_empty() || account.lamports() != 0 {
        return Err(BountyError::InvalidState.into());
    }
    let lamports = Rent::get()?.minimum_balance(space);
    invoke_signed(
        &system_instruction::create_account(payer.key, account.key, lamports, space as u64, owner),
        &[payer.clone(), account.clone(), system_program_info.clone()],
        &[signer_seeds],
    )
}

#[allow(clippy::too_many_arguments)]
fn transfer_checked<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    signer_seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    let mut data = Vec::with_capacity(10);
    data.push(12); // SPL Token and Token-2022 TransferChecked discriminator.
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let instruction = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    let account_infos = [
        source.clone(),
        mint.clone(),
        destination.clone(),
        authority.clone(),
        token_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&instruction, &account_infos, &[seeds]),
        None => invoke(&instruction, &account_infos),
    }
}

fn validate_token_program(account: &AccountInfo) -> ProgramResult {
    if *account.key != TOKEN_PROGRAM || !account.executable {
        return Err(BountyError::InvalidTokenAccount.into());
    }
    Ok(())
}

fn validate_mint(
    mint: &AccountInfo,
    token_program: &AccountInfo,
    expected_decimals: Option<u8>,
) -> ProgramResult {
    require_owner(mint, token_program.key)?;
    let data = mint.try_borrow_data()?;
    if data.len() < 82 || data[45] != 1 {
        return Err(BountyError::InvalidMint.into());
    }
    if expected_decimals.is_some_and(|decimals| decimals != data[44]) {
        return Err(BountyError::InvalidMint.into());
    }
    Ok(())
}

fn validate_token_account(
    account: &AccountInfo,
    token_program: &AccountInfo,
    expected_mint: &Pubkey,
    expected_authority: Option<&Pubkey>,
) -> Result<u64, ProgramError> {
    require_owner(account, token_program.key)?;
    let data = account.try_borrow_data()?;
    if data.len() < 165 || data[108] == 0 {
        return Err(BountyError::InvalidTokenAccount.into());
    }
    if &data[0..32] != expected_mint.as_ref()
        || expected_authority.is_some_and(|authority| &data[32..64] != authority.as_ref())
    {
        return Err(BountyError::InvalidTokenAccount.into());
    }
    let amount = u64::from_le_bytes(
        data[64..72]
            .try_into()
            .map_err(|_| BountyError::InvalidTokenAccount)?,
    );
    Ok(amount)
}

fn validate_factory(factory: &Factory) -> ProgramResult {
    if factory.discriminator != FACTORY_DISCRIMINATOR || factory.version != 1 {
        return Err(BountyError::InvalidState.into());
    }
    Ok(())
}

fn validate_bounty(bounty: &Bounty, factory: &Pubkey) -> ProgramResult {
    if bounty.discriminator != BOUNTY_DISCRIMINATOR || bounty.factory != *factory {
        return Err(BountyError::InvalidState.into());
    }
    Ok(())
}

fn validate_proof(proof: &Proof, bounty: &Pubkey) -> ProgramResult {
    if proof.discriminator != PROOF_DISCRIMINATOR || proof.bounty != *bounty {
        return Err(BountyError::ProofMismatch.into());
    }
    Ok(())
}

fn require_not_paused(factory: &Factory) -> ProgramResult {
    if factory.paused {
        return Err(BountyError::FactoryPaused.into());
    }
    Ok(())
}

fn require_open(bounty: &Bounty) -> ProgramResult {
    if bounty.status != BountyStatus::Open {
        return Err(BountyError::InvalidState.into());
    }
    Ok(())
}

fn require_signer(account: &AccountInfo) -> ProgramResult {
    if !account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

fn require_owner(account: &AccountInfo, owner: &Pubkey) -> ProgramResult {
    if account.owner != owner {
        return Err(BountyError::InvalidOwner.into());
    }
    Ok(())
}

fn require_key(account: &AccountInfo, expected: &Pubkey) -> ProgramResult {
    if account.key != expected {
        return Err(BountyError::InvalidPda.into());
    }
    Ok(())
}
