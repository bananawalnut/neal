use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchControl {
    pub schema: String,
    pub status: String,
    pub canonical_route: String,
    pub network: String,
    pub token: TokenConfig,
    pub pumpfun: PumpFunConfig,
    pub programs: ProgramsConfig,
    pub secondary_liquidity: SecondaryLiquidity,
    pub execution: ExecutionConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenConfig {
    pub name: String,
    pub symbol: String,
    #[serde(default)]
    pub metadata_uri: Option<String>,
    pub image_path: Option<String>,
    pub banner_path: Option<String>,
    #[serde(default)]
    pub banner_url: Option<String>,
    pub description: Option<String>,
    pub website: Option<String>,
    #[serde(default)]
    pub social_links: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpFunConfig {
    pub quote_asset: String,
    pub mayhem_mode: bool,
    pub cash_back: Option<bool>,
    pub creator_wallet: Option<String>,
    pub creator_fee_recipient: Option<String>,
    #[serde(default)]
    pub initial_creator_purchase_lamports: Option<String>,
    #[serde(default)]
    pub initial_creator_purchase_sol: Option<Value>,
    pub launch_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramsConfig {
    pub genesis_allocation_available: bool,
    #[serde(default)]
    pub previous_target_basis_points: Option<ProgramTargets>,
    #[serde(default)]
    pub current_target_basis_points: Option<CurrentProgramTargets>,
    #[serde(default)]
    pub economics: Option<EconomicsPlan>,
    #[serde(default)]
    pub community_suggestions: Option<CommunitySuggestionsPlan>,
    #[serde(default)]
    pub yahoos: Option<YahooProgramPlan>,
    pub funding_method: String,
    pub funded_inventory: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramTargets {
    pub public_launch: u16,
    pub quests: u16,
    pub airdrop: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentProgramTargets {
    pub public_launch: u16,
    pub founder_purchase: u16,
    pub quests: u16,
    pub airdrop: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EconomicsPlan {
    pub dev_purchase: DevPurchasePlan,
    pub quest_treasury: QuestTreasuryPlan,
    #[serde(default)]
    pub creator_fee_routing: Option<CreatorFeeRoutingPlan>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPurchasePlan {
    pub method: String,
    pub wallet: Option<String>,
    #[serde(default)]
    pub transactions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestTreasuryPlan {
    pub creator_fee_share_basis_points: u16,
    pub purchase_method: String,
    pub wallet: Option<String>,
    #[serde(default)]
    pub purposes: Vec<String>,
    #[serde(default)]
    pub open_source_developer_airdrops: Option<OpenSourceDeveloperAirdropsPlan>,
    #[serde(default)]
    pub transactions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSourceDeveloperAirdropsPlan {
    pub acquisition_method: String,
    pub max_holdings_supply_basis_points: u16,
    pub cap_measurement: String,
    pub cap_override_approval: String,
    pub eligibility_policy_uri: Option<String>,
    #[serde(default)]
    pub distributions: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorFeeRoutingPlan {
    pub method: String,
    pub status: String,
    pub configuration_address: Option<String>,
    pub create_transaction: Option<String>,
    pub finalize_transaction: Option<String>,
    pub final_update_is_immutable: bool,
    pub pre_activation_policy: String,
    #[serde(default)]
    pub shares: Vec<CreatorFeeRoutingShare>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorFeeRoutingShare {
    pub role: String,
    pub share_basis_points: u16,
    pub wallet: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySuggestionsPlan {
    pub entry_fee_tokens: String,
    #[serde(default)]
    pub accepted_entry_assets: Vec<CommunitySuggestionAsset>,
    pub destination: String,
    pub registry_uri: Option<String>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySuggestionAsset {
    pub symbol: String,
    pub amount_tokens: String,
    pub canonical_mint_source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooProgramPlan {
    #[serde(default)]
    pub local_mode: Option<YahooLocalMode>,
    #[serde(default)]
    pub future_on_chain_policy_status: Option<String>,
    pub daily_free_per_wallet: u8,
    pub daily_window: String,
    pub paid_price_numerator: String,
    pub paid_price_denominator: String,
    #[serde(default)]
    pub accepted_payment_assets: Vec<CommunitySuggestionAsset>,
    pub fastest_consecutive_count: u8,
    #[serde(default = "default_yahoo_rate_window_seconds")]
    pub peak_rate_window_seconds: u16,
    pub program_id: Option<String>,
    pub leaderboard_registry_uri: Option<String>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooLocalMode {
    pub enabled: bool,
    pub storage: String,
    pub price: String,
    pub ranking_scope: String,
}

fn default_yahoo_rate_window_seconds() -> u16 {
    60
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecondaryLiquidity {
    pub enabled_at_launch: bool,
    pub planned_quote_symbol: String,
    pub quote_mint: Option<String>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionConfig {
    pub mint_address: Option<String>,
    pub creation_transaction: Option<String>,
    pub final_human_wallet_review_required: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Pass,
    Warning,
    Blocker,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessCheck {
    pub severity: Severity,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessReport {
    pub schema: String,
    pub ready: bool,
    pub blocker_count: usize,
    pub warning_count: usize,
    pub checks: Vec<ReadinessCheck>,
}

impl LaunchControl {
    pub fn readiness_report(&self) -> ReadinessReport {
        let mut checks = Vec::new();

        exact_check(
            &mut checks,
            "contract.schema",
            self.schema == "neal.launch-control/v1",
            "Launch contract uses neal.launch-control/v1.",
            "Launch contract schema must be neal.launch-control/v1.",
        );
        exact_check(
            &mut checks,
            "route.canonical",
            self.canonical_route == "pumpfun" && self.network == "solana",
            "Pump.fun on Solana is the canonical route.",
            "NEAL must have one canonical Pump.fun mint on Solana.",
        );
        exact_check(
            &mut checks,
            "token.identity",
            self.token.name == "Neal the Seal" && self.token.symbol == "NEAL",
            "Token identity is locked to Neal the Seal / NEAL.",
            "Token name or ticker differs from the locked launch identity.",
        );

        required_text(
            &mut checks,
            "metadata.image",
            self.token.image_path.as_deref(),
            1,
            "Final token image is recorded.",
            "A final token image path is required.",
        );
        required_text(
            &mut checks,
            "metadata.description",
            self.token.description.as_deref(),
            20,
            "Final token description is recorded.",
            "A final description of at least 20 characters is required.",
        );
        metadata_uri_check(&mut checks, self.token.metadata_uri.as_deref());

        let banner_ready = match (
            self.token.banner_path.as_deref(),
            self.token.banner_url.as_deref(),
        ) {
            (None, None) => true,
            (Some(path), Some(url)) => nonempty(path) && url.starts_with("https://"),
            _ => false,
        };
        checks.push(ReadinessCheck {
            severity: if banner_ready {
                Severity::Pass
            } else {
                Severity::Blocker
            },
            code: "metadata.banner".into(),
            message: if banner_ready {
                "Banner omission or hosted banner pair is explicit.".into()
            } else {
                "Banner path and HTTPS banner URL must either both be recorded or both be omitted."
                    .into()
            },
        });

        let public_links = self.token.website.as_deref().is_some_and(nonempty)
            || !self.token.social_links.is_empty();
        checks.push(ReadinessCheck {
            severity: if public_links {
                Severity::Pass
            } else {
                Severity::Warning
            },
            code: "metadata.links".into(),
            message: if public_links {
                "At least one public project link is recorded.".into()
            } else {
                "No website or social link is recorded; explicitly approve a linkless launch."
                    .into()
            },
        });

        exact_check(
            &mut checks,
            "pumpfun.quote",
            self.pumpfun.quote_asset == "SOL",
            "Initial Pump.fun quote is SOL.",
            "The approved launch plan currently requires SOL as the initial quote.",
        );
        exact_check(
            &mut checks,
            "pumpfun.mayhem",
            !self.pumpfun.mayhem_mode,
            "Mayhem mode is disabled.",
            "Mayhem mode must remain disabled unless the launch plan is formally revised.",
        );
        specified_check(
            &mut checks,
            "pumpfun.cashback",
            self.pumpfun.cash_back.is_some(),
            "Cash-back mode has an explicit decision.",
            "Cash-back mode must be explicitly set to true or false.",
        );
        address_check(
            &mut checks,
            "wallet.creator",
            self.pumpfun.creator_wallet.as_deref(),
            "Creator wallet has valid Solana address syntax.",
            "A syntactically valid creator wallet is required.",
        );
        address_check(
            &mut checks,
            "wallet.fee_recipient",
            self.pumpfun.creator_fee_recipient.as_deref(),
            "Creator-fee recipient has valid Solana address syntax.",
            "A syntactically valid creator-fee recipient is required.",
        );

        purchase_check(&mut checks, &self.pumpfun);
        required_text(
            &mut checks,
            "schedule.launch_at",
            self.pumpfun.launch_at.as_deref(),
            1,
            "Launch time is recorded.",
            "Launch time must be selected before final rehearsal.",
        );

        exact_check(
            &mut checks,
            "programs.genesis",
            !self.programs.genesis_allocation_available,
            "The dev and quest treasury receive no free genesis allocation.",
            "NEAL's Pump.fun launch must not claim a custom genesis allocation.",
        );
        let economics_valid = self.programs.economics.as_ref().is_some_and(|economics| {
            economics.dev_purchase.method == "pumpfun_market_buy"
                && economics.quest_treasury.creator_fee_share_basis_points == 4_200
                && economics.quest_treasury.purchase_method == "creator_fee_funded_market_buybacks"
        });
        exact_check(
            &mut checks,
            "programs.economics",
            economics_valid,
            "The dev buys NEAL from the Pump.fun market; 42% of creator fees fund treasury market buybacks.",
            "Record the market-purchase economics: dev buys NEAL and 42% of creator fees fund treasury buybacks.",
        );
        treasury_airdrop_check(&mut checks, self.programs.economics.as_ref());
        creator_fee_routing_check(&mut checks, &self.pumpfun, self.programs.economics.as_ref());
        let suggestions_valid =
            self.programs
                .community_suggestions
                .as_ref()
                .is_some_and(|suggestions| {
                    suggestions.entry_fee_tokens == "1"
                        && suggestions.destination == "quest_treasury"
                        && matches!(
                            suggestions.status.as_str(),
                            "pre_launch" | "active" | "paused"
                        )
                });
        exact_check(
            &mut checks,
            "programs.community_suggestions",
            suggestions_valid,
            "Community suggestions cost exactly one accepted token and route to the quest treasury.",
            "Record the community-suggestion rule: one accepted token per entry, routed to the quest treasury.",
        );
        let suggestion_assets = self
            .programs
            .community_suggestions
            .as_ref()
            .map(|suggestions| suggestions.accepted_entry_assets.as_slice())
            .unwrap_or_default();
        let suggestion_assets_valid = suggestion_assets.len() == 2
            && suggestion_assets.iter().any(|asset| {
                asset.symbol == "NEAL"
                    && asset.amount_tokens == "1"
                    && asset.canonical_mint_source == "execution.mintAddress"
            })
            && suggestion_assets.iter().any(|asset| {
                asset.symbol == "DREGG"
                    && asset.amount_tokens == "1"
                    && asset.canonical_mint_source == "secondaryLiquidity.quoteMint"
            });
        checks.push(ReadinessCheck {
            severity: if suggestion_assets_valid {
                Severity::Pass
            } else if suggestion_assets.is_empty() {
                Severity::Warning
            } else {
                Severity::Blocker
            },
            code: "programs.suggestion_assets".into(),
            message: if suggestion_assets_valid {
                "Suggestion entry accepts exactly 1 NEAL or 1 DREGG from canonical mints.".into()
            } else if suggestion_assets.is_empty() {
                "Legacy NEAL-only suggestion policy loaded; add the canonical DREGG option.".into()
            } else {
                "Suggestion assets must be exactly 1 NEAL or 1 DREGG with canonical mint sources."
                    .into()
            },
        });
        checks.push(ReadinessCheck {
            severity: if self
                .programs
                .community_suggestions
                .as_ref()
                .and_then(|suggestions| suggestions.registry_uri.as_deref())
                .is_some_and(nonempty)
            {
                Severity::Pass
            } else {
                Severity::Warning
            },
            code: "programs.suggestion_registry".into(),
            message: if self
                .programs
                .community_suggestions
                .as_ref()
                .and_then(|suggestions| suggestions.registry_uri.as_deref())
                .is_some_and(nonempty)
            {
                "The public community-suggestion registry is recorded.".into()
            } else {
                "Community suggestion entry remains locked until its public registry is recorded."
                    .into()
            },
        });
        let yahoo_policy = self.programs.yahoos.as_ref();
        let yahoo_local_mode_valid = yahoo_policy.is_some_and(|yahoos| {
            yahoos.local_mode.as_ref().is_some_and(|local| {
                local.enabled
                    && local.storage == "browser_local_storage"
                    && local.price == "free"
                    && local.ranking_scope == "this_browser"
            }) && yahoos.future_on_chain_policy_status.as_deref() == Some("undecided")
        });
        let yahoo_policy_valid = yahoo_policy.is_some_and(|yahoos| {
            let assets = yahoos.accepted_payment_assets.as_slice();
            yahoos.daily_free_per_wallet == 3
                && yahoos.daily_window == "solana_clock_utc_day"
                && yahoos.paid_price_numerator == "1"
                && yahoos.paid_price_denominator == "10"
                && yahoos.fastest_consecutive_count == 3
                && yahoos.peak_rate_window_seconds == 60
                && matches!(yahoos.status.as_str(), "pre_launch" | "active" | "paused")
                && assets.len() == 2
                && assets.iter().any(|asset| {
                    asset.symbol == "NEAL"
                        && asset.amount_tokens == "0.1"
                        && asset.canonical_mint_source == "execution.mintAddress"
                })
                && assets.iter().any(|asset| {
                    asset.symbol == "DREGG"
                        && asset.amount_tokens == "0.1"
                        && asset.canonical_mint_source == "secondaryLiquidity.quoteMint"
                })
        });
        checks.push(ReadinessCheck {
            severity: if yahoo_local_mode_valid || yahoo_policy_valid {
                Severity::Pass
            } else if yahoo_policy.is_none() {
                Severity::Warning
            } else {
                Severity::Blocker
            },
            code: "programs.yahoos".into(),
            message: if yahoo_local_mode_valid {
                "All YAHOOS are free and stored only in this browser; the future on-chain policy remains undecided."
                    .into()
            } else if yahoo_policy_valid {
                "Every wallet gets 3 free daily YAHOOS; later YAHOOS cost 0.1 canonical NEAL or DREGG."
                    .into()
            } else if yahoo_policy.is_none() {
                "No on-chain YAHOO policy is recorded; older contracts remain readable."
                    .into()
            } else {
                "YAHOOS must either use the explicit free browser-local mode with an undecided future policy, or satisfy the reviewed on-chain policy contract."
                    .into()
            },
        });
        if let Some(yahoos) = yahoo_policy {
            optional_address_check(
                &mut checks,
                "programs.yahoo_program_id",
                yahoos.program_id.as_deref(),
                "The on-chain YAHOO program ID has valid Solana address syntax.",
                "On-chain YAHOOS remain unavailable until a future policy is decided and a reviewed program ID is published; free local YAHOOS are unaffected.",
                "The disclosed YAHOO program ID is not a valid Solana address.",
            );
            checks.push(ReadinessCheck {
                severity: if yahoos
                    .leaderboard_registry_uri
                    .as_deref()
                    .is_some_and(nonempty)
                {
                    Severity::Pass
                } else {
                    Severity::Warning
                },
                code: "programs.yahoo_leaderboard".into(),
                message: if yahoos
                    .leaderboard_registry_uri
                    .as_deref()
                    .is_some_and(nonempty)
                {
                    "The public YAHOO leaderboard registry is recorded.".into()
                } else {
                    "Leaderboard claims remain empty until a public YAHOO registry is recorded."
                        .into()
                },
            });
        }
        checks.push(ReadinessCheck {
            severity: if self.programs.previous_target_basis_points.is_none()
                && self.programs.current_target_basis_points.is_none()
            {
                Severity::Pass
            } else {
                Severity::Warning
            },
            code: "programs.legacy_targets".into(),
            message: if self.programs.previous_target_basis_points.is_none()
                && self.programs.current_target_basis_points.is_none()
            {
                "No obsolete percentage-allocation model is active.".into()
            } else {
                "Legacy percentage targets are readable for compatibility but are not active NEAL tokenomics.".into()
            },
        });
        if let Some(economics) = self.programs.economics.as_ref() {
            optional_address_check(
                &mut checks,
                "wallet.dev_public",
                economics.dev_purchase.wallet.as_deref(),
                "The disclosed dev wallet has valid Solana address syntax.",
                "The dev wallet will be published after it is created.",
                "The disclosed dev wallet is not a valid Solana address.",
            );
            optional_address_check(
                &mut checks,
                "wallet.quest_treasury_public",
                economics.quest_treasury.wallet.as_deref(),
                "The disclosed quest-treasury wallet has valid Solana address syntax.",
                "The quest-treasury wallet will be published after it is created.",
                "The disclosed quest-treasury wallet is not a valid Solana address.",
            );
        }
        checks.push(ReadinessCheck {
            severity: if self.programs.funded_inventory.is_some() {
                Severity::Pass
            } else {
                Severity::Warning
            },
            code: "programs.inventory".into(),
            message: if self.programs.funded_inventory.is_some() {
                "Funded program inventory is recorded.".into()
            } else {
                "Quest rewards become inventory only after treasury buybacks settle and their receipts are recorded.".into()
            },
        });

        exact_check(
            &mut checks,
            "liquidity.secondary",
            !self.secondary_liquidity.enabled_at_launch
                && self.secondary_liquidity.quote_mint.is_none(),
            "Secondary liquidity is deferred until after launch.",
            "Secondary liquidity or a quote mint must not be configured for the canonical launch.",
        );
        exact_check(
            &mut checks,
            "execution.human_review",
            self.execution.final_human_wallet_review_required,
            "Final human wallet review is mandatory.",
            "Final human wallet review cannot be disabled.",
        );

        let has_mint = self.execution.mint_address.as_deref().is_some_and(nonempty);
        let has_transaction = self
            .execution
            .creation_transaction
            .as_deref()
            .is_some_and(nonempty);
        exact_check(
            &mut checks,
            "execution.record",
            has_mint == has_transaction,
            if has_mint {
                "Mint address and creation transaction are recorded together."
            } else {
                "Pre-launch execution record is empty."
            },
            "Mint address and creation transaction must be recorded together.",
        );

        let blocker_count = checks
            .iter()
            .filter(|check| check.severity == Severity::Blocker)
            .count();
        let warning_count = checks
            .iter()
            .filter(|check| check.severity == Severity::Warning)
            .count();

        ReadinessReport {
            schema: "neal.readiness-report/v1".into(),
            ready: blocker_count == 0,
            blocker_count,
            warning_count,
            checks,
        }
    }
}

fn exact_check(
    checks: &mut Vec<ReadinessCheck>,
    code: &str,
    condition: bool,
    pass: &str,
    blocker: &str,
) {
    checks.push(ReadinessCheck {
        severity: if condition {
            Severity::Pass
        } else {
            Severity::Blocker
        },
        code: code.into(),
        message: if condition { pass } else { blocker }.into(),
    });
}

fn specified_check(
    checks: &mut Vec<ReadinessCheck>,
    code: &str,
    condition: bool,
    pass: &str,
    blocker: &str,
) {
    exact_check(checks, code, condition, pass, blocker);
}

fn required_text(
    checks: &mut Vec<ReadinessCheck>,
    code: &str,
    value: Option<&str>,
    minimum_length: usize,
    pass: &str,
    blocker: &str,
) {
    let present = value.is_some_and(|text| text.trim().chars().count() >= minimum_length);
    exact_check(checks, code, present, pass, blocker);
}

fn address_check(
    checks: &mut Vec<ReadinessCheck>,
    code: &str,
    value: Option<&str>,
    pass: &str,
    blocker: &str,
) {
    exact_check(
        checks,
        code,
        value.is_some_and(valid_solana_address_syntax),
        pass,
        blocker,
    );
}

fn optional_address_check(
    checks: &mut Vec<ReadinessCheck>,
    code: &str,
    value: Option<&str>,
    pass: &str,
    absent: &str,
    blocker: &str,
) {
    checks.push(ReadinessCheck {
        severity: match value {
            Some(address) if valid_solana_address_syntax(address) => Severity::Pass,
            Some(_) => Severity::Blocker,
            None => Severity::Warning,
        },
        code: code.into(),
        message: match value {
            Some(address) if valid_solana_address_syntax(address) => pass,
            Some(_) => blocker,
            None => absent,
        }
        .into(),
    });
}

fn creator_fee_routing_check(
    checks: &mut Vec<ReadinessCheck>,
    pumpfun: &PumpFunConfig,
    economics: Option<&EconomicsPlan>,
) {
    let Some(routing) = economics.and_then(|plan| plan.creator_fee_routing.as_ref()) else {
        checks.push(ReadinessCheck {
            severity: Severity::Warning,
            code: "programs.creator_fee_routing".into(),
            message:
                "Older launch contract loaded without an explicit Pump creator-fee routing plan."
                    .into(),
        });
        return;
    };

    let dev_share = routing.shares.iter().find(|share| share.role == "dev");
    let quest_share = routing
        .shares
        .iter()
        .find(|share| share.role == "quest_treasury");
    let share_sum = routing
        .shares
        .iter()
        .map(|share| u32::from(share.share_basis_points))
        .sum::<u32>();
    let dev_valid = dev_share.is_some_and(|share| {
        share.share_basis_points == 5_800
            && share.wallet.as_deref() == pumpfun.creator_fee_recipient.as_deref()
            && share
                .wallet
                .as_deref()
                .is_some_and(valid_solana_address_syntax)
    });
    let quest_wallet = quest_share.and_then(|share| share.wallet.as_deref());
    let quest_economics_wallet = economics.and_then(|plan| plan.quest_treasury.wallet.as_deref());
    let quest_valid = quest_share.is_some_and(|share| {
        share.share_basis_points == 4_200
            && match share.wallet.as_deref() {
                Some(wallet) => {
                    valid_solana_address_syntax(wallet) && Some(wallet) == quest_economics_wallet
                }
                None => quest_economics_wallet.is_none() && routing.status == "planned",
            }
    });
    let shape_valid = routing.method == "pump_fee_sharing_v2"
        && routing.final_update_is_immutable
        && routing.pre_activation_policy == "manual_pro_rata_sweep"
        && routing.shares.len() == 2
        && share_sum == 10_000
        && dev_valid
        && quest_valid;
    let active_record_valid = routing.status != "active"
        || (routing
            .configuration_address
            .as_deref()
            .is_some_and(valid_solana_address_syntax)
            && routing.create_transaction.as_deref().is_some_and(nonempty)
            && routing
                .finalize_transaction
                .as_deref()
                .is_some_and(nonempty)
            && quest_wallet.is_some());
    let status_valid = matches!(
        routing.status.as_str(),
        "planned" | "ready_for_signature" | "active"
    );

    checks.push(ReadinessCheck {
        severity: if !shape_valid || !active_record_valid || !status_valid {
            Severity::Blocker
        } else if quest_wallet.is_none() {
            Severity::Warning
        } else {
            Severity::Pass
        },
        code: "programs.creator_fee_routing".into(),
        message: if !shape_valid || !active_record_valid || !status_valid {
            "Pump creator-fee routing must use one immutable V2 split: 58% to the disclosed dev recipient and 42% to the disclosed quest treasury.".into()
        } else if quest_wallet.is_none() {
            "Pump's immutable 58/42 fee-sharing split is planned and remains unfinalized until the quest-treasury wallet exists.".into()
        } else if routing.status == "active" {
            "Pump's immutable 58/42 creator-fee sharing record and activation receipts are recorded.".into()
        } else {
            "Pump's immutable 58/42 creator-fee sharing plan has two valid recipient wallets and is ready for post-mint setup.".into()
        },
    });
}

fn treasury_airdrop_check(checks: &mut Vec<ReadinessCheck>, economics: Option<&EconomicsPlan>) {
    let Some(treasury) = economics.map(|plan| &plan.quest_treasury) else {
        return;
    };
    let airdrops = treasury.open_source_developer_airdrops.as_ref();
    let purpose_valid = treasury.purposes.len() == 2
        && treasury
            .purposes
            .iter()
            .any(|purpose| purpose == "quest_rewards")
        && treasury
            .purposes
            .iter()
            .any(|purpose| purpose == "open_source_developer_airdrops");
    let policy_valid = airdrops.is_some_and(|policy| {
        policy.acquisition_method == "market_buy"
            && policy.max_holdings_supply_basis_points == 1_800
            && policy.cap_measurement == "airdrop_earmarked_balance_at_finalized_supply"
            && policy.cap_override_approval == "unanimous_neal_holder_approval"
    });

    checks.push(ReadinessCheck {
        severity: if airdrops.is_none() && treasury.purposes.is_empty() {
            Severity::Warning
        } else if purpose_valid && policy_valid {
            Severity::Pass
        } else {
            Severity::Blocker
        },
        code: "programs.open_source_developer_airdrops".into(),
        message: if airdrops.is_none() && treasury.purposes.is_empty() {
            "Older treasury contract loaded without the open-source-developer airdrop mandate."
                .into()
        } else if purpose_valid && policy_valid {
            "The treasury funds quests and open-source-developer airdrops through market buys; airdrop-earmarked holdings are capped at 18% of supply unless every NEAL holder approves more."
                .into()
        } else {
            "Treasury purposes must be quests plus open-source-developer airdrops, acquired by market buy with an 18% live holdings cap and unanimous-holder override rule."
                .into()
        },
    });

    checks.push(ReadinessCheck {
        severity: if airdrops
            .and_then(|policy| policy.eligibility_policy_uri.as_deref())
            .is_some_and(nonempty)
        {
            Severity::Pass
        } else {
            Severity::Warning
        },
        code: "programs.airdrop_eligibility_policy".into(),
        message: if airdrops
            .and_then(|policy| policy.eligibility_policy_uri.as_deref())
            .is_some_and(nonempty)
        {
            "The open-source-developer airdrop eligibility policy is published.".into()
        } else {
            "Airdrops remain locked until an open-source-developer eligibility policy is published."
                .into()
        },
    });
}

fn purchase_check(checks: &mut Vec<ReadinessCheck>, config: &PumpFunConfig) {
    let lamports_valid = config
        .initial_creator_purchase_lamports
        .as_deref()
        .is_some_and(|value| value.parse::<u64>().is_ok());

    if lamports_valid {
        checks.push(ReadinessCheck {
            severity: Severity::Pass,
            code: "pumpfun.initial_purchase".into(),
            message: "Initial creator purchase is recorded in integer lamports.".into(),
        });
    } else if config.initial_creator_purchase_sol.is_some() {
        checks.push(ReadinessCheck {
            severity: Severity::Blocker,
            code: "pumpfun.initial_purchase".into(),
            message:
                "Legacy initialCreatorPurchaseSol must be migrated to an integer lamport string."
                    .into(),
        });
    } else {
        checks.push(ReadinessCheck {
            severity: Severity::Blocker,
            code: "pumpfun.initial_purchase".into(),
            message: "Set initialCreatorPurchaseLamports to an integer string; use \"0\" for no purchase.".into(),
        });
    }
}

fn metadata_uri_check(checks: &mut Vec<ReadinessCheck>, value: Option<&str>) {
    let valid = value.is_some_and(|uri| {
        !uri.trim().is_empty()
            && uri.chars().count() <= 200
            && (uri.starts_with("https://") || uri.starts_with("ipfs://"))
    });
    checks.push(ReadinessCheck {
        severity: if valid { Severity::Pass } else { Severity::Blocker },
        code: "metadata.uri".into(),
        message: if valid {
            "Canonical metadata URI is persisted in the launch record.".into()
        } else {
            "Persist an HTTPS or IPFS metadata URI of at most 200 characters before rehearsal."
                .into()
        },
    });
}

fn valid_solana_address_syntax(value: &str) -> bool {
    let mut decoded = [0_u8; 32];
    (32..=44).contains(&value.len())
        && bs58::decode(value)
            .onto(&mut decoded)
            .is_ok_and(|length| length == decoded.len())
}

fn nonempty(value: &str) -> bool {
    !value.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_json() -> Value {
        serde_json::json!({
            "schema": "neal.launch-control/v1",
            "status": "planned",
            "canonicalRoute": "pumpfun",
            "network": "solana",
            "token": {
                "name": "Neal the Seal",
                "symbol": "NEAL",
                "metadataUri": "https://example.invalid/token-metadata.json",
                "imagePath": "assets/token.png",
                "bannerPath": null,
                "bannerUrl": null,
                "description": "A community meme token with transparent launch records.",
                "website": "https://example.invalid",
                "socialLinks": []
            },
            "pumpfun": {
                "quoteAsset": "SOL",
                "mayhemMode": false,
                "cashBack": false,
                "creatorWallet": "11111111111111111111111111111111",
                "creatorFeeRecipient": "11111111111111111111111111111111",
                "initialCreatorPurchaseLamports": "0",
                "initialCreatorPurchaseSol": null,
                "launchAt": "2026-09-01T18:00:00Z"
            },
            "programs": {
                "genesisAllocationAvailable": false,
                "economics": {
                    "devPurchase": {
                        "method": "pumpfun_market_buy",
                        "wallet": null,
                        "transactions": []
                    },
                    "questTreasury": {
                        "creatorFeeShareBasisPoints": 4200,
                        "purchaseMethod": "creator_fee_funded_market_buybacks",
                        "wallet": null,
                        "purposes": [
                            "quest_rewards",
                            "open_source_developer_airdrops"
                        ],
                        "openSourceDeveloperAirdrops": {
                            "acquisitionMethod": "market_buy",
                            "maxHoldingsSupplyBasisPoints": 1800,
                            "capMeasurement": "airdrop_earmarked_balance_at_finalized_supply",
                            "capOverrideApproval": "unanimous_neal_holder_approval",
                            "eligibilityPolicyUri": null,
                            "distributions": []
                        },
                        "transactions": []
                    },
                    "creatorFeeRouting": {
                        "method": "pump_fee_sharing_v2",
                        "status": "planned",
                        "configurationAddress": null,
                        "createTransaction": null,
                        "finalizeTransaction": null,
                        "finalUpdateIsImmutable": true,
                        "preActivationPolicy": "manual_pro_rata_sweep",
                        "shares": [
                            {
                                "role": "dev",
                                "shareBasisPoints": 5800,
                                "wallet": "11111111111111111111111111111111"
                            },
                            {
                                "role": "quest_treasury",
                                "shareBasisPoints": 4200,
                                "wallet": null
                            }
                        ]
                    }
                },
                "communitySuggestions": {
                    "entryFeeTokens": "1",
                    "acceptedEntryAssets": [
                        {
                            "symbol": "NEAL",
                            "amountTokens": "1",
                            "canonicalMintSource": "execution.mintAddress"
                        },
                        {
                            "symbol": "DREGG",
                            "amountTokens": "1",
                            "canonicalMintSource": "secondaryLiquidity.quoteMint"
                        }
                    ],
                    "destination": "quest_treasury",
                    "registryUri": null,
                    "status": "pre_launch"
                },
                "yahoos": {
                    "dailyFreePerWallet": 3,
                    "dailyWindow": "solana_clock_utc_day",
                    "paidPriceNumerator": "1",
                    "paidPriceDenominator": "10",
                    "acceptedPaymentAssets": [
                        {
                            "symbol": "NEAL",
                            "amountTokens": "0.1",
                            "canonicalMintSource": "execution.mintAddress"
                        },
                        {
                            "symbol": "DREGG",
                            "amountTokens": "0.1",
                            "canonicalMintSource": "secondaryLiquidity.quoteMint"
                        }
                    ],
                    "fastestConsecutiveCount": 3,
                    "peakRateWindowSeconds": 60,
                    "programId": null,
                    "leaderboardRegistryUri": "/yahoo-leaderboard.json",
                    "status": "pre_launch"
                },
                "fundingMethod": "market_purchases_only",
                "fundedInventory": null
            },
            "secondaryLiquidity": {
                "enabledAtLaunch": false,
                "plannedQuoteSymbol": "DREGG",
                "quoteMint": null,
                "status": "deferred"
            },
            "execution": {
                "mintAddress": null,
                "creationTransaction": null,
                "finalHumanWalletReviewRequired": true
            }
        })
    }

    #[test]
    fn ready_contract_has_no_blockers() {
        let control: LaunchControl = serde_json::from_value(config_json()).unwrap();
        let report = control.readiness_report();
        assert!(report.ready);
        assert_eq!(report.blocker_count, 0);
    }

    #[test]
    fn missing_launch_decisions_are_blockers() {
        let mut json = config_json();
        json["token"]["imagePath"] = Value::Null;
        json["pumpfun"]["cashBack"] = Value::Null;
        json["pumpfun"]["initialCreatorPurchaseLamports"] = Value::Null;
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(!report.ready);
        assert!(report.blocker_count >= 3);
    }

    #[test]
    fn older_contract_without_metadata_uri_still_parses_but_blocks() {
        let mut json = config_json();
        json["token"].as_object_mut().unwrap().remove("metadataUri");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "metadata.uri" && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn banner_path_without_hosted_url_is_a_blocker() {
        let mut json = config_json();
        json["token"]["bannerPath"] = serde_json::json!("assets/banner.jpg");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "metadata.banner" && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn legacy_sol_amount_requires_integer_migration() {
        let mut json = config_json();
        json["pumpfun"]["initialCreatorPurchaseLamports"] = Value::Null;
        json["pumpfun"]["initialCreatorPurchaseSol"] = serde_json::json!(0.1);
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "pumpfun.initial_purchase" && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn missing_economics_plan_still_parses_but_blocks() {
        let mut json = config_json();
        json["programs"]
            .as_object_mut()
            .unwrap()
            .remove("economics");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.economics" && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn planned_creator_fee_split_waits_for_quest_wallet_without_blocking_launch() {
        let control: LaunchControl = serde_json::from_value(config_json()).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.creator_fee_routing" && check.severity == Severity::Warning
        }));
    }

    #[test]
    fn invalid_creator_fee_split_is_a_blocker() {
        let mut json = config_json();
        json["programs"]["economics"]["creatorFeeRouting"]["shares"][0]["shareBasisPoints"] =
            serde_json::json!(5_900);
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.creator_fee_routing" && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn invalid_open_source_airdrop_holdings_cap_is_a_blocker() {
        let mut json = config_json();
        json["programs"]["economics"]["questTreasury"]["openSourceDeveloperAirdrops"]["maxHoldingsSupplyBasisPoints"] =
            serde_json::json!(1_900);
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.open_source_developer_airdrops"
                && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn non_unanimous_airdrop_cap_override_is_a_blocker() {
        let mut json = config_json();
        json["programs"]["economics"]["questTreasury"]["openSourceDeveloperAirdrops"]["capOverrideApproval"] =
            serde_json::json!("simple_majority");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.open_source_developer_airdrops"
                && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn older_contract_without_airdrop_fields_still_parses_and_warns() {
        let mut json = config_json();
        let treasury = json["programs"]["economics"]["questTreasury"]
            .as_object_mut()
            .unwrap();
        treasury.remove("purposes");
        treasury.remove("openSourceDeveloperAirdrops");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.open_source_developer_airdrops"
                && check.severity == Severity::Warning
        }));
    }

    #[test]
    fn older_contract_without_creator_fee_routing_still_parses_and_warns() {
        let mut json = config_json();
        json["programs"]["economics"]
            .as_object_mut()
            .unwrap()
            .remove("creatorFeeRouting");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.creator_fee_routing" && check.severity == Severity::Warning
        }));
    }

    #[test]
    fn community_suggestion_rule_is_exact() {
        let mut json = config_json();
        json["programs"]["communitySuggestions"]["entryFeeTokens"] = serde_json::json!("2");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.community_suggestions" && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn community_suggestion_assets_are_exact() {
        let mut json = config_json();
        json["programs"]["communitySuggestions"]["acceptedEntryAssets"][1]["amountTokens"] =
            serde_json::json!("2");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.suggestion_assets" && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn legacy_neal_only_suggestion_rule_still_parses_and_warns() {
        let mut json = config_json();
        json["programs"]["communitySuggestions"]
            .as_object_mut()
            .unwrap()
            .remove("acceptedEntryAssets");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.suggestion_assets" && check.severity == Severity::Warning
        }));
    }

    #[test]
    fn yahoo_policy_is_exact() {
        let mut json = config_json();
        json["programs"]["yahoos"]["dailyFreePerWallet"] = serde_json::json!(4);
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.yahoos" && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn local_free_yahoos_are_valid_while_future_policy_is_undecided() {
        let mut json = config_json();
        json["programs"]["yahoos"]["localMode"] = serde_json::json!({
            "enabled": true,
            "storage": "browser_local_storage",
            "price": "free",
            "rankingScope": "this_browser"
        });
        json["programs"]["yahoos"]["futureOnChainPolicyStatus"] = serde_json::json!("undecided");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(
            report.checks.iter().any(|check| {
                check.code == "programs.yahoos" && check.severity == Severity::Pass
            })
        );
    }

    #[test]
    fn older_contract_without_yahoos_still_parses_and_warns() {
        let mut json = config_json();
        json["programs"].as_object_mut().unwrap().remove("yahoos");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.yahoos" && check.severity == Severity::Warning
        }));
    }

    #[test]
    fn older_yahoo_policy_defaults_peak_rate_window() {
        let mut json = config_json();
        json["programs"]["yahoos"]
            .as_object_mut()
            .unwrap()
            .remove("peakRateWindowSeconds");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(
            report.checks.iter().any(|check| {
                check.code == "programs.yahoos" && check.severity == Severity::Pass
            })
        );
    }

    #[test]
    fn older_contract_without_suggestion_rule_still_parses_but_blocks() {
        let mut json = config_json();
        json["programs"]
            .as_object_mut()
            .unwrap()
            .remove("communitySuggestions");
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.community_suggestions" && check.severity == Severity::Blocker
        }));
    }

    #[test]
    fn legacy_percentage_targets_remain_readable_but_warn() {
        let mut json = config_json();
        json["programs"]["previousTargetBasisPoints"] =
            serde_json::json!({ "publicLaunch": 5000, "quests": 4200, "airdrop": 800 });
        json["programs"]["currentTargetBasisPoints"] = serde_json::json!({
            "publicLaunch": 4200,
            "founderPurchase": 800,
            "quests": 4200,
            "airdrop": 800
        });
        let control: LaunchControl = serde_json::from_value(json).unwrap();
        let report = control.readiness_report();
        assert!(report.checks.iter().any(|check| {
            check.code == "programs.legacy_targets" && check.severity == Severity::Warning
        }));
    }
}
