#!/usr/bin/env python3
"""NEAL social-spread, trading, fee, and bonding-curve scenario model.

The model is intentionally dependency-light: NumPy provides numerical and random
simulation primitives, pandas provides every published table, and the HTML report
uses small native SVG charts.  The two buyer milestones are calibration constraints,
not enough evidence to estimate a unique diffusion process.
"""

from __future__ import annotations

import argparse
import html
import json
import math
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np
import pandas as pd


QUANTILES = (0.05, 0.25, 0.50, 0.75, 0.95)
QUANTILE_LABELS = ("p05", "p25", "p50", "p75", "p95")
COLORS = ("#2A9D8F", "#D9A441", "#2563EB", "#B42318", "#7C3AED", "#64748B")


@dataclass(frozen=True)
class Calibration:
    model: str
    parameters: dict[str, float]
    expected_new: np.ndarray
    expected_cumulative: np.ndarray
    notes: str


@dataclass(frozen=True)
class SimulationResult:
    scenario: dict[str, Any]
    calibration: Calibration
    new_buyers: np.ndarray
    cumulative_buyers: np.ndarray
    returning_buyers: np.ndarray
    active_buyers: np.ndarray
    transactions: np.ndarray
    requested_volume_usd: np.ndarray
    acquisition_volume_usd: np.ndarray
    gross_volume_usd: np.ndarray
    buy_volume_usd: np.ndarray
    sell_volume_usd: np.ndarray
    unfilled_sell_volume_usd: np.ndarray
    signed_flow_usd: np.ndarray
    curve_signed_flow_usd: np.ndarray
    creator_fees_usd: np.ndarray
    creator_fees_sol: np.ndarray
    protocol_fees_usd: np.ndarray
    lp_fees_usd: np.ndarray
    total_fees_usd: np.ndarray
    treasury_accrual_usd: np.ndarray
    dev_accrual_usd: np.ndarray
    creator_fee_rate: np.ndarray
    market_cap_proxy_usd: np.ndarray
    virtual_sol_reserve: np.ndarray
    virtual_token_reserve: np.ndarray
    graduated: np.ndarray
    curve_floor_hit: np.ndarray
    graduation_fraction_in_day: np.ndarray
    target_hit_day: np.ndarray
    graduation_day: np.ndarray
    invariant_relative_error: np.ndarray


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    validate_config(config)
    return config


def validate_config(config: dict[str, Any]) -> None:
    horizon = int(config["horizon_days"])
    report_day = int(config["report_day"])
    if horizon < 21 or report_day != 14:
        raise ValueError("this three-week model requires horizon_days >= 21 and report_day == 14")
    d3 = float(config["milestones"]["day_3_cumulative_buyers"])
    d7 = float(config["milestones"]["day_7_cumulative_buyers"])
    if not 0 < d3 < d7:
        raise ValueError("buyer milestones must satisfy 0 < Day 3 < Day 7")
    if bool(config["milestones"].get("condition_simulated_paths", False)) and (
        not d3.is_integer() or not d7.is_integer()
    ):
        raise ValueError("conditioned buyer milestones must be integer people")
    if len(config["historical_daily"]) != 2:
        raise ValueError("historical_daily must contain launch Days 1 and 2")
    historical_days = [int(row["day"]) for row in config["historical_daily"]]
    if historical_days != [1, 2]:
        raise ValueError("historical_daily rows must be ordered launch Days 1 and 2")
    launch = date.fromisoformat(config["launch_date"])
    expected_dates = [launch.isoformat(), (launch + timedelta(days=1)).isoformat()]
    historical_dates = [row["date"] for row in config["historical_daily"]]
    if historical_dates != expected_dates:
        raise ValueError("historical_daily dates must equal launch Day 1 and Day 2")
    positive_values = {
        "average_transaction_usd": config["trading"]["average_transaction_usd"],
        "transaction_size_cv": config["trading"]["transaction_size_cv"],
        "target_creator_fees_usd": config["trading"]["target_creator_fees_usd"],
        "token_supply": config["market"]["token_supply"],
        "sol_usd": config["market"]["sol_usd"],
        "virtual_sol_start": config["market"]["virtual_sol_start"],
        "virtual_token_start": config["market"]["virtual_token_start"],
        "virtual_sol_floor": config["market"]["virtual_sol_floor"],
        "graduation_real_sol": config["market"]["graduation_real_sol"],
        "net_flow_capture": config["market"]["net_flow_capture"],
    }
    for name, value in positive_values.items():
        if float(value) <= 0:
            raise ValueError(f"{name} must be positive")
    treasury_share = float(config["trading"]["treasury_share_of_creator_fee"])
    if not 0 <= treasury_share <= 1:
        raise ValueError("treasury_share_of_creator_fee must be in [0, 1]")
    q_start = float(config["market"]["virtual_sol_start"])
    q_floor = float(config["market"]["virtual_sol_floor"])
    q_grad = q_floor + float(config["market"]["graduation_real_sol"])
    real_sol_start = float(config["market"]["real_sol_start"])
    if not q_floor <= q_start <= q_grad:
        raise ValueError("virtual SOL reserves must satisfy floor <= start <= graduation")
    if not math.isclose(q_start - q_floor, real_sol_start, rel_tol=0.0, abs_tol=1e-8):
        raise ValueError("real_sol_start must equal virtual_sol_start - virtual_sol_floor")
    for profile_name in (
        "curve_fee_profile",
        "post_grad_low_tier_profile",
        "post_grad_bonus_tier_profile",
    ):
        profile = config["trading"][profile_name]
        for component in ("creator", "protocol", "lp", "total"):
            if not 0 <= float(profile[component]) <= 1:
                raise ValueError(f"fee profile {profile_name!r} contains an invalid rate")
        component_sum = float(profile["creator"]) + float(profile["protocol"]) + float(profile["lp"])
        if not math.isclose(component_sum, float(profile["total"]), rel_tol=0.0, abs_tol=1e-12):
            raise ValueError(f"fee profile {profile_name!r} does not add to total")
    names = [item["name"] for item in config["scenarios"]]
    if len(names) != len(set(names)):
        raise ValueError("scenario names must be unique")
    sweep = config["probability_sweep"]
    if int(sweep["simulations"]) < 100:
        raise ValueError("probability_sweep simulations must be at least 100")
    sweep_probabilities = np.asarray(sweep["target_probabilities"], dtype=float)
    if np.any((sweep_probabilities <= 0) | (sweep_probabilities >= 1)):
        raise ValueError("probability_sweep target probabilities must be between 0 and 1")
    if set(sweep["trades_per_active_grid"]) != set(names):
        raise ValueError("probability_sweep must define a grid for every scenario")
    for scenario in config["scenarios"]:
        for field in ("daily_repeat_participation_probability", "buy_share_mean"):
            if not 0 <= float(scenario[field]) <= 1:
                raise ValueError(f"{scenario['name']}: {field} must be in [0, 1]")
        for field in (
            "buyer_dispersion",
            "trades_per_active_buyer",
            "activity_shape",
            "buy_share_concentration",
        ):
            if float(scenario[field]) <= 0:
                raise ValueError(f"{scenario['name']}: {field} must be positive")
        if float(scenario["trades_per_active_buyer"]) < 1:
            raise ValueError(f"{scenario['name']}: trades_per_active_buyer must be at least 1")
        if float(scenario["participation_age_decay"]) < 0:
            raise ValueError(f"{scenario['name']}: participation_age_decay cannot be negative")
        if scenario["post_grad_fee_profile"] not in config["trading"]:
            raise ValueError(f"{scenario['name']}: unknown post-grad fee profile")
        trade_grid = np.asarray(
            sweep["trades_per_active_grid"][scenario["name"]],
            dtype=float,
        )
        if trade_grid.size < 2 or np.any(trade_grid < 1) or np.any(np.diff(trade_grid) <= 0):
            raise ValueError(
                f"{scenario['name']}: probability-sweep trade grid must be increasing and >= 1"
            )
        if scenario["diffusion"] == "logistic" and float(scenario["carrying_capacity"]) <= d7:
            raise ValueError(f"{scenario['name']}: carrying_capacity must exceed Day-7 buyers")
        if scenario["diffusion"] == "branching":
            weights = np.asarray(scenario["referral_delay_weights"], dtype=float)
            if np.any(weights < 0) or not math.isclose(float(weights.sum()), 1.0, abs_tol=1e-12):
                raise ValueError(f"{scenario['name']}: referral_delay_weights must be nonnegative and sum to 1")


def bisection(
    func: Callable[[float], float],
    lower: float,
    upper: float,
    *,
    tolerance: float = 1e-12,
    iterations: int = 250,
) -> float:
    f_lower = func(lower)
    f_upper = func(upper)
    if not (math.isfinite(f_lower) and math.isfinite(f_upper)):
        raise ValueError("non-finite bisection endpoint")
    if f_lower == 0:
        return lower
    if f_upper == 0:
        return upper
    if f_lower * f_upper > 0:
        raise ValueError(f"root is not bracketed: f(lower)={f_lower}, f(upper)={f_upper}")
    lo, hi = lower, upper
    for _ in range(iterations):
        mid = (lo + hi) / 2.0
        f_mid = func(mid)
        if abs(f_mid) <= tolerance or abs(hi - lo) <= tolerance:
            return mid
        if f_lower * f_mid <= 0:
            hi = mid
            f_upper = f_mid
        else:
            lo = mid
            f_lower = f_mid
    return (lo + hi) / 2.0


def incidence_exponential_calibration(config: dict[str, Any]) -> Calibration:
    """Fit geometric daily incidence to the two non-overlapping interval totals.

    Days 1-3 total 22 buyers and Days 4-7 total another 78.  This respects the
    fact that cumulative Day-3 and Day-7 totals are not independent observations.
    """

    horizon = int(config["horizon_days"])
    d3 = float(config["milestones"]["day_3_cumulative_buyers"])
    d7 = float(config["milestones"]["day_7_cumulative_buyers"])
    interval_2 = d7 - d3

    def objective(multiplier: float) -> float:
        first = sum(multiplier**i for i in range(3))
        second = sum(multiplier**i for i in range(3, 7))
        return d3 * second / first - interval_2

    multiplier = bisection(objective, 1.0000001, 5.0)
    alpha = d3 / sum(multiplier**i for i in range(3))
    expected_new = alpha * multiplier ** np.arange(horizon, dtype=float)
    expected_cumulative = np.cumsum(expected_new)
    return Calibration(
        model="incidence_exponential",
        parameters={
            "day_1_incidence": float(alpha),
            "daily_incidence_multiplier": float(multiplier),
            "daily_incidence_growth": float(multiplier - 1.0),
        },
        expected_new=expected_new,
        expected_cumulative=expected_cumulative,
        notes="Negative-binomial daily incidence baseline; calibrated to 22 buyers on Days 1-3 and 78 on Days 4-7.",
    )


def stock_exponential_calibration(config: dict[str, Any]) -> Calibration:
    """No-saturation stress curve fitted directly to cumulative Day-3/Day-7 stocks."""

    horizon = int(config["horizon_days"])
    d3 = float(config["milestones"]["day_3_cumulative_buyers"])
    d7 = float(config["milestones"]["day_7_cumulative_buyers"])
    growth = (d7 / d3) ** (1.0 / 4.0) - 1.0
    days = np.arange(1, horizon + 1, dtype=float)
    expected_cumulative = d3 * (1.0 + growth) ** (days - 3.0)
    expected_cumulative[:2] = np.minimum(expected_cumulative[:2], d3 * np.array([1 / 3, 2 / 3]))
    expected_cumulative[2] = d3
    expected_new = np.diff(np.concatenate(([0.0], expected_cumulative)))
    return Calibration(
        model="stock_exponential",
        parameters={
            "daily_cumulative_growth": float(growth),
            "doubling_days": float(math.log(2.0) / math.log1p(growth)),
        },
        expected_new=expected_new,
        expected_cumulative=expected_cumulative,
        notes="No-saturation stress case fitted to cumulative stocks; it is not the preferred statistical baseline.",
    )


