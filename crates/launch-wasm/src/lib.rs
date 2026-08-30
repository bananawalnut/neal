use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

const BPS_DENOMINATOR: u128 = 10_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestInput {
    name: String,
    symbol: String,
    metadata_uri: String,
    creator_wallet: String,
    quote_asset: String,
    mayhem_mode: bool,
    cashback: bool,
    max_quote_lamports: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestReport {
    valid: bool,
    blockers: Vec<String>,
    digest_hex: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExactTokenQuoteInput {
    virtual_token_reserves: String,
    virtual_quote_reserves: String,
    desired_token_base_units: String,
    total_fee_basis_points: u16,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ExactTokenQuote {
    net_quote_base_units: String,
    max_quote_base_units: String,
    desired_token_base_units: String,
    total_fee_basis_points: u16,
}

fn parse_u128(value: &str, field: &str) -> Result<u128, String> {
    value
        .parse::<u128>()
        .map_err(|_| format!("{field} must be an unsigned integer string"))
}

fn ceil_div(numerator: u128, denominator: u128) -> Result<u128, String> {
    if denominator == 0 {
        return Err("division by zero".into());
    }
    numerator
        .checked_add(denominator - 1)
        .map(|value| value / denominator)
        .ok_or_else(|| "integer overflow while rounding quote".into())
}

fn valid_solana_address(value: &str) -> bool {
    let mut decoded = [0_u8; 32];
    (32..=44).contains(&value.len())
        && bs58::decode(value)
            .onto(&mut decoded)
            .is_ok_and(|length| length == decoded.len())
}

fn inspect_manifest_inner(json: &str) -> Result<ManifestReport, String> {
    let input: ManifestInput = serde_json::from_str(json)
        .map_err(|error| format!("invalid launch manifest JSON: {error}"))?;
    let mut blockers = Vec::new();

    if input.name.trim().is_empty() || input.name.chars().count() > 32 {
        blockers.push("name must contain 1 to 32 characters".into());
    }
    if input.symbol.trim().is_empty() || input.symbol.chars().count() > 13 {
        blockers.push("symbol must contain 1 to 13 characters".into());
    }
    if input.metadata_uri.trim().is_empty() || input.metadata_uri.chars().count() > 200 {
        blockers.push("metadata URI must contain 1 to 200 characters".into());
    }
    if !input.metadata_uri.starts_with("https://") && !input.metadata_uri.starts_with("ipfs://") {
        blockers.push("metadata URI must use https:// or ipfs://".into());
    }
    if !valid_solana_address(&input.creator_wallet) {
        blockers.push("creator wallet is not a valid Solana address".into());
    }
    if input.quote_asset != "SOL" {
        blockers.push("canonical NEAL launch must quote in SOL".into());
    }
    if input.mayhem_mode {
        blockers.push("Mayhem must remain off".into());
    }
    if input.cashback {
        blockers.push("cashback must remain off".into());
    }
    if parse_u128(&input.max_quote_lamports, "maxQuoteLamports").is_err() {
        blockers.push("maxQuoteLamports must be an unsigned integer string".into());
    }

    let digest_hex = Sha256::digest(json.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    Ok(ManifestReport {
        valid: blockers.is_empty(),
        blockers,
        digest_hex,
    })
}

fn quote_exact_tokens_inner(input: ExactTokenQuoteInput) -> Result<ExactTokenQuote, String> {
    let virtual_tokens = parse_u128(&input.virtual_token_reserves, "virtualTokenReserves")?;
    let virtual_quote = parse_u128(&input.virtual_quote_reserves, "virtualQuoteReserves")?;
    let desired_tokens = parse_u128(&input.desired_token_base_units, "desiredTokenBaseUnits")?;

    if desired_tokens == 0 {
        return Err("desired token amount must be greater than zero".into());
    }
    if desired_tokens >= virtual_tokens {
        return Err("desired token amount must be below virtual token reserves".into());
    }

    let numerator = desired_tokens
        .checked_mul(virtual_quote)
        .ok_or_else(|| "integer overflow while calculating net quote".to_string())?;
    let denominator = virtual_tokens - desired_tokens;
    // Pump's exact-token buy quote uses integer division (floor) and then adds
    // one quote base unit. Using ceil_div here would add two units whenever
    // the division has a remainder.
    let net_quote = (numerator / denominator)
        .checked_add(1)
        .ok_or_else(|| "integer overflow while applying Pump rounding".to_string())?;
    let fee_multiplier = BPS_DENOMINATOR
        .checked_add(u128::from(input.total_fee_basis_points))
        .ok_or_else(|| "integer overflow while applying fee basis points".to_string())?;
    let max_quote = ceil_div(
        net_quote
            .checked_mul(fee_multiplier)
            .ok_or_else(|| "integer overflow while applying fees".to_string())?,
        BPS_DENOMINATOR,
    )?;

    Ok(ExactTokenQuote {
        net_quote_base_units: net_quote.to_string(),
        max_quote_base_units: max_quote.to_string(),
        desired_token_base_units: desired_tokens.to_string(),
        total_fee_basis_points: input.total_fee_basis_points,
    })
}

#[wasm_bindgen]
pub fn inspect_manifest(json: &str) -> Result<String, JsValue> {
    inspect_manifest_inner(json)
        .and_then(|report| serde_json::to_string(&report).map_err(|error| error.to_string()))
        .map_err(|error| JsValue::from_str(&error))
}

#[wasm_bindgen]
pub fn quote_exact_tokens(json: &str) -> Result<String, JsValue> {
    let input = serde_json::from_str::<ExactTokenQuoteInput>(json)
        .map_err(|error| JsValue::from_str(&format!("invalid quote JSON: {error}")))?;
    quote_exact_tokens_inner(input)
        .and_then(|quote| serde_json::to_string(&quote).map_err(|error| error.to_string()))
        .map_err(|error| JsValue::from_str(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_locked_neal_manifest() {
        let report = inspect_manifest_inner(
            r#"{
                "name":"Neal the Seal",
                "symbol":"NEAL",
                "metadataUri":"ipfs://bafy-test/neal.json",
                "creatorWallet":"GEscvQdeHg1BSBo5XiKK4UskMmU738AhJvtFF4x5uGzv",
                "quoteAsset":"SOL",
                "mayhemMode":false,
                "cashback":false,
                "maxQuoteLamports":"2500000000"
            }"#,
        )
        .unwrap();
        assert!(report.valid, "{:?}", report.blockers);
        assert_eq!(report.digest_hex.len(), 64);
    }

    #[test]
    fn rejects_policy_drift() {
        let report = inspect_manifest_inner(
            r#"{
                "name":"Neal the Seal",
                "symbol":"NEAL",
                "metadataUri":"https://example.com/neal.json",
                "creatorWallet":"GEscvQdeHg1BSBo5XiKK4UskMmU738AhJvtFF4x5uGzv",
                "quoteAsset":"USDC",
                "mayhemMode":true,
                "cashback":true,
                "maxQuoteLamports":"nope"
            }"#,
        )
        .unwrap();
        assert!(!report.valid);
        assert_eq!(report.blockers.len(), 4);
    }

    #[test]
    fn reproduces_reverse_constant_product_quote() {
        let quote = quote_exact_tokens_inner(ExactTokenQuoteInput {
            virtual_token_reserves: "1073000000000000".into(),
            virtual_quote_reserves: "30000000000".into(),
            desired_token_base_units: "80000000000000".into(),
            total_fee_basis_points: 125,
        })
        .unwrap();
        assert_eq!(quote.net_quote_base_units, "2416918430");
        assert_eq!(quote.max_quote_base_units, "2447129911");
    }
}
