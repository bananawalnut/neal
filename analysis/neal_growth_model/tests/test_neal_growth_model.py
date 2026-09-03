from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd


MODEL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODEL_ROOT))

import neal_growth_model as model  # noqa: E402


class NealGrowthModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = model.load_config(MODEL_ROOT / "config.json")

    def test_deterministic_calibrations_hit_both_milestones(self) -> None:
        calibrations = [
            model.incidence_exponential_calibration(self.config),
            model.stock_exponential_calibration(self.config),
            model.shifted_logistic_calibration(self.config, 500.0),
            model.branching_calibration(self.config, self.config["scenarios"][3]),
        ]
        for calibration in calibrations:
            self.assertAlmostEqual(calibration.expected_cumulative[2], 22.0, places=7)
            self.assertAlmostEqual(calibration.expected_cumulative[6], 100.0, places=7)

    def test_conditioned_paths_hit_milestones_exactly(self) -> None:
        for index, scenario in enumerate(self.config["scenarios"]):
            calibration = model.calibration_for_scenario(self.config, scenario)
            result = model.simulate_scenario(
                self.config,
                scenario,
                calibration,
                400,
                np.random.SeedSequence(1000 + index),
            )
            np.testing.assert_array_equal(result.cumulative_buyers[:, 2], 22)
            np.testing.assert_array_equal(result.cumulative_buyers[:, 6], 100)

    def test_execution_and_reserve_roll_forward_reconcile(self) -> None:
        scenario = self.config["scenarios"][2]
        calibration = model.calibration_for_scenario(self.config, scenario)
        result = model.simulate_scenario(
            self.config,
            scenario,
            calibration,
            500,
            np.random.SeedSequence(20260903),
        )
        np.testing.assert_allclose(
            result.requested_volume_usd,
            result.gross_volume_usd + result.unfilled_sell_volume_usd,
            atol=1e-7,
            rtol=0.0,
        )
        self.assertTrue(
            np.all(result.buy_volume_usd[:, 2:] + 1e-9 >= result.acquisition_volume_usd[:, 2:])
        )
        reserve_delta = result.virtual_sol_reserve[:, 2:] - result.virtual_sol_reserve[:, 1:-1]
        modeled_delta = (
            result.curve_signed_flow_usd[:, 2:]
            / float(self.config["market"]["sol_usd"])
            * float(self.config["market"]["net_flow_capture"])
        )
        np.testing.assert_allclose(reserve_delta, modeled_delta, atol=1e-10, rtol=0.0)

    def test_seeded_simulation_is_reproducible(self) -> None:
        scenario = self.config["scenarios"][1]
        calibration = model.calibration_for_scenario(self.config, scenario)
        left = model.simulate_scenario(
            self.config,
            scenario,
            calibration,
            250,
            np.random.SeedSequence(77),
        )
        right = model.simulate_scenario(
            self.config,
            scenario,
            calibration,
            250,
            np.random.SeedSequence(77),
        )
        np.testing.assert_array_equal(left.new_buyers, right.new_buyers)
        np.testing.assert_array_equal(left.transactions, right.transactions)
        np.testing.assert_array_equal(left.creator_fees_usd, right.creator_fees_usd)

    def test_target_frontier_fee_arithmetic(self) -> None:
        frontier = model.build_target_frontier(self.config)
        historical_fees = sum(
            row["volume_usd"] * self.config["trading"]["curve_fee_profile"]["creator"]
            for row in self.config["historical_daily"]
        )
        remaining_fees = self.config["trading"]["target_creator_fees_usd"] - historical_fees
        for fee_case, rate in (
            ("0.30% curve / low tier", 0.003),
            ("0.95% all-future-volume upper sensitivity", 0.0095),
        ):
            values = frontier.loc[
                frontier["future_fee_rate_case"] == fee_case,
                "remaining_transactions_required",
            ].unique()
            self.assertEqual(len(values), 1)
            self.assertAlmostEqual(values[0], remaining_fees / rate / 20.0, places=7)

    def test_full_output_contract(self) -> None:
        with tempfile.TemporaryDirectory(prefix="neal-growth-test-") as temporary:
            output = Path(temporary)
            model.write_outputs(self.config, output, simulations=150, seed=12345)
            expected = {
                "observed_candles.csv",
                "scenario_assumptions.csv",
                "diffusion_comparison.csv",
                "scenario_summary.csv",
                "daily_simulation_summary.csv",
                "milestone_report.csv",
                "target_frontier.csv",
                "probability_sweep.csv",
                "activity_thresholds.csv",
                "calibration_report.csv",
                "validation_checks.csv",
                "run_metadata.json",
                "report.html",
            }
            self.assertEqual({path.name for path in output.iterdir()}, expected)
            metadata = json.loads((output / "run_metadata.json").read_text(encoding="utf-8"))
            self.assertTrue(metadata["all_checks_passed"])
            checks = pd.read_csv(output / "validation_checks.csv")
            self.assertTrue((checks["status"] == "PASS").all())


if __name__ == "__main__":
    unittest.main()