def shifted_logistic_calibration(config: dict[str, Any], carrying_capacity: float) -> Calibration:
    """Strict-zero logistic curve conditional on a fixed carrying capacity."""

    horizon = int(config["horizon_days"])
    d3 = float(config["milestones"]["day_3_cumulative_buyers"])
    d7 = float(config["milestones"]["day_7_cumulative_buyers"])
    capacity = float(carrying_capacity)
    if capacity <= d7:
        raise ValueError("logistic capacity must exceed the Day-7 milestone")

    def equation(rate: float) -> float:
        lhs = math.exp(3.0 * rate) * (capacity / d3 - 1.0) - capacity / d3
        rhs = math.exp(7.0 * rate) * (capacity / d7 - 1.0) - capacity / d7
        return lhs - rhs

    grid = np.linspace(1e-5, 3.0, 12000)
    values = np.asarray([equation(float(value)) for value in grid])
    brackets: list[tuple[float, float]] = []
    for left, right, f_left, f_right in zip(grid[:-1], grid[1:], values[:-1], values[1:]):
        if f_left * f_right < 0:
            brackets.append((float(left), float(right)))
    if not brackets:
        raise ValueError(f"could not bracket shifted-logistic rate for K={capacity}")
    rate = bisection(equation, *brackets[-1])
    a_parameter = math.exp(3.0 * rate) * (capacity / d3 - 1.0) - capacity / d3
    days = np.arange(1, horizon + 1, dtype=float)
    exp_term = np.exp(rate * days)
    expected_cumulative = capacity * (exp_term - 1.0) / (a_parameter + exp_term)
    expected_new = np.diff(np.concatenate(([0.0], expected_cumulative)))
    return Calibration(
        model="shifted_logistic",
        parameters={
            "carrying_capacity": capacity,
            "intrinsic_rate": float(rate),
            "shift_parameter": float(a_parameter),
        },
        expected_new=expected_new,
        expected_cumulative=expected_cumulative,
        notes="Strict-zero logistic curve. Capacity is a scenario assumption; two milestones cannot estimate it.",
    )


def _branching_expected_path(
    horizon: int,
    seed_day_1: float,
    reproduction: float,
    external_per_day: float,
    delay_weights: np.ndarray,
    carrying_capacity: float,
) -> tuple[np.ndarray, np.ndarray]:
    new = np.zeros(horizon, dtype=float)
    cumulative = np.zeros(horizon, dtype=float)
    new[0] = min(seed_day_1, carrying_capacity)
    cumulative[0] = new[0]
    for t in range(1, horizon):
        weighted_referrers = 0.0
        for lag, weight in enumerate(delay_weights, start=1):
            if t - lag >= 0:
                weighted_referrers += float(weight) * new[t - lag]
        saturation = max(0.0, 1.0 - cumulative[t - 1] / carrying_capacity)
        mean_new = external_per_day + reproduction * weighted_referrers * saturation
        new[t] = min(max(mean_new, 0.0), carrying_capacity - cumulative[t - 1])
        cumulative[t] = cumulative[t - 1] + new[t]
    return new, cumulative


def branching_calibration(config: dict[str, Any], scenario: dict[str, Any]) -> Calibration:
    """Fit seed incidence and reproduction conditional on fixed delay/K/external assumptions."""

    horizon = int(config["horizon_days"])
    d3 = float(config["milestones"]["day_3_cumulative_buyers"])
    d7 = float(config["milestones"]["day_7_cumulative_buyers"])
    capacity = float(scenario["carrying_capacity"])
    external = float(scenario.get("external_buyers_per_day", 0.0))
    weights = np.asarray(scenario["referral_delay_weights"], dtype=float)

    def seed_for_reproduction(reproduction: float) -> float:
        def day3_residual(seed: float) -> float:
            _, cumulative = _branching_expected_path(
                horizon, seed, reproduction, external, weights, capacity
            )
            return float(cumulative[2] - d3)

        return bisection(day3_residual, 1e-9, min(capacity, d3 * 10.0))

    def day7_residual(reproduction: float) -> float:
        seed = seed_for_reproduction(reproduction)
        _, cumulative = _branching_expected_path(
            horizon, seed, reproduction, external, weights, capacity
        )
        return float(cumulative[6] - d7)

    scan = np.geomspace(0.01, 20.0, 600)
    residuals = []
    for reproduction in scan:
        try:
            residuals.append(day7_residual(float(reproduction)))
        except ValueError:
            residuals.append(np.nan)
    bracket = None
    for left, right, f_left, f_right in zip(scan[:-1], scan[1:], residuals[:-1], residuals[1:]):
        if np.isfinite(f_left) and np.isfinite(f_right) and f_left * f_right < 0:
            bracket = (float(left), float(right))
            break
    if bracket is None:
        raise ValueError(f"could not bracket branching reproduction for {scenario['name']}")
    reproduction = bisection(day7_residual, *bracket, tolerance=1e-10)
    seed = seed_for_reproduction(reproduction)
    expected_new, expected_cumulative = _branching_expected_path(
        horizon, seed, reproduction, external, weights, capacity
    )
    return Calibration(
        model="referral_renewal_mean_field",
        parameters={
            "carrying_capacity": capacity,
            "seed_day_1": float(seed),
            "reproduction_per_weighted_referrer": float(reproduction),
            "external_buyers_per_day": external,
            "mean_referral_delay_days": float(np.dot(weights, np.arange(1, len(weights) + 1))),
        },
        expected_new=expected_new,
        expected_cumulative=expected_cumulative,
        notes=(
            "Overdispersed referral-renewal mean field calibrated conditional on fixed "
            "capacity, delay weights, and external arrivals; it is not an individual-offspring tree."
        ),
    )


def calibration_for_scenario(config: dict[str, Any], scenario: dict[str, Any]) -> Calibration:
    diffusion = scenario["diffusion"]
    if diffusion == "incidence_exponential":
        return incidence_exponential_calibration(config)
    if diffusion == "stock_exponential":
        return stock_exponential_calibration(config)
    if diffusion == "logistic":
        return shifted_logistic_calibration(config, float(scenario["carrying_capacity"]))
    if diffusion == "branching":
        return branching_calibration(config, scenario)
    raise ValueError(f"unsupported diffusion model: {diffusion}")


def gamma_poisson(
    rng: np.random.Generator,
    mean: np.ndarray | float,
    dispersion: float,
) -> np.ndarray:
    """Negative-binomial draw via Gamma-Poisson mixture for stable float dispersion."""

    mean_array = np.asarray(mean, dtype=float)
    output = np.zeros(mean_array.shape, dtype=np.int64)
    positive = mean_array > 0
    if np.any(positive):
        lam = rng.gamma(shape=dispersion, scale=mean_array[positive] / dispersion)
        output[positive] = rng.poisson(lam)
    return output


def conditioned_milestone_bridge(
    rng: np.random.Generator,
    expected_new: np.ndarray,
    simulations: int,
    day_3_total: int,
    day_7_total: int,
) -> np.ndarray:
    """Allocate fixed milestone totals across their component launch days.

    This is a multinomial bridge: each path contains exactly ``day_3_total``
    buyers over Days 1--3 and exactly the incremental Day-4--7 total thereafter,
    while the calibrated incidence curve controls their within-window timing.
    """

    if expected_new.size < 7:
        raise ValueError("milestone bridge requires at least seven expected-incidence days")
    first_weights = np.asarray(expected_new[:3], dtype=float)
    second_weights = np.asarray(expected_new[3:7], dtype=float)
    if np.any(first_weights < 0) or np.any(second_weights < 0):
        raise ValueError("milestone bridge weights cannot be negative")
    first_probabilities = first_weights / first_weights.sum()
    second_probabilities = second_weights / second_weights.sum()
    bridged = np.zeros((simulations, expected_new.size), dtype=np.int64)
    bridged[:, :3] = rng.multinomial(day_3_total, first_probabilities, size=simulations)
    bridged[:, 3:7] = rng.multinomial(
        day_7_total - day_3_total,
        second_probabilities,
        size=simulations,
    )
    return bridged


