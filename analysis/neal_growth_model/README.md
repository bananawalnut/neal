# NEAL growth, trading, fees, and market-cap model

This is the reproducible Python replacement for the earlier spreadsheet model. It uses NumPy for calibration and Monte Carlo simulation and pandas DataFrames for every published table.

## Run it

Create an isolated Python environment and install the pinned dependency ranges:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r analysis/neal_growth_model/requirements.txt
python analysis/neal_growth_model/neal_growth_model.py
```

Run the tests:

```bash
python -m unittest discover -s analysis/neal_growth_model/tests -v
```

The default run uses 20,000 paths per scenario and a fixed seed. Change assumptions in `config.json`; command-line options can override the output directory, path count, and seed.

## What is modeled

- The user-supplied 22-buyer Day-3 and 100-buyer Day-7 values are planning constraints. Every Monte Carlo path is multinomial-bridged through both milestones exactly.
- Four post-Day-7 buyer processes are compared: incidence-exponential, strict-zero logistic, cumulative-stock growth stress, and an overdispersed delayed referral-renewal process.
- Prior buyers can participate again according to an age-dependent daily repeat-participation probability. This permits reactivation and is not survival retention.
- Each new buyer generates a buy-side acquisition transaction. Additional activity is overdispersed, and requested transaction sizes are Gamma-distributed with a $20 arithmetic mean.
- Completed daily-candle volume is treated as uniform inside that candle. This supports hourly equivalents and fractional target times, but does not assert a uniform intraday price path.
- Creator, protocol, and LP fees are assessed on executed gross turnover. Excess net sell flow that cannot execute at the curve floor is recorded as unfilled and earns no fees.
- Before graduation, signed executed flow moves a constant-product reserve proxy. After graduation, market cap freezes at the migration boundary because a defensible PumpSwap liquidity/depth input is not available.
- Primary simulations therefore remain at the documented 0.30% creator fee after graduation. A separate 0.95% all-future-volume row is retained only as an arithmetic upper-fee sensitivity; it is not a feasible pre-graduation path.
- Creator fees are tracked in SOL and converted to USD-at-accrual at the fixed SOL/USD scenario rate in `config.json`.

## Core arithmetic

At a constant 0.30% creator fee, $5,000 requires:

```text
gross volume = 5,000 / 0.003 = $1,666,666.67
transactions = 1,666,666.67 / $20 = 83,333.33 transaction equivalents
```

The two completed candles contribute their observed volume and approximately $3.18 of creator fees, leaving about 83,280 additional $20 transaction equivalents at 0.30%.

Buyer count alone cannot determine fees. The target frontier therefore reports the joint requirement in terms of:

1. cumulative buyers by Day 14;
2. buyer growth after Day 7;
3. daily repeat participation; and
4. requested transactions per active buyer-day.

Market cap is not cumulative cash invested. Before graduation the proxy is:

```text
token reserve = invariant / virtual SOL reserve
market cap USD = (virtual SOL reserve / token reserve) × 1,000,000,000 × SOL/USD
```

Gross volume drives fees; signed buy-minus-sell flow drives the reserve and market-cap proxy.

## Outputs

The `outputs/` directory contains:

- `report.html`: self-contained decision report with native SVG charts;
- `scenario_summary.csv`: compact Day-14 and Day-21 scenario results;
- `daily_simulation_summary.csv`: means and p05/p25/p50/p75/p95 bands by day;
- `target_frontier.csv`: buyer-growth versus trading-intensity backsolve at 0.30% and the labeled 0.95% sensitivity;
- `probability_sweep.csv`: Monte Carlo target odds across each scenario's trade-intensity grid;
- `activity_thresholds.csv`: interpolated 50%, 80%, and 90% target-hit activity requirements;
- `observed_candles.csv`: completed-candle inputs and identifiable arithmetic only;
- `scenario_assumptions.csv`: flattened assumptions for review;
- `diffusion_comparison.csv`: deterministic comparison curves;
- `milestone_report.csv`: proof that every path hits the planning milestones;
- `calibration_report.csv`: fitted parameters and residuals;
- `validation_checks.csv`: numerical and accounting invariants; and
- `run_metadata.json`: seed, versions, path count, and validation status.

## Interpretation limits

Two buyer targets do not identify saturation, causal virality, referral reproduction, repeat participation, dispersion, trading intensity, or buy/sell propensity. The percentile bands are conditional on scenario assumptions and process noise; they are not parameter-confidence intervals. Volume cannot identify unique buyers without wallet-level data, and the model is not financial advice.
