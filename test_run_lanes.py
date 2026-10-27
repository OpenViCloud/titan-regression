#!/usr/bin/env python3
"""Tests of run-lanes.py. Run: python3 test_run_lanes.py"""
import importlib.util
import json
import pathlib
import re
import tempfile
import threading
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("run_lanes", HERE / "run-lanes.py")
run_lanes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run_lanes)


def plan_of(lanes, **extra):
    body = {"max_pods": 2, "abort_on": ["smoke"], "agent_side": [], "exclusive": [], "lanes": lanes}
    body.update(extra)
    return body


def lane(*steps, cronjob="titan-regression"):
    return {"cronjob": cronjob, "steps": list(steps)}


def m(name, **flags):
    return {"module": name, **flags}


class Fake:
    """A runner that records what ran, how many ran at once, and returns scripted exit codes."""

    def __init__(self, codes=None, nap=0.0):
        self.codes = codes or {}
        self.nap = nap
        self.calls = []
        self.running = 0
        self.most = 0
        self.lock = threading.Lock()

    def __call__(self, lane_name, cronjob, module, label):
        with self.lock:
            self.calls.append((lane_name, module))
            self.running += 1
            self.most = max(self.most, self.running)
        time.sleep(self.nap)
        with self.lock:
            self.running -= 1
        return self.codes.get((lane_name, module), 0)

    def ran(self, lane_name, module):
        return (lane_name, module) in self.calls


def run(plan, runner, ext=None, **kw):
    kw.setdefault("poll", 0.01)
    kw.setdefault("external_timeout", 2.0)
    with tempfile.TemporaryDirectory() as tmp:
        outcome = run_lanes.execute(run_lanes.load_plan(plan), runner, pathlib.Path(ext or tmp), join_timeout=5.0, **kw)
        # A lane thread still alive after the timeout is a hang, not a pass.
        hung = [t.name for t in threading.enumerate() if t.name.startswith("lane-")]
        if hung:
            raise AssertionError(f"lanes still running after 5 s: {hung}")
        return outcome


class GateTest(unittest.TestCase):
    def test_smoke_red_in_one_lane_stops_both_lanes_before_module_two(self):
        plan = plan_of({
            "a": lane(m("smoke"), {"barrier": "smoke"}, m("catalog")),
            "b": lane(m("smoke"), {"barrier": "smoke"}, m("billing")),
        })
        fake = Fake(codes={("a", "smoke"): 1}, nap=0.02)
        result = run(plan, fake)
        self.assertTrue(result.aborted)
        self.assertFalse(fake.ran("a", "catalog"))
        self.assertFalse(fake.ran("b", "billing"))
        self.assertEqual(result.exit_code, 1)

    def test_a_barrier_holds_the_fast_lane_until_the_slow_lane_arrives(self):
        plan = plan_of({
            "a": lane(m("smoke"), {"barrier": "smoke"}, m("catalog")),
            "b": lane(m("smoke"), {"barrier": "smoke"}, m("catalog")),
        })
        order = []
        lock = threading.Lock()

        def runner(lane_name, cronjob, module, label):
            with lock:
                order.append(("start", lane_name, module))
            time.sleep(0.15 if (lane_name, module) == ("b", "smoke") else 0.0)
            with lock:
                order.append(("end", lane_name, module))
            return 0

        run(plan, runner)
        b_smoke_end = order.index(("end", "b", "smoke"))
        self.assertLess(b_smoke_end, order.index(("start", "a", "catalog")))
        self.assertLess(b_smoke_end, order.index(("start", "b", "catalog")))