def simulate_buyers(
    config: dict[str, Any],
    scenario: dict[str, Any],
    calibration: Calibration,
    simulations: int,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
    horizon = int(config["horizon_days"])
    dispersion = float(scenario["buyer_dispersion"])
    new_buyers = np.zeros((simulations, horizon), dtype=np.int64)
    capacity = scenario.get("carrying_capacity")
    condition_paths = bool(config["milestones"].get("condition_simulated_paths", False))
    start_day = 0
    if condition_paths:
        new_buyers = conditioned_milestone_bridge(
            rng,
            calibration.expected_new,
            simulations,
            int(config["milestones"]["day_3_cumulative_buyers"]),
            int(config["milestones"]["day_7_cumulative_buyers"]),
        )
        start_day = 7

    if scenario["diffusion"] != "branching":
        for t in range(start_day, horizon):
            draws = gamma_poisson(
                rng,
                np.full(simulations, calibration.expected_new[t], dtype=float),
                dispersion,
            )
            if capacity is not None:
                prior = new_buyers[:, :t].sum(axis=1) if t else np.zeros(simulations, dtype=np.int64)
                draws = np.minimum(draws, np.maximum(0, int(capacity) - prior))
            new_buyers[:, t] = draws
        return new_buyers, np.cumsum(new_buyers, axis=1)

    weights = np.asarray(scenario["referral_delay_weights"], dtype=float)
    reproduction = calibration.parameters["reproduction_per_weighted_referrer"]
    external = calibration.parameters["external_buyers_per_day"]
    seed = calibration.parameters["seed_day_1"]
    cap = int(float(scenario["carrying_capacity"]))
    cumulative = np.zeros_like(new_buyers)
    if condition_paths:
        cumulative[:, :7] = np.cumsum(new_buyers[:, :7], axis=1)
    else:
        new_buyers[:, 0] = gamma_poisson(rng, np.full(simulations, seed), dispersion)
        new_buyers[:, 0] = np.minimum(new_buyers[:, 0], cap)
        cumulative[:, 0] = new_buyers[:, 0]
    for t in range(max(1, start_day), horizon):
        weighted_referrers = np.zeros(simulations, dtype=float)
        for lag, weight in enumerate(weights, start=1):
            if t - lag >= 0:
                weighted_referrers += float(weight) * new_buyers[:, t - lag]
        saturation = np.maximum(0.0, 1.0 - cumulative[:, t - 1] / cap)
        mean_new = external + reproduction * weighted_referrers * saturation
        draws = gamma_poisson(rng, mean_new, dispersion)
        draws = np.minimum(draws, np.maximum(0, cap - cumulative[:, t - 1]))
        new_buyers[:, t] = draws
        cumulative[:, t] = cumulative[:, t - 1] + draws
    return new_buyers, cumulative


def simulate_activity(
    new_buyers: np.ndarray,
    scenario: dict[str, Any],
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
    """Simulate age-dependent repeat participation, allowing reactivation.

    This is intentionally not survival/retention: a prior buyer may skip a day
    and trade again later.  ``participation_age_decay`` controls how daily
    participation probability falls with cohort age.
    """

    simulations, horizon = new_buyers.shape
    returning = np.zeros_like(new_buyers)
    base_return = float(scenario["daily_repeat_participation_probability"])
    decay = float(scenario["participation_age_decay"])
    for t in range(horizon):
        for cohort_day in range(t):
            age = t - cohort_day
            probability = float(np.clip(base_return * math.exp(-decay * (age - 1)), 0.0, 1.0))
            returning[:, t] += rng.binomial(new_buyers[:, cohort_day], probability)
    active = new_buyers + returning
    return returning, active


def simulate_transactions_and_volume(
    config: dict[str, Any],
    scenario: dict[str, Any],
    new_buyers: np.ndarray,
    active_buyers: np.ndarray,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    simulations, horizon = new_buyers.shape
    trading = config["trading"]
    mean_ticket = float(trading["average_transaction_usd"])
    ticket_cv = float(trading["transaction_size_cv"])
    trades_per_active = float(scenario["trades_per_active_buyer"])
    activity_shape = float(scenario["activity_shape"])
    transactions = np.zeros((simulations, horizon), dtype=float)
    volume = np.zeros((simulations, horizon), dtype=float)
    acquisition_volume = np.zeros((simulations, horizon), dtype=float)

    for t, historical in enumerate(config["historical_daily"]):
        historical_volume = float(historical["volume_usd"])
        volume[:, t] = historical_volume
        transactions[:, t] = historical_volume / mean_ticket

    gamma_shape_per_trade = 1.0 / (ticket_cv**2)
    gamma_scale = mean_ticket * ticket_cv**2
    for t in range(2, horizon):
        activity_multiplier = rng.gamma(
            shape=activity_shape,
            scale=1.0 / activity_shape,
            size=simulations,
        )
        guaranteed_acquisitions = new_buyers[:, t]
        desired_mean = active_buyers[:, t] * trades_per_active
        extra_mean = np.maximum(0.0, desired_mean - guaranteed_acquisitions) * activity_multiplier
        extra_counts = rng.poisson(extra_mean)
        transaction_counts = guaranteed_acquisitions + extra_counts
        transactions[:, t] = transaction_counts
        acquisitions_positive = guaranteed_acquisitions > 0
        if np.any(acquisitions_positive):
            acquisition_volume[acquisitions_positive, t] = rng.gamma(
                shape=guaranteed_acquisitions[acquisitions_positive] * gamma_shape_per_trade,
                scale=gamma_scale,
            )
        extra_positive = extra_counts > 0
        extra_volume = np.zeros(simulations, dtype=float)
        if np.any(extra_positive):
            extra_volume[extra_positive] = rng.gamma(
                shape=extra_counts[extra_positive] * gamma_shape_per_trade,
                scale=gamma_scale,
            )
        volume[:, t] = acquisition_volume[:, t] + extra_volume
    return transactions, volume, acquisition_volume


def simulate_market_and_fees(
    config: dict[str, Any],
    scenario: dict[str, Any],
    requested_volume_usd: np.ndarray,
    acquisition_volume_usd: np.ndarray,
    rng: np.random.Generator,
) -> dict[str, np.ndarray]:
    simulations, horizon = requested_volume_usd.shape
    trading = config["trading"]
    market = config["market"]
    curve_profile = trading["curve_fee_profile"]
    post_profile = trading[scenario["post_grad_fee_profile"]]
    mean_buy_share = float(scenario["buy_share_mean"])
    concentration = float(scenario["buy_share_concentration"])
    alpha = max(mean_buy_share * concentration, 1e-9)
    beta = max((1.0 - mean_buy_share) * concentration, 1e-9)

    repeat_volume = np.maximum(requested_volume_usd - acquisition_volume_usd, 0.0)
    buy_share = np.full((simulations, horizon), 0.5, dtype=float)
    buy_share[:, 2:] = rng.beta(alpha, beta, size=(simulations, horizon - 2))
    buy_volume = repeat_volume * buy_share + acquisition_volume_usd
    sell_volume = repeat_volume - repeat_volume * buy_share
    # Historical candles are observed gross turnover; their direction split is
    # unavailable and reserve state is anchored directly to each observed close.
    buy_volume[:, :2] = requested_volume_usd[:, :2] / 2.0
    sell_volume[:, :2] = requested_volume_usd[:, :2] / 2.0
    gross_volume_usd = buy_volume + sell_volume
    signed_flow = buy_volume - sell_volume
    unfilled_sell_volume = np.zeros((simulations, horizon), dtype=float)
    curve_signed_flow = np.zeros((simulations, horizon), dtype=float)

    rate_names = ("creator", "protocol", "lp", "total")
    rates = {name: np.full((simulations, horizon), float(curve_profile[name])) for name in rate_names}
    q_start = float(market["virtual_sol_start"])
    token_start = float(market["virtual_token_start"])
    invariant = q_start * token_start
    q_floor = float(market["virtual_sol_floor"])
    q_grad = q_floor + float(market["graduation_real_sol"])
    sol_usd = float(market["sol_usd"])
    supply = float(market["token_supply"])
    capture = float(market["net_flow_capture"])

    q = np.full(simulations, q_start, dtype=float)
    q_history = np.zeros((simulations, horizon), dtype=float)
    market_cap = np.zeros((simulations, horizon), dtype=float)
    market_cap[:, 0] = float(config["historical_daily"][0]["close_market_cap_usd"])
    market_cap[:, 1] = float(config["historical_daily"][1]["close_market_cap_usd"])
    q_day_1 = math.sqrt(market_cap[0, 0] * invariant / (supply * sol_usd))
    q_history[:, 0] = q_day_1
    q_history[:, 1] = q_start
    graduated = np.zeros((simulations, horizon), dtype=bool)
    floor_hit = np.zeros((simulations, horizon), dtype=bool)
    graduation_day = np.full(simulations, np.nan, dtype=float)
    graduation_fraction_in_day = np.full((simulations, horizon), np.nan, dtype=float)
    already_graduated = np.zeros(simulations, dtype=bool)

    for t in range(2, horizon):
        for name in rate_names:
            rates[name][already_graduated, t] = float(post_profile[name])

        active_curve = ~already_graduated
        # With uniform buy and sell flow inside the candle, reserve movement is
        # linear in elapsed candle time.  Clip only the excess net sell flow that
        # the curve cannot execute at its virtual-SOL floor; offsetting turnover
        # remains executable and fee-bearing.
        intended_net_sell = np.maximum(sell_volume[:, t] - buy_volume[:, t], 0.0)
        executable_net_sell = np.maximum(q - q_floor, 0.0) * sol_usd / capture
        clipped_sell = active_curve & (intended_net_sell > executable_net_sell)
        if np.any(clipped_sell):
            unfilled_sell_volume[clipped_sell, t] = (
                intended_net_sell[clipped_sell] - executable_net_sell[clipped_sell]
            )
            sell_volume[clipped_sell, t] -= unfilled_sell_volume[clipped_sell, t]
            gross_volume_usd[clipped_sell, t] = (
                buy_volume[clipped_sell, t] + sell_volume[clipped_sell, t]
            )
            signed_flow[clipped_sell, t] = (
                buy_volume[clipped_sell, t] - sell_volume[clipped_sell, t]
            )
            floor_hit[clipped_sell, t] = True

        delta_q = signed_flow[:, t] / sol_usd * capture
        candidate = q + delta_q
        crossing = active_curve & (delta_q > 0) & (candidate >= q_grad)
        if np.any(crossing):
            pre_fraction = np.clip((q_grad - q[crossing]) / delta_q[crossing], 0.0, 1.0)
            for name in rate_names:
                rates[name][crossing, t] = (
                    pre_fraction * float(curve_profile[name])
                    + (1.0 - pre_fraction) * float(post_profile[name])
                )
            graduation_day[crossing] = t + pre_fraction
            graduation_fraction_in_day[crossing, t] = pre_fraction
            curve_signed_flow[crossing, t] = (q_grad - q[crossing]) * sol_usd / capture
            q[crossing] = q_grad
            already_graduated[crossing] = True

        staying = active_curve & ~crossing
        if np.any(staying):
            q[staying] = np.clip(candidate[staying], q_floor, q_grad)
            curve_signed_flow[staying, t] = signed_flow[staying, t]

        graduated[:, t] = already_graduated
        q_history[:, t] = q
        virtual_token = invariant / q
        market_cap[:, t] = q / virtual_token * supply * sol_usd

    creator_fees = gross_volume_usd * rates["creator"]
    creator_fees_sol = creator_fees / sol_usd
    protocol_fees = gross_volume_usd * rates["protocol"]
    lp_fees = gross_volume_usd * rates["lp"]
    total_fees = gross_volume_usd * rates["total"]
    treasury = creator_fees * float(trading["treasury_share_of_creator_fee"])
    dev = creator_fees - treasury
    cumulative_creator = np.cumsum(creator_fees, axis=1)
    target = float(trading["target_creator_fees_usd"])
    hit_mask = cumulative_creator >= target
    any_hit = hit_mask.any(axis=1)
    first_index = np.argmax(hit_mask, axis=1)
    target_hit_day = np.full(simulations, np.nan, dtype=float)
    hit_rows = np.flatnonzero(any_hit)
    if hit_rows.size:
        indices = first_index[hit_rows]
        prior = np.where(indices > 0, cumulative_creator[hit_rows, indices - 1], 0.0)
        fee_on_hit_day = creator_fees[hit_rows, indices]
        fee_remaining = target - prior
        fraction = np.divide(
            fee_remaining,
            fee_on_hit_day,
            out=np.ones_like(prior),
            where=fee_on_hit_day > 0,
        )
        crossing_fraction = graduation_fraction_in_day[hit_rows, indices]
        crossing_on_hit_day = np.isfinite(crossing_fraction)
        if np.any(crossing_on_hit_day):
            rows = hit_rows[crossing_on_hit_day]
            row_indices = indices[crossing_on_hit_day]
            split = crossing_fraction[crossing_on_hit_day]
            day_volume = gross_volume_usd[rows, row_indices]
            pre_rate = float(curve_profile["creator"])
            post_rate = float(post_profile["creator"])
            pre_fee = day_volume * split * pre_rate
            remaining = fee_remaining[crossing_on_hit_day]
            before = remaining <= pre_fee
            exact_fraction = np.empty_like(remaining)
            exact_fraction[before] = np.divide(
                remaining[before],
                day_volume[before] * pre_rate,
                out=np.ones_like(remaining[before]),
                where=day_volume[before] * pre_rate > 0,
            )
            after = ~before
            exact_fraction[after] = split[after] + np.divide(
                remaining[after] - pre_fee[after],
                day_volume[after] * post_rate,
                out=np.ones_like(remaining[after]),
                where=day_volume[after] * post_rate > 0,
            )
            fraction[crossing_on_hit_day] = exact_fraction
        target_hit_day[hit_rows] = indices + np.clip(fraction, 0.0, 1.0)

    virtual_token_history = invariant / q_history
    invariant_error = np.abs(virtual_token_history * q_history - invariant) / invariant
    return {
        "gross_volume_usd": gross_volume_usd,
        "buy_volume_usd": buy_volume,
        "sell_volume_usd": sell_volume,
        "unfilled_sell_volume_usd": unfilled_sell_volume,
        "signed_flow_usd": signed_flow,
        "curve_signed_flow_usd": curve_signed_flow,
        "creator_fees_usd": creator_fees,
        "creator_fees_sol": creator_fees_sol,
        "protocol_fees_usd": protocol_fees,
        "lp_fees_usd": lp_fees,
        "total_fees_usd": total_fees,
        "treasury_accrual_usd": treasury,
        "dev_accrual_usd": dev,
        "creator_fee_rate": rates["creator"],
        "market_cap_proxy_usd": market_cap,
        "virtual_sol_reserve": q_history,
        "virtual_token_reserve": virtual_token_history,
        "graduated": graduated,
        "curve_floor_hit": floor_hit,
        "graduation_fraction_in_day": graduation_fraction_in_day,
        "target_hit_day": target_hit_day,
        "graduation_day": graduation_day,
        "invariant_relative_error": invariant_error,
    }


def simulate_scenario(
    config: dict[str, Any],
    scenario: dict[str, Any],
    calibration: Calibration,
    simulations: int,
    seed_sequence: np.random.SeedSequence,
) -> SimulationResult:
    buyer_seed, activity_seed, trading_seed, market_seed = seed_sequence.spawn(4)
    buyer_rng = np.random.default_rng(buyer_seed)
    activity_rng = np.random.default_rng(activity_seed)
    trading_rng = np.random.default_rng(trading_seed)
    market_rng = np.random.default_rng(market_seed)
    new_buyers, cumulative_buyers = simulate_buyers(
        config, scenario, calibration, simulations, buyer_rng
    )
    returning, active = simulate_activity(new_buyers, scenario, activity_rng)
    transactions, requested_volume, acquisition_volume = simulate_transactions_and_volume(
        config, scenario, new_buyers, active, trading_rng
    )
    market_fee = simulate_market_and_fees(
        config,
        scenario,
        requested_volume,
        acquisition_volume,
        market_rng,
    )
    return SimulationResult(
        scenario=scenario,
        calibration=calibration,
        new_buyers=new_buyers,
        cumulative_buyers=cumulative_buyers,
        returning_buyers=returning,
        active_buyers=active,
        transactions=transactions,
        requested_volume_usd=requested_volume,
        acquisition_volume_usd=acquisition_volume,
        **market_fee,
    )


def quantile_row(values: np.ndarray, prefix: str) -> dict[str, float]:
    quantiles = np.quantile(values, QUANTILES)
    row = {
        f"{prefix}_mean": float(np.mean(values)),
        f"{prefix}_std": float(np.std(values, ddof=1)),
    }
    row.update({f"{prefix}_{label}": float(value) for label, value in zip(QUANTILE_LABELS, quantiles)})
    return row


def summarize_daily(config: dict[str, Any], result: SimulationResult) -> pd.DataFrame:
    launch = date.fromisoformat(config["launch_date"])
    cumulative_creator = np.cumsum(result.creator_fees_usd, axis=1)
    metrics = {
        "new_buyers": result.new_buyers,
        "cumulative_buyers": result.cumulative_buyers,
        "active_buyers": result.active_buyers,
        "transactions": result.transactions,
        "requested_volume_usd": result.requested_volume_usd,
        "gross_volume_usd": result.gross_volume_usd,
        "unfilled_sell_volume_usd": result.unfilled_sell_volume_usd,
        "cumulative_creator_fees_usd": cumulative_creator,
        "creator_fees_sol": result.creator_fees_sol,
        "market_cap_proxy_usd": result.market_cap_proxy_usd,
    }
    rows: list[dict[str, Any]] = []
    for t in range(int(config["horizon_days"])):
        row: dict[str, Any] = {
            "scenario": result.scenario["name"],
            "scenario_label": result.scenario["label"],
            "day": t + 1,
            "date": (launch + timedelta(days=t)).isoformat(),
            "period_type": "observed_volume" if t < 2 else "modeled",
            "calibration_curve_cumulative_buyers": float(result.calibration.expected_cumulative[t]),
            "graduation_probability": float(np.mean(result.graduated[:, t])),
            "curve_floor_probability": float(np.mean(np.any(result.curve_floor_hit[:, : t + 1], axis=1))),
            "fee_target_probability": float(np.mean(cumulative_creator[:, t] >= config["trading"]["target_creator_fees_usd"])),
        }
        for prefix, values in metrics.items():
            row.update(quantile_row(values[:, t], prefix))
        rows.append(row)
    return pd.DataFrame(rows)


def _conditional_quantiles(values: np.ndarray) -> tuple[float, float, float]:
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return (math.nan, math.nan, math.nan)
    q = np.quantile(finite, (0.25, 0.5, 0.75))
    return float(q[0]), float(q[1]), float(q[2])


def summarize_scenario(config: dict[str, Any], result: SimulationResult) -> dict[str, Any]:
    report_index = int(config["report_day"]) - 1
    horizon_index = int(config["horizon_days"]) - 1
    cumulative_fees = np.cumsum(result.creator_fees_usd, axis=1)
    cumulative_volume = np.cumsum(result.gross_volume_usd, axis=1)
    cumulative_requested_volume = np.cumsum(result.requested_volume_usd, axis=1)
    cumulative_unfilled = np.cumsum(result.unfilled_sell_volume_usd, axis=1)
    target = float(config["trading"]["target_creator_fees_usd"])
    hit_q25, hit_median, hit_q75 = _conditional_quantiles(result.target_hit_day)
    grad_q25, grad_median, grad_q75 = _conditional_quantiles(result.graduation_day)
    hit = np.isfinite(result.target_hit_day)
    target_before_graduation = hit & (
        ~np.isfinite(result.graduation_day) | (result.target_hit_day <= result.graduation_day)
    )
    effective_rate = np.divide(
        cumulative_fees[:, horizon_index],
        cumulative_volume[:, horizon_index],
        out=np.zeros(cumulative_fees.shape[0]),
        where=cumulative_volume[:, horizon_index] > 0,
    )
    ticket_days = slice(2, None)
    aggregate_ticket = float(
        result.requested_volume_usd[:, ticket_days].sum()
        / max(result.transactions[:, ticket_days].sum(), 1.0)
    )
    return {
        "scenario": result.scenario["name"],
        "scenario_label": result.scenario["label"],
        "diffusion": result.scenario["diffusion"],
        "capacity": result.scenario.get("carrying_capacity"),
        "calibration_curve_buyers_day_14": float(result.calibration.expected_cumulative[report_index]),
        "buyers_day_14_mean": float(np.mean(result.cumulative_buyers[:, report_index])),
        "buyers_day_14_p05": float(np.quantile(result.cumulative_buyers[:, report_index], 0.05)),
        "buyers_day_14_p50": float(np.quantile(result.cumulative_buyers[:, report_index], 0.50)),
        "buyers_day_14_p95": float(np.quantile(result.cumulative_buyers[:, report_index], 0.95)),
        "active_buyers_day_14_p50": float(np.quantile(result.active_buyers[:, report_index], 0.50)),
        "cumulative_volume_day_14_p50": float(np.quantile(cumulative_volume[:, report_index], 0.50)),
        "cumulative_requested_volume_day_14_p50": float(
            np.quantile(cumulative_requested_volume[:, report_index], 0.50)
        ),
        "cumulative_unfilled_sell_volume_day_14_p50": float(
            np.quantile(cumulative_unfilled[:, report_index], 0.50)
        ),
        "cumulative_creator_fees_day_14_p05": float(np.quantile(cumulative_fees[:, report_index], 0.05)),
        "cumulative_creator_fees_day_14_p50": float(np.quantile(cumulative_fees[:, report_index], 0.50)),
        "cumulative_creator_fees_day_14_p95": float(np.quantile(cumulative_fees[:, report_index], 0.95)),
        "probability_fee_target_by_day_14": float(np.mean(cumulative_fees[:, report_index] >= target)),
        "probability_fee_target_by_horizon": float(np.mean(cumulative_fees[:, horizon_index] >= target)),
        "target_hit_day_p25_conditional": hit_q25,
        "target_hit_day_median_conditional": hit_median,
        "target_hit_day_p75_conditional": hit_q75,
        "graduation_probability_by_day_14": float(np.mean(np.isfinite(result.graduation_day) & (result.graduation_day <= config["report_day"]))),
        "graduation_probability_by_horizon": float(np.mean(np.isfinite(result.graduation_day))),
        "graduation_day_p25_conditional": grad_q25,
        "graduation_day_median_conditional": grad_median,
        "graduation_day_p75_conditional": grad_q75,
        "probability_target_before_graduation": float(np.mean(target_before_graduation)),
        "effective_creator_fee_rate_p50": float(np.quantile(effective_rate, 0.50)),
        "market_cap_proxy_day_14_p50": float(np.quantile(result.market_cap_proxy_usd[:, report_index], 0.50)),
        "market_cap_proxy_day_14_p95": float(np.quantile(result.market_cap_proxy_usd[:, report_index], 0.95)),
        "simulated_average_transaction_usd": aggregate_ticket,
        "stall_probability_days_8_to_14": float(np.mean(result.new_buyers[:, 7:14].sum(axis=1) == 0)),
        "max_invariant_relative_error": float(np.max(result.invariant_relative_error)),
    }


def milestone_rows(config: dict[str, Any], result: SimulationResult) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    n = result.cumulative_buyers.shape[0]
    targets = ((3, float(config["milestones"]["day_3_cumulative_buyers"])), (7, float(config["milestones"]["day_7_cumulative_buyers"])))
    hit_both = np.ones(n, dtype=bool)
    for day_number, target in targets:
        values = result.cumulative_buyers[:, day_number - 1]
        std = float(np.std(values, ddof=1))
        probability = float(np.mean(values >= target))
        hit_both &= values >= target
        rows.append(
            {
                "scenario": result.scenario["name"],
                "day": day_number,
                "target_cumulative_buyers": target,
                "deterministic_expected": float(result.calibration.expected_cumulative[day_number - 1]),
                "simulation_mean": float(np.mean(values)),
                "simulation_std": std,
                "monte_carlo_standard_error": std / math.sqrt(n),
                "mean_residual": float(np.mean(values) - target),
                "probability_at_or_above_target": probability,
            }
        )
    rows.append(
        {
            "scenario": result.scenario["name"],
            "day": "3_and_7",
            "target_cumulative_buyers": math.nan,
            "deterministic_expected": math.nan,
            "simulation_mean": math.nan,
            "simulation_std": math.nan,
            "monte_carlo_standard_error": math.nan,
            "mean_residual": math.nan,
            "probability_at_or_above_target": float(np.mean(hit_both)),
        }
    )
    return rows


def calibration_rows(config: dict[str, Any], calibrations: Iterable[Calibration]) -> pd.DataFrame:
    d3 = float(config["milestones"]["day_3_cumulative_buyers"])
    d7 = float(config["milestones"]["day_7_cumulative_buyers"])
    rows = []
    seen: set[tuple[str, str]] = set()
    for calibration in calibrations:
        parameters_json = json.dumps(calibration.parameters, sort_keys=True)
        signature = (calibration.model, parameters_json)
        if signature in seen:
            continue
        seen.add(signature)
        rows.append(
            {
                "model": calibration.model,
                "parameters_json": parameters_json,
                "expected_day_3": float(calibration.expected_cumulative[2]),
                "day_3_residual": float(calibration.expected_cumulative[2] - d3),
                "expected_day_7": float(calibration.expected_cumulative[6]),
                "day_7_residual": float(calibration.expected_cumulative[6] - d7),
                "expected_day_14": float(calibration.expected_cumulative[13]),
                "notes": calibration.notes,
            }
        )
    return pd.DataFrame(rows)


def build_observed_candles(config: dict[str, Any]) -> pd.DataFrame:
    """Publish only quantities identifiable from the completed daily candles.

    Volume divided by the assumed ticket is a transaction-equivalent count, not
    a unique-buyer count.  Keeping that distinction explicit prevents the most
    consequential false precision in a buyer/fee model.
    """

    ticket = float(config["trading"]["average_transaction_usd"])
    creator_rate = float(config["trading"]["curve_fee_profile"]["creator"])
    sol_usd = float(config["market"]["sol_usd"])
    rows: list[dict[str, Any]] = []
    cumulative_volume = 0.0
    cumulative_creator_fees = 0.0
    for candle in config["historical_daily"]:
        volume = float(candle["volume_usd"])
        creator_fees = volume * creator_rate
        cumulative_volume += volume
        cumulative_creator_fees += creator_fees
        rows.append(
            {
                "day": int(candle["day"]),
                "date": candle["date"],
                "candle_status": "completed_observation",
                "volume_usd": volume,
                "close_market_cap_usd": float(candle["close_market_cap_usd"]),
                "close_market_cap_sol": float(candle["close_market_cap_usd"]) / sol_usd,
                "transaction_equivalents_at_average_ticket": volume / ticket,
                "uniform_hourly_volume_usd": volume / 24.0,
                "uniform_hourly_transaction_equivalents": volume / ticket / 24.0,
                "creator_fee_rate": creator_rate,
                "creator_fees_usd": creator_fees,
                "cumulative_volume_usd": cumulative_volume,
                "cumulative_creator_fees_usd": cumulative_creator_fees,
                "unique_buyers_identifiable_from_volume": False,
            }
        )
    return pd.DataFrame(rows)


def build_scenario_assumptions(config: dict[str, Any]) -> pd.DataFrame:
    """Flatten the scenario configuration into a reviewable pandas table."""

    rows: list[dict[str, Any]] = []
    for scenario in config["scenarios"]:
        post_profile_name = scenario["post_grad_fee_profile"]
        post_profile = config["trading"][post_profile_name]
        weights = scenario.get("referral_delay_weights")
        rows.append(
            {
                "scenario": scenario["name"],
                "scenario_label": scenario["label"],
                "diffusion": scenario["diffusion"],
                "carrying_capacity": scenario.get("carrying_capacity"),
                "buyer_dispersion": float(scenario["buyer_dispersion"]),
                "daily_repeat_participation_probability": float(
                    scenario["daily_repeat_participation_probability"]
                ),
                "participation_age_decay": float(scenario["participation_age_decay"]),
                "trades_per_active_buyer": float(scenario["trades_per_active_buyer"]),
                "activity_shape": float(scenario["activity_shape"]),
                "buy_share_mean": float(scenario["buy_share_mean"]),
                "buy_share_concentration": float(scenario["buy_share_concentration"]),
                "external_buyers_per_day": scenario.get("external_buyers_per_day"),
                "referral_delay_weights_json": json.dumps(weights) if weights is not None else None,
                "post_grad_fee_profile": post_profile_name,
                "post_grad_creator_fee_rate": float(post_profile["creator"]),
                "post_grad_fee_tier_is_sensitivity": post_profile_name == "post_grad_bonus_tier_profile",
            }
        )
    return pd.DataFrame(rows)


def build_diffusion_comparison(config: dict[str, Any]) -> tuple[pd.DataFrame, list[Calibration]]:
    calibrations = [
        incidence_exponential_calibration(config),
        stock_exponential_calibration(config),
        shifted_logistic_calibration(config, 150.0),
        shifted_logistic_calibration(config, 500.0),
        shifted_logistic_calibration(config, 2000.0),
    ]
    labels = {
        "incidence_exponential": "Incidence exponential",
        "stock_exponential": "Stock-growth stress",
    }
    rows: list[dict[str, Any]] = []
    launch = date.fromisoformat(config["launch_date"])
    for calibration in calibrations:
        if calibration.model == "shifted_logistic":
            label = f"Strict-zero logistic K={calibration.parameters['carrying_capacity']:,.0f}"
        else:
            label = labels[calibration.model]
        for index, (new, cumulative) in enumerate(
            zip(calibration.expected_new, calibration.expected_cumulative), start=1
        ):
            rows.append(
                {
                    "model": label,
                    "day": index,
                    "date": (launch + timedelta(days=index - 1)).isoformat(),
                    "expected_new_buyers": float(new),
                    "expected_cumulative_buyers": float(cumulative),
                }
            )
    return pd.DataFrame(rows), calibrations


def build_target_frontier(config: dict[str, Any]) -> pd.DataFrame:
    """Backsolve trading intensity for alternative Day-14 buyer endpoints.

    The future fee rate is a sensitivity, not a forecast.  The 0.95% case only
    applies after graduation while the canonical pool is in the documented
    420--1,470 SOL market-cap tier; the path simulation handles the transition.
    """

    baseline = incidence_exponential_calibration(config)
    report_day = int(config["report_day"])
    d7 = float(config["milestones"]["day_7_cumulative_buyers"])
    historical_creator = sum(
        float(row["volume_usd"]) * float(config["trading"]["curve_fee_profile"]["creator"])
        for row in config["historical_daily"]
    )
    remaining_fees = max(
        0.0,
        float(config["trading"]["target_creator_fees_usd"]) - historical_creator,
    )
    ticket = float(config["trading"]["average_transaction_usd"])
    fee_rate_cases = (
        (
            "0.30% curve / low tier",
            float(config["trading"]["curve_fee_profile"]["creator"]),
        ),
        (
            "0.95% all-future-volume upper sensitivity",
            float(config["trading"]["post_grad_bonus_tier_profile"]["creator"]),
        ),
    )
    day14_targets = (150.0, 250.0, 500.0, 777.38, 1000.0, 1415.01, 2500.0, 5000.0, 10000.0, 25000.0, 50000.0, 83334.0)
    participations = (0.10, 0.30, 0.60, 1.00)
    rows = []
    for end_buyers in day14_targets:
        growth = (end_buyers / d7) ** (1.0 / (report_day - 7)) - 1.0
        cumulative = baseline.expected_cumulative[:report_day].copy()
        for day_number in range(8, report_day + 1):
            cumulative[day_number - 1] = d7 * (1.0 + growth) ** (day_number - 7)
        new = np.diff(np.concatenate(([0.0], cumulative)))
        for fee_case, future_fee_rate in fee_rate_cases:
            remaining_volume = remaining_fees / future_fee_rate
            remaining_transactions = remaining_volume / ticket
            for participation in participations:
                active = new.copy()
                active[1:] += participation * cumulative[:-1]
                active_buyer_days = float(active[2:report_day].sum())
                rows.append(
                    {
                        "future_fee_rate_case": fee_case,
                        "future_creator_fee_rate": future_fee_rate,
                        "day_14_cumulative_buyers": end_buyers,
                        "post_day_7_daily_buyer_growth": growth,
                        "average_new_buyers_per_day_days_8_14": (end_buyers - d7) / (report_day - 7),
                        "prior_buyer_daily_return_participation": participation,
                        "active_buyer_days_days_3_14": active_buyer_days,
                        "remaining_volume_required_usd": remaining_volume,
                        "remaining_transactions_required": remaining_transactions,
                        "required_transactions_per_active_buyer_day": remaining_transactions / active_buyer_days,
                        "required_turnover_per_active_buyer_day_usd": remaining_transactions / active_buyer_days * ticket,
                        "remaining_transactions_divided_by_net_new_buyers": remaining_transactions / max(end_buyers - baseline.expected_cumulative[1], 1e-9),
                    }
                )
    return pd.DataFrame(rows)


def build_probability_sweep(
    config: dict[str, Any],
    simulations: int,
    seed: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Estimate activity needed for target-hit probabilities under each buyer path.

    Buyer and repeat-participation random streams are held common within each
    scenario's trade-intensity grid.  The published threshold interpolates the
    monotone envelope of finite-grid probabilities and should be read as a
    planning estimate, not an exact optimizer.
    """

    target = float(config["trading"]["target_creator_fees_usd"])
    ticket = float(config["trading"]["average_transaction_usd"])
    report_index = int(config["report_day"]) - 1
    sweep_config = config["probability_sweep"]
    rows: list[dict[str, Any]] = []
    for scenario_index, scenario in enumerate(config["scenarios"]):
        calibration = calibration_for_scenario(config, scenario)
        trade_grid = sweep_config["trades_per_active_grid"][scenario["name"]]
        for trades_per_active in trade_grid:
            variant = dict(scenario)
            variant["trades_per_active_buyer"] = float(trades_per_active)
            # Recreate the SeedSequence for each point to induce common random
            # numbers in buyer/activity paths across the intensity grid.
            result = simulate_scenario(
                config,
                variant,
                calibration,
                simulations,
                np.random.SeedSequence([seed, scenario_index, 991]),
            )
            cumulative_fees = np.cumsum(result.creator_fees_usd, axis=1)[:, report_index]
            cumulative_volume = np.cumsum(result.gross_volume_usd, axis=1)[:, report_index]
            cumulative_unfilled = np.cumsum(
                result.unfilled_sell_volume_usd,
                axis=1,
            )[:, report_index]
            rows.append(
                {
                    "scenario": scenario["name"],
                    "scenario_label": scenario["label"],
                    "simulations": simulations,
                    "trades_per_active_buyer_day": float(trades_per_active),
                    "requested_turnover_per_active_buyer_day_usd": float(trades_per_active) * ticket,
                    "probability_fee_target_by_day_14": float(np.mean(cumulative_fees >= target)),
                    "creator_fees_day_14_p10": float(np.quantile(cumulative_fees, 0.10)),
                    "creator_fees_day_14_p50": float(np.quantile(cumulative_fees, 0.50)),
                    "creator_fees_day_14_p90": float(np.quantile(cumulative_fees, 0.90)),
                    "executed_volume_day_14_p50": float(np.quantile(cumulative_volume, 0.50)),
                    "unfilled_sell_volume_day_14_p50": float(np.quantile(cumulative_unfilled, 0.50)),
                    "buyers_day_14_mean": float(np.mean(result.cumulative_buyers[:, report_index])),
                    "buyers_day_14_p50": float(np.quantile(result.cumulative_buyers[:, report_index], 0.50)),
                }
            )

    sweep_frame = pd.DataFrame(rows)
    threshold_rows: list[dict[str, Any]] = []
    for scenario_name, frame in sweep_frame.groupby("scenario", sort=False):
        frame = frame.sort_values("trades_per_active_buyer_day")
        grid = frame["trades_per_active_buyer_day"].to_numpy(dtype=float)
        raw_probability = frame["probability_fee_target_by_day_14"].to_numpy(dtype=float)
        monotone_probability = np.maximum.accumulate(raw_probability)
        label = str(frame["scenario_label"].iloc[0])
        for probability_target in sweep_config["target_probabilities"]:
            target_probability = float(probability_target)
            if monotone_probability[-1] < target_probability:
                estimate = math.nan
                lower_trade = grid[-1]
                upper_trade = math.nan
                lower_probability = monotone_probability[-1]
                upper_probability = math.nan
            else:
                upper_index = int(np.searchsorted(monotone_probability, target_probability, side="left"))
                if upper_index == 0:
                    estimate = float(grid[0])
                    lower_trade = float(grid[0])
                    upper_trade = float(grid[0])
                    lower_probability = float(monotone_probability[0])
                    upper_probability = float(monotone_probability[0])
                else:
                    lower_index = upper_index - 1
                    lower_trade = float(grid[lower_index])
                    upper_trade = float(grid[upper_index])
                    lower_probability = float(monotone_probability[lower_index])
                    upper_probability = float(monotone_probability[upper_index])
                    if upper_probability == lower_probability:
                        estimate = upper_trade
                    else:
                        weight = (target_probability - lower_probability) / (
                            upper_probability - lower_probability
                        )
                        estimate = lower_trade + weight * (upper_trade - lower_trade)
            threshold_rows.append(
                {
                    "scenario": scenario_name,
                    "scenario_label": label,
                    "buyers_day_14_mean": float(frame["buyers_day_14_mean"].iloc[0]),
                    "buyers_day_14_p50": float(frame["buyers_day_14_p50"].iloc[0]),
                    "target_hit_probability": target_probability,
                    "estimated_trades_per_active_buyer_day": estimate,
                    "estimated_requested_turnover_per_active_buyer_day_usd": estimate * ticket,
                    "lower_grid_trades": lower_trade,
                    "upper_grid_trades": upper_trade,
                    "lower_grid_probability": lower_probability,
                    "upper_grid_probability": upper_probability,
                    "simulations_per_grid_point": simulations,
                    "method": "linear interpolation of monotone Monte Carlo grid envelope",
                }
            )
    return sweep_frame, pd.DataFrame(threshold_rows)


def validation_rows(config: dict[str, Any], result: SimulationResult) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def add(check: str, value: float, tolerance: float, passed: bool, note: str) -> None:
        rows.append(
            {
                "scenario": result.scenario["name"],
                "check": check,
                "value": value,
                "tolerance": tolerance,
                "status": "PASS" if passed else "FAIL",
                "note": note,
            }
        )

    gross_identity = float(np.max(np.abs(result.gross_volume_usd - result.buy_volume_usd - result.sell_volume_usd)))
    execution_identity = float(
        np.max(
            np.abs(
                result.requested_volume_usd
                - result.gross_volume_usd
                - result.unfilled_sell_volume_usd
            )
        )
    )
    fee_identity = float(np.max(np.abs(result.total_fees_usd - result.creator_fees_usd - result.protocol_fees_usd - result.lp_fees_usd)))
    allocation_identity = float(np.max(np.abs(result.creator_fees_usd - result.treasury_accrual_usd - result.dev_accrual_usd)))
    sol_fee_identity = float(
        np.max(
            np.abs(
                result.creator_fees_sol * float(config["market"]["sol_usd"])
                - result.creator_fees_usd
            )
        )
    )
    hourly_identity = float(np.max(np.abs((result.gross_volume_usd / 24.0) * 24.0 - result.gross_volume_usd)))
    nonnegative = float(
        min(
            result.new_buyers.min(),
            result.active_buyers.min(),
            result.gross_volume_usd.min(),
            result.unfilled_sell_volume_usd.min(),
        )
    )
    cumulative_step = float(np.min(np.diff(result.cumulative_buyers, axis=1)))
    integer_people_error = float(np.max(np.abs(result.new_buyers - np.rint(result.new_buyers))))
    acquisition_buy_shortfall = float(
        np.max(
            np.maximum(
                result.acquisition_volume_usd[:, 2:] - result.buy_volume_usd[:, 2:],
                0.0,
            )
        )
    )
    q = result.virtual_sol_reserve
    q_floor = float(config["market"]["virtual_sol_floor"])
    q_grad = q_floor + float(config["market"]["graduation_real_sol"])
    boundary_error = float(max(np.max(q_floor - q), np.max(q - q_grad), 0.0))
    reserve_delta = q[:, 2:] - q[:, 1:-1]
    modeled_reserve_delta = (
        result.curve_signed_flow_usd[:, 2:]
        / float(config["market"]["sol_usd"])
        * float(config["market"]["net_flow_capture"])
    )
    quote_flow_reconciliation = float(np.max(np.abs(reserve_delta - modeled_reserve_delta)))
    invariant = float(config["market"]["virtual_sol_start"]) * float(
        config["market"]["virtual_token_start"]
    )
    implied_observed_market_cap = (
        q[:, :2] ** 2
        / invariant
        * float(config["market"]["token_supply"])
        * float(config["market"]["sol_usd"])
    )
    observed_market_cap = np.asarray(
        [row["close_market_cap_usd"] for row in config["historical_daily"]],
        dtype=float,
    )
    observed_market_cap_error = float(
        np.max(np.abs(implied_observed_market_cap - observed_market_cap[None, :]))
    )
    add("gross volume = buys + sells", gross_identity, 1e-7, gross_identity <= 1e-7, "Fees use gross volume; price uses signed flow.")
    add("requested = executed + unfilled sells", execution_identity, 1e-7, execution_identity <= 1e-7, "Excess sell flow at the curve floor is rejected and earns no fees.")
    add("fee components sum to total", fee_identity, 1e-7, fee_identity <= 1e-7, "Creator + protocol + LP = total fee.")
    add("creator allocation sums", allocation_identity, 1e-7, allocation_identity <= 1e-7, "Treasury + dev = creator fees.")
    add("creator SOL/USD conversion", sol_fee_identity, 1e-7, sol_fee_identity <= 1e-7, "USD-at-accrual uses the configured fixed SOL/USD rate.")
    add("uniform hourly volume reconciles", hourly_identity, 1e-7, hourly_identity <= 1e-7, "Daily volume is uniform only within each daily candle.")
    add("nonnegative state", nonnegative, 0.0, nonnegative >= 0.0, "Buyers, activity, and volume cannot be negative.")
    add("cumulative buyers nondecreasing", cumulative_step, 0.0, cumulative_step >= 0.0, "Every stochastic path is monotonic.")
    add("integer people per path", integer_people_error, 0.0, integer_people_error == 0.0, "Fractional people appear only in expectations/quantiles.")
    add("acquisition trades are buys", acquisition_buy_shortfall, 1e-7, acquisition_buy_shortfall <= 1e-7, "Every modeled new-buyer acquisition is assigned to buy volume before repeat-trade direction is sampled.")
    add("virtual SOL reserve boundaries", boundary_error, 1e-10, boundary_error <= 1e-10, "Curve reserve stays between launch floor and graduation boundary.")
    add("curve quote-flow roll-forward", quote_flow_reconciliation, 1e-10, quote_flow_reconciliation <= 1e-10, "Reserve changes reconcile to boundary-adjusted executed signed flow.")
    add("observed close market-cap reconciliation", observed_market_cap_error, 1e-7, observed_market_cap_error <= 1e-7, "Day-1 and Day-2 reserve anchors reproduce their observed closing market caps.")
    add("constant-product reserve reconstruction", float(np.max(result.invariant_relative_error)), 1e-12, float(np.max(result.invariant_relative_error)) <= 1e-12, "Virtual token reserves are reconstructed from the invariant after verified quote-reserve roll-forward.")
    ticket = float(config["trading"]["average_transaction_usd"])
    modeled_volume = float(result.requested_volume_usd[:, 2:].sum())
    modeled_transactions = float(result.transactions[:, 2:].sum())
    realized_ticket = modeled_volume / modeled_transactions
    add("simulated requested mean transaction size", realized_ticket, ticket * 0.02, abs(realized_ticket - ticket) <= ticket * 0.02, "Gamma trade-size aggregation converges to the configured $20 mean before any unfilled curve-floor sells.")
    for day_number, target in ((3, config["milestones"]["day_3_cumulative_buyers"]), (7, config["milestones"]["day_7_cumulative_buyers"])):
        values = result.cumulative_buyers[:, day_number - 1]
        maximum_path_error = float(np.max(np.abs(values - float(target))))
        add(f"conditioned Day-{day_number} milestone", maximum_path_error, 0.0, maximum_path_error == 0.0, "Every stochastic path is multinomial-bridged through the user-supplied planning milestone.")
    return rows


def _format_number(value: Any, column: str) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "—"
    if isinstance(value, (str, bool, np.bool_)):
        return str(value)
    if "probability" in column or "rate" in column or "growth" in column or "participation" in column:
        return f"{float(value):.1%}"
    if "usd" in column or "volume" in column or "fees" in column or "market_cap" in column or "turnover" in column:
        return f"${float(value):,.0f}"
    if isinstance(value, (float, np.floating)):
        return f"{float(value):,.2f}"
    return str(value)


def styled_table(frame: pd.DataFrame, columns: list[str], rename: dict[str, str]) -> str:
    display = frame.loc[:, columns].copy()
    for column in display.columns:
        display[column] = display[column].map(lambda value, c=column: _format_number(value, c))
    display = display.rename(columns=rename)
    return display.to_html(index=False, escape=True, classes="dataframe")


def _svg_points(xs: np.ndarray, ys: np.ndarray, x_map: Callable[[float], float], y_map: Callable[[float], float]) -> str:
    return " ".join(f"{x_map(float(x)):.2f},{y_map(float(y)):.2f}" for x, y in zip(xs, ys))


def svg_line_chart(
    series: list[tuple[str, np.ndarray, np.ndarray]],
    *,
    title: str,
    y_label: str,
    x_label: str = "Launch day",
    width: int = 920,
    height: int = 360,
    target_line: float | None = None,
    percent_axis: bool = False,
    log_x: bool = False,
) -> str:
    margin_left, margin_right, margin_top, margin_bottom = 78, 24, 42, 54
    plot_width = width - margin_left - margin_right
    plot_height = height - margin_top - margin_bottom
    all_x = np.concatenate([item[1] for item in series])
    all_y = np.concatenate([item[2] for item in series])
    if target_line is not None:
        all_y = np.append(all_y, target_line)
    x_min, x_max = float(np.min(all_x)), float(np.max(all_x))
    if log_x and x_min <= 0:
        raise ValueError("logarithmic x axis requires positive values")
    y_min, y_max = 0.0, float(np.max(all_y))
    if y_max <= 0:
        y_max = 1.0
    y_max *= 1.08
    if log_x:
        log_min, log_max = math.log10(x_min), math.log10(x_max)
        x_map = lambda value: margin_left + (math.log10(value) - log_min) / max(log_max - log_min, 1e-9) * plot_width
        x_ticks = np.geomspace(x_min, x_max, 7)
    else:
        x_map = lambda value: margin_left + (value - x_min) / max(x_max - x_min, 1e-9) * plot_width
        x_ticks = np.linspace(x_min, x_max, min(int(x_max - x_min + 1), 8))
    y_map = lambda value: margin_top + plot_height - (value - y_min) / max(y_max - y_min, 1e-9) * plot_height
    parts = [
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{html.escape(title)}">',
        f'<text x="{width/2:.0f}" y="24" text-anchor="middle" class="chart-title">{html.escape(title)}</text>',
    ]
    for index in range(6):
        fraction = index / 5
        y_value = y_min + fraction * (y_max - y_min)
        y_pixel = y_map(y_value)
        label = f"{y_value:.0%}" if percent_axis else (f"${y_value:,.0f}" if "$" in y_label else f"{y_value:,.0f}")
        parts.append(f'<line x1="{margin_left}" x2="{width-margin_right}" y1="{y_pixel:.2f}" y2="{y_pixel:.2f}" class="grid"/>')
        parts.append(f'<text x="{margin_left-10}" y="{y_pixel+4:.2f}" text-anchor="end" class="tick">{label}</text>')
    for x_value in x_ticks:
        x_pixel = x_map(float(x_value))
        x_text = f"{x_value:,.0f}" if x_value >= 1000 else f"{x_value:.0f}"
        parts.append(f'<text x="{x_pixel:.2f}" y="{height-28}" text-anchor="middle" class="tick">{x_text}</text>')
    parts.append(f'<text x="18" y="{height/2:.0f}" transform="rotate(-90 18 {height/2:.0f})" text-anchor="middle" class="axis-label">{html.escape(y_label)}</text>')
    parts.append(f'<text x="{width/2:.0f}" y="{height-6}" text-anchor="middle" class="axis-label">{html.escape(x_label)}</text>')
    if target_line is not None:
        y_pixel = y_map(target_line)
        parts.append(f'<line x1="{margin_left}" x2="{width-margin_right}" y1="{y_pixel:.2f}" y2="{y_pixel:.2f}" class="target"/>')
    legend_x = margin_left
    for index, (label, xs, ys) in enumerate(series):
        color = COLORS[index % len(COLORS)]
        points = _svg_points(xs, ys, x_map, y_map)
        parts.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="3"/>')
        parts.append(f'<line x1="{legend_x}" x2="{legend_x+22}" y1="{height-42}" y2="{height-42}" stroke="{color}" stroke-width="3"/>')
        parts.append(f'<text x="{legend_x+28}" y="{height-38}" class="legend">{html.escape(label)}</text>')
        legend_x += 28 + min(180, len(label) * 7)
    parts.append("</svg>")
    return "".join(parts)


def svg_fan_chart(
    daily: pd.DataFrame,
    *,
    scenario: str,
    prefix: str,
    title: str,
    y_label: str,
    target_line: float | None = None,
) -> str:
    frame = daily[daily["scenario"] == scenario].sort_values("day")
    xs = frame["day"].to_numpy(dtype=float)
    p05 = frame[f"{prefix}_p05"].to_numpy(dtype=float)
    p50 = frame[f"{prefix}_p50"].to_numpy(dtype=float)
    p95 = frame[f"{prefix}_p95"].to_numpy(dtype=float)
    width, height = 920, 360
    left, right, top, bottom = 78, 24, 42, 54
    plot_width, plot_height = width - left - right, height - top - bottom
    y_max = max(float(np.max(p95)), float(target_line or 0.0), 1.0) * 1.08
    x_map = lambda value: left + (value - xs.min()) / max(xs.max() - xs.min(), 1e-9) * plot_width
    y_map = lambda value: top + plot_height - value / y_max * plot_height
    upper = [(x_map(x), y_map(y)) for x, y in zip(xs, p95)]
    lower = [(x_map(x), y_map(y)) for x, y in zip(xs[::-1], p05[::-1])]
    polygon = " ".join(f"{x:.2f},{y:.2f}" for x, y in upper + lower)
    median = _svg_points(xs, p50, x_map, y_map)
    parts = [
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{html.escape(title)}">',
        f'<text x="{width/2:.0f}" y="24" text-anchor="middle" class="chart-title">{html.escape(title)}</text>',
    ]
    for index in range(6):
        value = y_max * index / 5
        pixel = y_map(value)
        label = f"${value:,.0f}" if "$" in y_label else f"{value:,.0f}"
        parts.append(f'<line x1="{left}" x2="{width-right}" y1="{pixel:.2f}" y2="{pixel:.2f}" class="grid"/>')
        parts.append(f'<text x="{left-10}" y="{pixel+4:.2f}" text-anchor="end" class="tick">{label}</text>')
    parts.append(f'<polygon points="{polygon}" fill="#2A9D8F" opacity="0.16"/>')
    parts.append(f'<polyline points="{median}" fill="none" stroke="#2A9D8F" stroke-width="3"/>')
    if target_line is not None:
        target_y = y_map(target_line)
        parts.append(f'<line x1="{left}" x2="{width-right}" y1="{target_y:.2f}" y2="{target_y:.2f}" class="target"/>')
    for day_number in range(1, int(xs.max()) + 1, 2):
        parts.append(f'<text x="{x_map(day_number):.2f}" y="{height-28}" text-anchor="middle" class="tick">{day_number}</text>')
    parts.append(f'<text x="18" y="{height/2:.0f}" transform="rotate(-90 18 {height/2:.0f})" text-anchor="middle" class="axis-label">{html.escape(y_label)}</text>')
    parts.append(f'<text x="{width/2:.0f}" y="{height-6}" text-anchor="middle" class="axis-label">Launch day · shaded band = p05–p95</text>')
    parts.append("</svg>")
    return "".join(parts)


def build_html_report(
    config: dict[str, Any],
    observed_candles: pd.DataFrame,
    scenario_assumptions: pd.DataFrame,
    scenario_summary: pd.DataFrame,
    daily_summary: pd.DataFrame,
    diffusion: pd.DataFrame,
    target_frontier: pd.DataFrame,
    activity_thresholds: pd.DataFrame,
    validation: pd.DataFrame,
) -> str:
    target = float(config["trading"]["target_creator_fees_usd"])
    ticket = float(config["trading"]["average_transaction_usd"])
    curve_rate = float(config["trading"]["curve_fee_profile"]["creator"])
    required_volume = target / curve_rate
    required_transactions = required_volume / ticket
    bonus_rate = float(config["trading"]["post_grad_bonus_tier_profile"]["creator"])
    bonus_required_volume = target / bonus_rate
    bonus_required_transactions = bonus_required_volume / ticket
    incidence = incidence_exponential_calibration(config)
    stock = stock_exponential_calibration(config)
    diffusion_series = []
    for model_name, frame in diffusion.groupby("model", sort=False):
        diffusion_series.append(
            (
                model_name,
                frame["day"].to_numpy(dtype=float),
                frame["expected_cumulative_buyers"].to_numpy(dtype=float),
            )
        )
    diffusion_chart = svg_line_chart(
        diffusion_series,
        title="Calibrated diffusion models diverge after Day 7",
        y_label="Cumulative buyers",
    )
    fee_series = []
    for scenario_name, frame in daily_summary.groupby("scenario", sort=False):
        label = frame["scenario_label"].iloc[0]
        fee_series.append(
            (
                label,
                frame["day"].to_numpy(dtype=float),
                frame["cumulative_creator_fees_usd_p50"].to_numpy(dtype=float),
            )
        )
    fee_chart = svg_line_chart(
        fee_series,
        title="Median cumulative creator fees by scenario",
        y_label="$ creator fees",
        target_line=target,
    )
    momentum_fan = svg_fan_chart(
        daily_summary,
        scenario="stock_momentum",
        prefix="cumulative_creator_fees_usd",
        title="Stock-growth stress: creator-fee uncertainty",
        y_label="$ creator fees",
        target_line=target,
    )
    curve_frontier = target_frontier[
        target_frontier["future_fee_rate_case"] == "0.30% curve / low tier"
    ]
    frontier_series = []
    for participation, frame in curve_frontier.groupby("prior_buyer_daily_return_participation"):
        frontier_series.append(
            (
                f"{participation:.0%} prior-buyer participation",
                frame["day_14_cumulative_buyers"].to_numpy(dtype=float),
                frame["required_transactions_per_active_buyer_day"].to_numpy(dtype=float),
            )
        )
    frontier_chart = svg_line_chart(
        frontier_series,
        title="$5,000 frontier at 0.30%: buyers versus trading intensity",
        y_label="Required transactions / active buyer-day",
        x_label="Day-14 cumulative buyers · logarithmic scale",
        log_x=True,
    )

    summary_columns = [
        "scenario_label",
        "buyers_day_14_mean",
        "buyers_day_14_p05",
        "buyers_day_14_p50",
        "buyers_day_14_p95",
        "cumulative_creator_fees_day_14_p50",
        "probability_fee_target_by_day_14",
        "target_hit_day_median_conditional",
        "graduation_probability_by_day_14",
    ]
    summary_table = styled_table(
        scenario_summary,
        summary_columns,
        {
            "scenario_label": "Scenario",
            "buyers_day_14_mean": "Mean D14 buyers",
            "buyers_day_14_p05": "D14 buyers p05",
            "buyers_day_14_p50": "D14 buyers median",
            "buyers_day_14_p95": "D14 buyers p95",
            "cumulative_creator_fees_day_14_p50": "D14 creator fees median",
            "probability_fee_target_by_day_14": "P($5k by D14)",
            "target_hit_day_median_conditional": "Median hit day | hit",
            "graduation_probability_by_day_14": "P(graduation by D14)",
        },
    )
    selected_endpoints = {500.0, 777.38, 1415.01, 2500.0, 5000.0, 10000.0, 83334.0}
    frontier_snapshot = target_frontier[
        (target_frontier["prior_buyer_daily_return_participation"] == 0.60)
        & target_frontier["day_14_cumulative_buyers"].isin(selected_endpoints)
    ].copy()
    frontier_table = styled_table(
        frontier_snapshot,
        [
            "future_fee_rate_case",
            "day_14_cumulative_buyers",
            "post_day_7_daily_buyer_growth",
            "required_transactions_per_active_buyer_day",
            "required_turnover_per_active_buyer_day_usd",
            "remaining_transactions_divided_by_net_new_buyers",
        ],
        {
            "future_fee_rate_case": "Future fee sensitivity",
            "day_14_cumulative_buyers": "D14 buyers",
            "post_day_7_daily_buyer_growth": "Buyer growth/day after D7",
            "required_transactions_per_active_buyer_day": "Tx / active buyer-day",
            "required_turnover_per_active_buyer_day_usd": "Turnover / active buyer-day",
            "remaining_transactions_divided_by_net_new_buyers": "Remaining tx / net new buyer",
        },
    )
    observed_table = styled_table(
        observed_candles,
        [
            "day",
            "date",
            "volume_usd",
            "transaction_equivalents_at_average_ticket",
            "uniform_hourly_volume_usd",
            "creator_fees_usd",
            "close_market_cap_usd",
        ],
        {
            "day": "Launch day",
            "date": "Date",
            "volume_usd": "Observed volume",
            "transaction_equivalents_at_average_ticket": "$20 tx equivalents",
            "uniform_hourly_volume_usd": "Uniform $/hour",
            "creator_fees_usd": "Creator fees at 0.30%",
            "close_market_cap_usd": "Close market cap",
        },
    )
    assumptions_table = styled_table(
        scenario_assumptions,
        [
            "scenario_label",
            "diffusion",
            "carrying_capacity",
            "daily_repeat_participation_probability",
            "participation_age_decay",
            "trades_per_active_buyer",
            "buy_share_mean",
            "post_grad_creator_fee_rate",
        ],
        {
            "scenario_label": "Scenario",
            "diffusion": "Buyer process",
            "carrying_capacity": "Capacity",
            "daily_repeat_participation_probability": "Daily repeat participation",
            "participation_age_decay": "Age decay",
            "trades_per_active_buyer": "Requested tx / active buyer",
            "buy_share_mean": "Repeat-volume buy share",
            "post_grad_creator_fee_rate": "Post-grad creator rate",
        },
    )
    activity_threshold_table = styled_table(
        activity_thresholds,
        [
            "scenario_label",
            "buyers_day_14_p50",
            "target_hit_probability",
            "estimated_trades_per_active_buyer_day",
            "estimated_requested_turnover_per_active_buyer_day_usd",
            "lower_grid_trades",
            "upper_grid_trades",
        ],
        {
            "scenario_label": "Scenario",
            "buyers_day_14_p50": "D14 buyers median",
            "target_hit_probability": "Target probability",
            "estimated_trades_per_active_buyer_day": "Estimated tx / active buyer-day",
            "estimated_requested_turnover_per_active_buyer_day_usd": "Estimated turnover / active buyer-day",
            "lower_grid_trades": "Lower tested tx",
            "upper_grid_trades": "Upper tested tx",
        },
    )
    failures = int((validation["status"] != "PASS").sum())
    status_class = "ok" if failures == 0 else "bad"
    status_text = "All validation checks passed" if failures == 0 else f"{failures} validation checks failed"
    sources = config["sources"]
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NEAL Python Growth Model</title>
<style>
:root {{ --navy:#102A43; --navy2:#243B53; --teal:#2A9D8F; --gold:#D9A441; --ink:#172B4D; --muted:#5C677D; --line:#D9E2EC; --pale:#F5F8FB; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; color:var(--ink); background:#F8FAFC; font:14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
header {{ background:linear-gradient(120deg,var(--navy),var(--navy2)); color:white; padding:30px max(28px,calc((100vw - 1400px)/2)); }}
header h1 {{ margin:0 0 8px; font-size:30px; }}
header p {{ margin:0; color:#D9EAF7; }}
main {{ max-width:1400px; margin:auto; padding:24px; }}
.cards {{ display:grid; grid-template-columns:repeat(4,minmax(180px,1fr)); gap:14px; margin:0 0 22px; }}
.card,.panel {{ background:white; border:1px solid var(--line); border-radius:12px; box-shadow:0 5px 18px rgba(16,42,67,.05); }}
.card {{ padding:18px; }} .card .label {{ color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }}
.card .value {{ font-size:25px; font-weight:750; margin-top:4px; color:var(--navy); }}
.panel {{ padding:20px; margin:0 0 20px; overflow:auto; }}
.panel h2 {{ margin:0 0 12px; font-size:19px; }} .panel p {{ margin:8px 0; }}
.grid2 {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }}
svg {{ width:100%; min-width:640px; background:white; }} .grid {{ stroke:#D9E2EC; stroke-dasharray:3 4; }}
.tick,.legend {{ font-size:11px; fill:#5C677D; }} .axis-label {{ font-size:12px; fill:#334E68; }} .chart-title {{ font-size:16px; font-weight:700; fill:#102A43; }}
.target {{ stroke:#B42318; stroke-width:2; stroke-dasharray:7 5; }}
table.dataframe {{ border-collapse:collapse; width:100%; min-width:850px; }} table.dataframe th {{ position:sticky; top:0; background:#EAF2F8; color:#102A43; text-align:right; border-bottom:2px solid #334E68; padding:8px; white-space:nowrap; }}
table.dataframe th:first-child,table.dataframe td:first-child {{ text-align:left; }} table.dataframe td {{ border-bottom:1px solid #E6EDF3; padding:7px 8px; text-align:right; }}
.callout {{ border-left:5px solid var(--gold); background:#FFF9E8; padding:14px 16px; border-radius:8px; }}
.status {{ padding:12px 16px; border-radius:8px; font-weight:700; }} .ok {{ color:#0B6B3A; background:#E8F5E9; }} .bad {{ color:#9B1C1C; background:#FCE8E6; }}
.foot {{ color:var(--muted); font-size:12px; }} a {{ color:#1261A0; }}
@media(max-width:900px) {{ .cards,.grid2 {{ grid-template-columns:1fr; }} }}
</style>
</head>
<body>
<header><h1>NEAL Python Growth & Creator-Fee Model</h1><p>NumPy Monte Carlo · pandas DataFrames · launch-day calibration · model version {html.escape(config['model_version'])}</p></header>
<main>
<section class="cards">
  <div class="card"><div class="label">Creator-fee target</div><div class="value">${target:,.0f}</div></div>
  <div class="card"><div class="label">At 0.30%</div><div class="value">${required_volume:,.0f}</div><div>{required_transactions:,.0f} × ${ticket:,.0f} transactions</div></div>
  <div class="card"><div class="label">At 0.95%</div><div class="value">${bonus_required_volume:,.0f}</div><div>{bonus_required_transactions:,.0f} × ${ticket:,.0f} transactions</div></div>
  <div class="card"><div class="label">Validation</div><div class="value">{len(validation)-failures}/{len(validation)}</div></div>
</section>
<section class="panel"><div class="status {status_class}">{html.escape(status_text)}</div><div class="callout"><strong>The better baseline is daily incidence, not cumulative-stock extrapolation.</strong> Calibrating disjoint acquisition counts—22 over Days 1–3 and 78 over Days 4–7—implies {incidence.parameters['daily_incidence_growth']:.1%} daily incidence growth and about {incidence.expected_cumulative[13]:,.0f} buyers on Day 14. The earlier 46.0% stock-growth stress reaches {stock.expected_cumulative[13]:,.0f}; it is retained only as an upside stress case.</div></section>
<section class="panel"><h2>Completed daily candles</h2><p>Only volume, close market cap, and quantities derived directly from them are treated as observed. A $20 transaction equivalent is not a unique buyer.</p>{observed_table}</section>
<section class="panel"><h2>Monte Carlo scenario summary</h2><p>Every path is conditioned to exactly 22 cumulative buyers on Day 3 and 100 on Day 7 because those are user-supplied planning targets, not estimated observations. Ranges after Day 7 are conditional scenario bands—not fitted confidence intervals or investment forecasts.</p>{summary_table}</section>
<section class="panel"><h2>Scenario assumptions</h2>{assumptions_table}</section>
<section class="panel"><h2>Monte Carlo activity thresholds for $5,000 by Day 14</h2><p>These thresholds interpolate a finite trade-intensity grid while holding each scenario's buyer and repeat-participation assumptions fixed. They include transaction-size noise, buy/sell mix, graduation, and rejected curve-floor sells. Treat them as planning estimates within the displayed grid.</p>{activity_threshold_table}</section>
<section class="grid2"><div class="panel">{diffusion_chart}</div><div class="panel">{fee_chart}</div></section>
<section class="grid2"><div class="panel">{momentum_fan}</div><div class="panel">{frontier_chart}</div></section>
<section class="panel"><h2>Buyer-rate frontier at 60% daily prior-buyer participation</h2><p>This table directly answers the buyer-rate question under two rate sensitivities. The 0.30% rows are the conservative throughout-path frontier. The 0.95% rows are an arithmetic upper-fee sensitivity as though all remaining turnover earned that rate; real paths cannot use 0.95% before graduation and only qualify while a canonical pool is in the documented 420–1,470 SOL tier.</p>{frontier_table}</section>
<section class="panel"><h2>How the model works</h2><ul>
<li><strong>Diffusion:</strong> incidence-exponential, strict-zero logistic, stock-growth stress, and delayed referral-renewal alternatives are multinomial-bridged through the Day-3 and Day-7 planning targets. After Day 7, buyer counts use integer overdispersed draws.</li>
<li><strong>People:</strong> repeat activity is age-dependent daily participation with possible reactivation, not survival retention. Saturation, dispersion, and referral parameters are scenario assumptions.</li>
<li><strong>Trading:</strong> every new buyer gets a buy-side acquisition trade; additional trades use an overdispersed Gamma-Poisson activity process. Aggregate transaction sizes are Gamma-distributed with arithmetic mean ${ticket:,.0f}.</li>
<li><strong>Fees:</strong> creator, protocol, LP, treasury, and dev amounts are computed only on executed gross turnover. Primary paths remain at the documented 0.30% creator tier after graduation because post-graduation pool depth is unavailable; 0.95% appears only as an explicitly labeled frontier sensitivity.</li>
<li><strong>Market cap:</strong> signed buy-minus-sell flow moves the pre-graduation constant-product reserves. The market-cap proxy freezes at graduation because canonical PumpSwap depth is not available; it is not silently invented.</li>
<li><strong>Uniform candles:</strong> modeled activity is uniform within each daily candle, enabling hourly rates and fractional-day target times. It does not imply a uniform price path.</li>
<li><strong>Observed volume:</strong> volume divided by ${ticket:,.0f} is labeled a transaction equivalent. Daily candle volume cannot identify unique buyers without wallet-level data.</li>
<li><strong>USD conversion:</strong> creator fees are accrued in SOL and converted to USD-at-accrual with a fixed ${float(config['market']['sol_usd']):,.2f} SOL/USD scenario rate.</li>
</ul></section>
<section class="panel"><h2>Limitations and sources</h2><p>Two milestone targets cannot identify saturation, a causal referral coefficient, dispersion, repeat participation, trade intensity, or buy/sell propensity. Buyer figures are modeled people, not verified wallets. Market cap is not invested cash, creator-fee accrual is not net income, and the 42% treasury allocation remains a modeled obligation unless routing is confirmed. The separate 0.015 SOL migration charge is not creator revenue and is excluded.</p>
<p class="foot">Sources: <a href="{html.escape(sources['pump_fees'])}">Pump fee schedule</a> · <a href="{html.escape(sources['pump_bonding_curve'])}">Pump bonding-curve documentation</a> · <a href="{html.escape(sources['gecko_daily_ohlcv'])}">GeckoTerminal daily OHLCV endpoint</a> · <a href="{html.escape(sources['launch_record'])}">NEAL launch record</a>.</p></section>
</main></body></html>"""


def write_outputs(config: dict[str, Any], output_dir: Path, simulations: int, seed: int) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    observed_candles = build_observed_candles(config)
    scenario_assumptions = build_scenario_assumptions(config)
    diffusion, comparison_calibrations = build_diffusion_comparison(config)
    target_frontier = build_target_frontier(config)
    sweep_simulations = min(simulations, int(config["probability_sweep"]["simulations"]))
    probability_sweep, activity_thresholds = build_probability_sweep(
        config,
        sweep_simulations,
        seed,
    )
    scenario_calibrations: list[Calibration] = []
    scenario_summaries: list[dict[str, Any]] = []
    daily_frames: list[pd.DataFrame] = []
    milestones: list[dict[str, Any]] = []
    validations: list[dict[str, Any]] = []
    root_seed = np.random.SeedSequence(seed)
    scenario_seeds = root_seed.spawn(len(config["scenarios"]))

    for scenario, scenario_seed in zip(config["scenarios"], scenario_seeds):
        calibration = calibration_for_scenario(config, scenario)
        scenario_calibrations.append(calibration)
        result = simulate_scenario(config, scenario, calibration, simulations, scenario_seed)
        scenario_summaries.append(summarize_scenario(config, result))
        daily_frames.append(summarize_daily(config, result))
        milestones.extend(milestone_rows(config, result))
        validations.extend(validation_rows(config, result))

    scenario_summary = pd.DataFrame(scenario_summaries)
    daily_summary = pd.concat(daily_frames, ignore_index=True)
    milestone_report = pd.DataFrame(milestones)
    validation = pd.DataFrame(validations)
    calibration_report = calibration_rows(config, comparison_calibrations + scenario_calibrations)

    observed_candles.to_csv(output_dir / "observed_candles.csv", index=False)
    scenario_assumptions.to_csv(output_dir / "scenario_assumptions.csv", index=False)
    diffusion.to_csv(output_dir / "diffusion_comparison.csv", index=False)
    scenario_summary.to_csv(output_dir / "scenario_summary.csv", index=False)
    daily_summary.to_csv(output_dir / "daily_simulation_summary.csv", index=False)
    milestone_report.to_csv(output_dir / "milestone_report.csv", index=False)
    target_frontier.to_csv(output_dir / "target_frontier.csv", index=False)
    probability_sweep.to_csv(output_dir / "probability_sweep.csv", index=False)
    activity_thresholds.to_csv(output_dir / "activity_thresholds.csv", index=False)
    calibration_report.to_csv(output_dir / "calibration_report.csv", index=False)
    validation.to_csv(output_dir / "validation_checks.csv", index=False)

    metadata = {
        "model_version": config["model_version"],
        "simulations_per_scenario": simulations,
        "seed": seed,
        "horizon_days": config["horizon_days"],
        "report_day": config["report_day"],
        "probability_sweep_simulations_per_grid_point": sweep_simulations,
        "numpy_version": np.__version__,
        "pandas_version": pd.__version__,
        "all_checks_passed": bool((validation["status"] == "PASS").all()),
        "failed_checks": validation.loc[validation["status"] != "PASS", ["scenario", "check"]].to_dict("records"),
    }
    (output_dir / "run_metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    report = build_html_report(
        config,
        observed_candles,
        scenario_assumptions,
        scenario_summary,
        daily_summary,
        diffusion,
        target_frontier,
        activity_thresholds,
        validation,
    )
    (output_dir / "report.html").write_text(report, encoding="utf-8")
    if not metadata["all_checks_passed"]:
        raise RuntimeError(f"model validation failed: {metadata['failed_checks']}")


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=root / "config.json")
    parser.add_argument("--output-dir", type=Path, default=root / "outputs")
    parser.add_argument("--simulations", type=int, default=None)
    parser.add_argument("--seed", type=int, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = load_config(args.config)
    simulations = int(args.simulations or config["simulations"])
    seed = int(args.seed or config["seed"])
    if simulations < 100:
        raise ValueError("simulations must be at least 100")
    write_outputs(config, args.output_dir, simulations, seed)
    print(f"Wrote model outputs to {args.output_dir.resolve()}")


if __name__ == "__main__":
    main()
