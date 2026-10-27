#!/usr/bin/env python3
"""Tests of count-cases.py. Run: python3 test_count_cases.py"""
import importlib.util
import pathlib
import unittest

_spec = importlib.util.spec_from_file_location(
    "count_cases", pathlib.Path(__file__).resolve().parent / "count-cases.py")
count_cases = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(count_cases)

PLAN = """# Regression plan

## smoke

| ID | Bước | Kỳ vọng | Nguồn |
|---|---|---|---|
| SMOKE-01 | a | b | c |
| SMOKE-02 | a | b | c |

## firewall

| FW-01 | a | b | c |
| FW-02 | a | b | c |
| FW-03 | a | b | c |
| FW-04 (host) | a | b | c |

## site — trang không đăng nhập

| SITE-01 | a | b | c |
"""

LOG = """
  ✓  1 [chromium] › e2e/smoke.spec.ts:10:7 › smoke › SMOKE-01..02 health and clusters (1.0s)
  ✓  2 [chromium] › e2e/firewall.spec.ts:84:7 › firewall › FW-01 a rule is 201 (1.5m)
  ✘  3 [chromium] › e2e/firewall.spec.ts:124:7 › firewall › FW-02 quota (2.2m)
  -  4 [chromium] › e2e/firewall.spec.ts:142:7 › firewall › FW-03 an unknown ruleId is 404
  ✓  5 [chromium] › e2e/firewall.spec.ts:150:7 › firewall › FW-03 again (1s)
  1) [chromium] › e2e/firewall.spec.ts:124:7 › firewall › FW-02 quota
"""


class PlanIds(unittest.TestCase):
    def test_ids_are_grouped_by_the_first_word_of_the_heading(self):
        self.assertEqual(count_cases.plan_ids(PLAN), {
            "smoke": ["SMOKE-01", "SMOKE-02"],
            "firewall": ["FW-01", "FW-02", "FW-03", "FW-04"],
            "site": ["SITE-01"],
        })


class LogMarks(unittest.TestCase):
    def test_a_range_in_a_title_marks_every_id_in_it(self):
        marks = count_cases.log_marks(LOG)
        self.assertEqual(marks["SMOKE-01"], "pass")
        self.assertEqual(marks["SMOKE-02"], "pass")

    def test_the_failure_summary_line_is_not_a_result(self):
        # "  1) [chromium] › … FW-02" repeats a failure; only the ✘ line counts.
        self.assertEqual(count_cases.log_marks(LOG)["FW-02"], "fail")

    def test_the_worst_mark_wins_when_an_id_has_several_tests(self):
        self.assertEqual(count_cases.log_marks(LOG)["FW-03"], "skip")

    def test_an_ellipsis_range_is_expanded_too(self):
        marks = count_cases.log_marks("  ✓  1 [chromium] › a.spec.ts:1:1 › vm › SSH-01…03 keys (1s)\n")
        self.assertEqual(sorted(marks), ["SSH-01", "SSH-02", "SSH-03"])


class Tally(unittest.TestCase):
    def test_ids_without_a_line_are_listed_per_module(self):
        rows, unseen, extra = count_cases.tally(count_cases.plan_ids(PLAN), count_cases.log_marks(LOG))
        self.assertEqual(rows["firewall"], {"plan": 4, "pass": 1, "fail": 1, "skip": 1, "unseen": 1})
        self.assertEqual(rows["smoke"], {"plan": 2, "pass": 2, "fail": 0, "skip": 0, "unseen": 0})
        self.assertEqual(unseen, {"firewall": ["FW-04"], "site": ["SITE-01"]})
        self.assertEqual(extra, [])

    def test_an_id_in_a_log_but_not_in_the_plan_is_reported(self):
        marks = count_cases.log_marks("  ✓  1 [chromium] › a.spec.ts:1:1 › x › ZZ-09 stray (1s)\n")
        _, _, extra = count_cases.tally(count_cases.plan_ids(PLAN), marks)
        self.assertEqual(extra, ["ZZ-09"])


class TwoLanes(unittest.TestCase):
    """Both lanes' runner.log go into one count: an ID is counted once, with its worst mark."""

    LANE_A = "  ✓  1 [chromium] › e2e/smoke.spec.ts:10:7 › smoke › SMOKE-01..02 health (1s)\n" + \
             "  ✓  2 [chromium] › e2e/firewall.spec.ts:84:7 › firewall › FW-01 rule (1s)\n"
    LANE_B = "  ✓  1 [chromium] › e2e/smoke.spec.ts:10:7 › smoke › SMOKE-01 health (1s)\n" + \
             "  ✘  2 [chromium] › e2e/smoke.spec.ts:20:7 › smoke › SMOKE-02 clusters (1s)\n"

    def test_an_id_both_lanes_ran_is_counted_once_with_the_worst_mark(self):
        merged = count_cases.merge_marks([count_cases.log_marks(self.LANE_A), count_cases.log_marks(self.LANE_B)])
        self.assertEqual(merged["SMOKE-01"], "pass")
        self.assertEqual(merged["SMOKE-02"], "fail")
        rows, _, _ = count_cases.tally(count_cases.plan_ids(PLAN), merged)
        self.assertEqual((rows["smoke"]["pass"], rows["smoke"]["fail"]), (1, 1))

    def test_the_order_of_the_logs_does_not_matter(self):
        a, b = count_cases.log_marks(self.LANE_A), count_cases.log_marks(self.LANE_B)
        self.assertEqual(count_cases.merge_marks([a, b]), count_cases.merge_marks([b, a]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