class FailureTest(unittest.TestCase):
    def test_a_red_module_skips_the_rest_of_its_lane_but_cleanup_still_runs(self):
        plan = plan_of({
            "a": lane(m("vm"), m("firewall"), m("cleanup", always=True)),
            "b": lane(m("billing"), m("cli")),
        })
        fake = Fake(codes={("a", "vm"): 1})
        result = run(plan, fake)
        self.assertFalse(fake.ran("a", "firewall"))
        self.assertTrue(fake.ran("a", "cleanup"))
        self.assertTrue(fake.ran("b", "billing"))
        self.assertTrue(fake.ran("b", "cli"))
        self.assertFalse(result.aborted)
        self.assertEqual(result.exit_code, 1)
        self.assertIn("a/firewall", result.skipped)

    def test_a_cleanup_marked_only_if_failed_runs_after_a_red_module_only(self):
        steps = [m("terraform-provider"), m("cleanup", label="after-tf", only_if_failed="terraform-provider")]
        red = Fake(codes={("a", "terraform-provider"): 1})
        run(plan_of({"a": lane(*steps)}), red)
        self.assertTrue(red.ran("a", "cleanup"))
        green = Fake()
        run(plan_of({"a": lane(*steps)}), green)
        self.assertFalse(green.ran("a", "cleanup"))

    def test_a_wait_holds_the_lane_until_the_other_lane_has_signalled(self):
        plan = plan_of({
            "a": lane({"wait": "billing-done"}, m("contract")),
            "b": lane(m("billing"), {"signal": "billing-done"}),
        })
        order = []
        lock = threading.Lock()

        def runner(lane_name, cronjob, module, label):
            with lock:
                order.append(("start", module))
            time.sleep(0.15 if module == "billing" else 0.0)
            with lock:
                order.append(("end", module))
            return 0

        run(plan, runner)
        self.assertLess(order.index(("end", "billing")), order.index(("start", "contract")))

    def test_a_lane_that_failed_still_fires_its_signals_so_the_other_lane_does_not_hang(self):
        plan = plan_of({
            "a": lane({"wait": "billing-done"}, m("contract")),
            "b": lane(m("billing"), {"signal": "billing-done"}),
        })
        fake = Fake(codes={("b", "billing"): 1})
        result = run(plan, fake)
        self.assertTrue(fake.ran("a", "contract"))
        self.assertEqual(result.exit_code, 1)


class PodLimitTest(unittest.TestCase):
    def two_lanes(self):
        return {"a": lane(m("vm"), m("volume")), "b": lane(m("billing"), m("cli"))}

    def test_never_more_jobs_at_once_than_max_pods(self):
        fake = Fake(nap=0.03)
        run(plan_of(self.two_lanes(), max_pods=1), fake)
        self.assertEqual(fake.most, 1)

    def test_two_lanes_do_run_side_by_side_when_two_pods_are_allowed(self):
        fake = Fake(nap=0.05)
        run(plan_of(self.two_lanes(), max_pods=2), fake)
        self.assertEqual(fake.most, 2)


class ExternalStepTest(unittest.TestCase):
    def test_an_external_step_waits_for_its_done_file(self):
        plan = plan_of({"a": lane({"external": "seed"}, m("billing"))})
        with tempfile.TemporaryDirectory() as tmp:
            fake = Fake()
            threading.Timer(0.1, lambda: (pathlib.Path(tmp) / "seed.done").touch()).start()
            started = time.time()
            run(plan, fake, ext=tmp)
            self.assertGreaterEqual(time.time() - started, 0.09)
            self.assertTrue(fake.ran("a", "billing"))

    def test_an_external_step_that_never_finishes_fails_the_lane_and_names_the_step(self):
        plan = plan_of({"a": lane({"external": "seed"}, m("billing"), m("cleanup", always=True))})
        fake = Fake()
        result = run(plan, fake, external_timeout=0.1)
        self.assertFalse(fake.ran("a", "billing"))
        self.assertTrue(fake.ran("a", "cleanup"))
        self.assertEqual(result.exit_code, 1)
        self.assertIn("a/external:seed", result.timed_out)


class PlanValidationTest(unittest.TestCase):
    def overlapping(self):
        return plan_of({
            "a": lane(m("concurrency")),
            "b": lane(m("billing")),
        }, exclusive=[["billing", "concurrency"]])

    def test_a_plan_where_two_exclusive_modules_may_overlap_is_refused(self):
        with self.assertRaises(run_lanes.PlanError) as caught:
            run_lanes.load_plan(self.overlapping())
        self.assertIn("billing", str(caught.exception))
        self.assertIn("concurrency", str(caught.exception))

    def test_a_signal_and_a_wait_order_the_two_modules_and_the_plan_is_accepted(self):
        plan = plan_of({
            "a": lane({"wait": "billing-done"}, m("concurrency")),
            "b": lane(m("billing"), {"signal": "billing-done"}),
        }, exclusive=[["billing", "concurrency"]])
        run_lanes.load_plan(plan)

    def test_the_wait_must_come_after_the_signal_in_causal_order_not_only_by_name(self):
        plan = plan_of({
            "a": lane({"wait": "billing-done"}, m("concurrency")),
            "b": lane({"signal": "billing-done"}, m("billing")),
        }, exclusive=[["billing", "concurrency"]])
        with self.assertRaises(run_lanes.PlanError):
            run_lanes.load_plan(plan)

    def test_a_barrier_orders_everything_before_it_with_everything_after_it(self):
        plan = plan_of({
            "a": lane(m("billing"), {"barrier": "x"}),
            "b": lane({"barrier": "x"}, m("concurrency")),
        }, exclusive=[["billing", "concurrency"]])
        run_lanes.load_plan(plan)

    def test_a_wait_with_no_signal_is_refused(self):
        with self.assertRaises(run_lanes.PlanError):
            run_lanes.load_plan(plan_of({"a": lane({"wait": "nobody"}, m("vm"))}))

    def test_a_barrier_missing_from_a_lane_is_refused(self):
        plan = plan_of({"a": lane({"barrier": "smoke"}, m("vm")), "b": lane(m("billing"))})
        with self.assertRaises(run_lanes.PlanError):
            run_lanes.load_plan(plan)

    def test_a_step_with_two_kinds_is_refused(self):
        with self.assertRaises(run_lanes.PlanError):
            run_lanes.load_plan(plan_of({"a": lane({"module": "vm", "signal": "x"})}))


def shared_data_rows(markdown):
    """{module: {lanes}} from the table under `## Dữ liệu dùng chung giữa các lane`: `| `module` | a, b | … |`."""
    section = markdown.split("## Dữ liệu dùng chung giữa các lane", 1)
    if len(section) != 2:
        raise AssertionError("no section 'Dữ liệu dùng chung giữa các lane'")
    rows = {}
    for line in section[1].split("\n## ", 1)[0].splitlines():
        cells = [c.strip() for c in line.split("|")]
        if len(cells) >= 4 and re.fullmatch(r"`[a-z-]+`", cells[1]):
            rows[cells[1].strip("`")] = {lane.strip() for lane in cells[2].split(",")}
    return rows


class SameLaneTest(unittest.TestCase):
    """Modules that take from one cluster-wide pool (an IPv6 /64) must not be spread over lanes."""

    def test_modules_of_a_same_lane_group_in_two_lanes_are_refused(self):
        plan = plan_of({"a": lane(m("load-balancer")), "b": lane(m("terraform-provider"))},
                       same_lane=[["load-balancer", "terraform-provider"]])
        with self.assertRaises(run_lanes.PlanError) as caught:
            run_lanes.load_plan(plan)
        self.assertIn("load-balancer", str(caught.exception))

    def test_modules_of_a_same_lane_group_in_one_lane_are_accepted(self):
        run_lanes.load_plan(plan_of({"a": lane(m("load-balancer"), m("terraform-provider")), "b": lane(m("billing"))},
                                    same_lane=[["load-balancer", "terraform-provider"]]))


README = """## Modules and order

| # | Module | Measures | Dev | Staging | Spec |
|---|---|---|---|---|---|
| 1 | `smoke` | health | yes | yes | yes |
| 2 | `billing` | money | no | yes | yes |
| 3 | `worker` | image, reads on the agent's machine | no | yes | no |
| 4 | `login-page` | page | yes | yes | yes |
| 5 | `only-on-dev` | x | yes | no | yes |
"""


class CoverageTest(unittest.TestCase):
    def test_a_runner_module_in_no_lane_is_reported(self):
        plan = run_lanes.load_plan(plan_of({"a": lane(m("smoke"), m("billing"))}, agent_side=["worker"]))
        self.assertEqual(run_lanes.coverage_problems(plan, README), ["login-page is in the README and in no lane"])

    def test_a_module_in_two_lanes_is_reported(self):
        plan = run_lanes.load_plan(plan_of({
            "a": lane(m("smoke"), m("billing")),
            "b": lane(m("billing"), m("login-page")),
        }, agent_side=["worker"]))
        self.assertEqual(run_lanes.coverage_problems(plan, README), ["billing is in 2 lanes"])

    def test_a_lane_module_that_the_readme_does_not_know_is_reported(self):
        plan = run_lanes.load_plan(plan_of({"a": lane(m("smoke"), m("billing"), m("login-page"), m("typo"))},
                                           agent_side=["worker"]))
        self.assertEqual(run_lanes.coverage_problems(plan, README), ["typo is in a lane and not in the README"])

    def test_a_per_lane_module_missing_from_a_lane_is_reported(self):
        plan = run_lanes.load_plan(plan_of({
            "a": lane(m("smoke"), m("billing"), m("login-page")),
            "b": lane(m("billing-b-only-here")),
        }, agent_side=["worker"], per_lane=["smoke"]))
        self.assertIn("smoke must run once in lane b, runs 0 times", run_lanes.coverage_problems(plan, README))

    def test_a_per_lane_module_in_every_lane_once_is_clean(self):
        plan = run_lanes.load_plan(plan_of({
            "a": lane(m("smoke"), m("billing"), m("login-page")),
            "b": lane(m("smoke")),
        }, agent_side=["worker"], per_lane=["smoke"]))
        self.assertEqual(run_lanes.coverage_problems(plan, README), [])

    def test_a_clean_plan_has_no_problems(self):
        plan = run_lanes.load_plan(plan_of({"a": lane(m("smoke"), m("billing"), m("login-page"))}, agent_side=["worker"]))
        self.assertEqual(run_lanes.coverage_problems(plan, README), [])


class DevColumnTest(unittest.TestCase):
    """Dev runs fewer modules than staging; a plan for dev is checked against the Dev column."""

    def test_the_dev_column_picks_the_modules_dev_runs(self):
        self.assertEqual(run_lanes.readme_modules(README, "dev"), ["smoke", "login-page", "only-on-dev"])
        self.assertEqual(run_lanes.readme_modules(README), ["smoke", "billing", "worker", "login-page"])

    def test_a_dev_plan_is_clean_against_dev_and_wrong_against_staging(self):
        plan = run_lanes.load_plan(plan_of({"a": lane(m("smoke"), m("only-on-dev"), m("login-page"))}))
        self.assertEqual(run_lanes.coverage_problems(plan, README, "dev"), [])
        self.assertNotEqual(run_lanes.coverage_problems(plan, README), [])

    def test_the_repos_dev_plans_cover_the_dev_column(self):
        text = (HERE / "README.md").read_text()
        for name in ("lanes-dev.json", "lanes-dev-sequential.json"):
            plan = run_lanes.load_plan(json.loads((HERE / name).read_text()))
            self.assertEqual(run_lanes.coverage_problems(plan, text, "dev"), [], name)


class EvidenceDirTest(unittest.TestCase):
    """Where a module's logs land: a module both lanes run must not share one directory."""

    def test_a_module_both_lanes_run_gets_a_directory_per_lane(self):
        root = pathlib.Path("/evidence")
        a = run_lanes.log_dir(root, "a", "smoke", "", {"smoke", "cleanup"})
        b = run_lanes.log_dir(root, "b", "smoke", "", {"smoke", "cleanup"})
        self.assertNotEqual(a, b)

    def test_a_module_one_lane_runs_keeps_the_plain_name_the_release_cites(self):
        self.assertEqual(run_lanes.log_dir(pathlib.Path("/evidence"), "b", "billing", "", {"smoke"}),
                         pathlib.Path("/evidence/billing"))

    def test_a_second_run_of_a_module_with_a_label_gets_its_own_directory(self):
        root = pathlib.Path("/evidence")
        self.assertNotEqual(run_lanes.log_dir(root, "a", "cleanup", "", {"cleanup"}),
                            run_lanes.log_dir(root, "a", "cleanup", "after-tf", {"cleanup"}))


class ClusterRunnerTest(unittest.TestCase):
    """What the job script is told: the CronJob of the lane and the lane's name (its evidence logs carry it)."""

    def call(self, lane, cronjob):
        seen = {}

        def fake_run(command, **kw):
            seen["env"] = kw["env"]
            return type("Done", (), {"returncode": 0})()

        with tempfile.TemporaryDirectory() as tmp:
            runner = run_lanes.ClusterRunner("kc", "src", tmp, tmp, "r1", {}, set())
            original = run_lanes.subprocess.run
            run_lanes.subprocess.run = fake_run
            try:
                runner(lane, cronjob, "billing", "")
            finally:
                run_lanes.subprocess.run = original
        return seen["env"]

    def test_the_job_script_gets_the_cronjob_and_the_lane_name(self):
        env = self.call("b", "titan-regression-b")
        self.assertEqual(env["REGRESSION_CRONJOB"], "titan-regression-b")
        self.assertEqual(env["REGRESSION_LANE"], "b")


class JobScriptTest(unittest.TestCase):
    def test_the_system_logs_name_their_lane_on_the_first_line(self):
        script = (HERE / "run-module.sh").read_text()
        self.assertIn('lane="${REGRESSION_LANE:-sequential}"', script)
        header = [line for line in script.splitlines() if line.lstrip().startswith('echo "# kubectl logs')]
        self.assertEqual(len(header), 1)
        self.assertIn("(lane $lane)", header[0])


class RepoPlanTest(unittest.TestCase):
    """The lanes.json this repository ships."""

    @classmethod
    def setUpClass(cls):
        cls.body = json.loads((HERE / "lanes.json").read_text())
        cls.plan = run_lanes.load_plan(cls.body)

    def test_every_staging_module_of_the_readme_is_in_exactly_one_lane_or_is_agent_side(self):
        self.assertEqual(run_lanes.coverage_problems(self.plan, (HERE / "README.md").read_text()), [])

    def test_terraform_provider_runs_after_cleanup_in_its_own_lane(self):
        for steps in (l["steps"] for l in self.body["lanes"].values()):
            names = [s.get("module") for s in steps if "module" in s and "label" not in s]
            if "terraform-provider" in names:
                self.assertGreater(names.index("terraform-provider"), names.index("cleanup"))
                return
        self.fail("terraform-provider is in no lane")

    def test_smoke_opens_every_lane_and_is_followed_by_the_barrier(self):
        for steps in (l["steps"] for l in self.body["lanes"].values()):
            self.assertEqual(steps[0], {"module": "smoke"})
            self.assertEqual(steps[1], {"barrier": "smoke"})

    def test_the_wallet_pair_and_the_pending_topup_pair_are_declared_exclusive(self):
        groups = [set(group) for group in self.body["exclusive"]]
        self.assertIn({"billing", "concurrency"}, groups)
        self.assertIn({"billing", "admin"}, groups)
        run_lanes.load_plan(self.body)

    def test_contract_moves_no_wallet_and_is_in_no_exclusive_group(self):
        self.assertFalse(any("contract" in group for group in self.body["exclusive"]))

    def test_the_modules_that_take_an_ipv6_block_share_a_lane(self):
        groups = [set(group) for group in self.body["same_lane"]]
        self.assertIn({"load-balancer", "portal-ui", "terraform-provider"}, groups)
        run_lanes.load_plan(self.body)

    def test_the_shared_data_table_of_claude_md_has_one_row_per_module_and_the_lanes_of_lanes_json(self):
        rows = shared_data_rows((HERE / "CLAUDE.md").read_text())
        actual = {}
        for lane_name, steps in self.plan.lanes.items():
            for step in steps:
                if step.kind == "module" and not step.label:
                    actual.setdefault(step.name, set()).add(lane_name)
        self.assertEqual(sorted(rows), sorted(actual), "one row per module of lanes.json, none more")
        for module, lanes in actual.items():
            self.assertEqual(rows[module], lanes, f"{module}: lane column")


if __name__ == "__main__":
    unittest.main()
