#!/usr/bin/env python3
"""Tests of run-module.sh's wait loop against a fake kubectl and a sleep that returns at once. Run: python3 test_run_module.py"""
import os
import pathlib
import subprocess
import tempfile
import textwrap
import unittest

HERE = pathlib.Path(__file__).resolve().parent

# The fake answers each kubectl call run-module.sh makes. Pod phases come from FAKE_PHASES, one per `get pod <name>`
# call ("" = kubectl fails and prints nothing, the last one repeats); `exec … test -f /work/results/.done` succeeds once
# FAKE_DONE_READS phases have been read. FAKE_LOGS `<n>:<line>;…` adds each line to the pod's log once n phases have been
# read; a call holding the text FAKE_FAIL exits 1. The copy of /work/results writes FAKE_FIRST_COPY into a.txt, a copy of
# one file FAKE_RECOPY (both default to the pod's content); FAKE_LOCAL_EXTRA adds b.txt, a file the pod does not list. Applications and the worker answer as on dev.
FAKE_KUBECTL = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, pathlib, sys
    state = pathlib.Path(os.environ["FAKE_STATE"])
    args = sys.argv[1:]
    with open(state / "calls", "a") as calls:
        calls.write(" ".join(args) + "\\n")
    if args[:1] == ["--kubeconfig"]:
        args = args[2:]
    if args[:1] == ["-n"]:
        args = args[2:]
    if os.environ.get("FAKE_FAIL") and os.environ["FAKE_FAIL"] in " ".join(args):
        sys.exit(1)

    def phase_reads():
        counter = state / "phase-reads"
        return int(counter.read_text()) if counter.exists() else 0

    def items(*names):
        print(json.dumps({"items": [{"metadata": {"name": n, "namespace": "regression"}} for n in names]}))

    if args[:2] == ["config", "view"]:
        print("https://fake:6443")
    elif args[:2] == ["get", "cronjob"]:
        items("titan-regression")
    elif args[:2] == ["get", "deployment"]:
        items("control-plane")
    elif args[:2] == ["get", "pods"]:
        if any(a.startswith("job-name=") for a in args):
            items("regression-mod-t1-pod")
        elif "app=incus-worker-inventory" in args and os.environ.get("FAKE_INVENTORY"):
            print(json.dumps({"items": [{"metadata": {"name": "incus-worker-inventory-pod"}, "status": {"containerStatuses": []}}]}))
        else:
            items()
    elif args[:2] == ["get", "pod"]:
        counter = state / "phase-reads"
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        phases = os.environ["FAKE_PHASES"].split(",")
        phase = phases[min(n, len(phases) - 1)]
        if not phase:
            print("Unable to connect to the server: EOF", file=sys.stderr)
            sys.exit(1)
        print(json.dumps({"status": {"phase": phase}}))
    elif args[:2] == ["create", "configmap"]:
        print("kind: ConfigMap")
    elif args[:2] == ["create", "job"]:
        print(json.dumps({"spec": {"template": {"spec": {"volumes": [{"name": "specs", "configMap": {"name": "x"}}]}}}}))
    elif args[:1] in (["apply"], ["create"]):
        sys.stdin.read()
    elif args[:1] == ["exec"]:
        if "test" in args:
            reads = state / "phase-reads"
            sys.exit(0 if int(reads.read_text()) >= int(os.environ["FAKE_DONE_READS"]) else 1)
        if "sh" in args:
            print("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  ./a.txt")
    elif args[:1] == ["cp"] and args[1].endswith(":/work/results"):
        pathlib.Path(args[2]).mkdir(parents=True, exist_ok=True)
        (pathlib.Path(args[2]) / "a.txt").write_text(os.environ.get("FAKE_FIRST_COPY", "hello\\n"))
        if os.environ.get("FAKE_LOCAL_EXTRA"):
            (pathlib.Path(args[2]) / "b.txt").write_text("only here\\n")
    elif args[:1] == ["cp"]:
        pathlib.Path(args[2]).write_text(os.environ.get("FAKE_RECOPY", "hello\\n"))
    elif args[:1] == ["logs"]:
        for step in filter(None, os.environ.get("FAKE_LOGS", "").split(";")):
            n, line = step.split(":", 1)
            if phase_reads() >= int(n):
                print(line)
        print("1 passed\\nREGRESSION_EXIT=0")
    elif args[:2] == ["get", "application"]:
        automated = {"prune": True, "selfHeal": True} if args[2].startswith("root") else {"prune": True}
        print(json.dumps({"spec": {"syncPolicy": {"automated": automated}}}))
    elif args[:2] == ["get", "jobs"]:
        print(json.dumps({"items": [
            {"metadata": {"name": "control-plane-job-meter-29000001"},
             "status": {"startTime": "2026-11-13T05:00:00Z", "completionTime": "2026-11-13T05:00:04Z",
                        "conditions": [{"type": "Complete", "status": "True"}]}},
            {"metadata": {"name": "control-plane-job-wallet-sweep-29000001"}, "status": {}}]}))
    elif args[:3] == ["get", "deploy", "incus-worker"]:
        print("1")
    elif args[:3] == ["get", "deploy", "incus-worker-inventory"]:
        # FAKE_INVENTORY: the worker runs one inventory pod beside its command pods.
        print("1" if os.environ.get("FAKE_INVENTORY") else "")
''')


def run(phases, done_reads=0, earlier=None, **extra_env):
    """(exit code, output, kubectl calls) of one run-module.sh run of module `mod` against the fake. `earlier` maps a path
    under <work dir> to text an earlier run left there."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        bin_dir, state, src = tmp / "bin", tmp / "state", tmp / "src"
        for d in (bin_dir, state, src / "lib", src / "mod"):
            d.mkdir(parents=True)
        (src / "lib" / "helpers.ts").write_text("")
        for rel, text in (earlier or {}).items():
            (tmp / "out" / rel).parent.mkdir(parents=True, exist_ok=True)
            (tmp / "out" / rel).write_text(text)
        (src / "mod" / "mod.spec.ts").write_text("")
        (bin_dir / "kubectl").write_text(FAKE_KUBECTL)
        (bin_dir / "sleep").write_text("#!/bin/sh\nexit 0\n")
        for f in bin_dir.iterdir():
            f.chmod(0o755)
        env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", FAKE_STATE=str(state), FAKE_PHASES=phases,
                   FAKE_DONE_READS=str(done_reads), **extra_env)
        env.pop("REGRESSION_WORKER_APPS", None) if "REGRESSION_WORKER_APPS" not in extra_env else None
        env.pop("REGRESSION_CP_ROLL_SECONDS", None) if "REGRESSION_CP_ROLL_SECONDS" not in extra_env else None
        result = subprocess.run(
            ["bash", str(HERE / "run-module.sh"), str(tmp / "kubeconfig"), str(src), "mod", "t1",
             str(tmp / "out"), str(tmp / "logs")],
            env=env, capture_output=True, text=True, timeout=60)
        calls = [c.split(" ", 2)[2] for c in (state / "calls").read_text().splitlines()]
        return result.returncode, result.stdout + result.stderr, "\n".join(calls)


class WaitLoopTest(unittest.TestCase):
    def test_an_unreadable_phase_is_read_again_and_the_run_goes_on(self):
        code, out, calls = run("Running,,,Running")
        self.assertNotIn("pod ended", out)
        self.assertIn("pod phase unreadable (#1)", out)
        self.assertIn("pod phase unreadable (#2)", out)
        self.assertIn("SHA256_MATCH 1 file(s)", out)
        self.assertIn("delete job regression-mod-t1", calls)
        self.assertEqual(code, 0, out)

    def test_a_phase_unreadable_twenty_one_times_keeps_the_job(self):
        code, out, calls = run("Running,")
        self.assertIn("pod phase unreadable (#20)", out)
        self.assertNotIn("pod phase unreadable (#21)", out)
        self.assertIn("pod phase unreadable 21 times in a row", out)
        self.assertNotIn("delete job", calls)
        self.assertEqual(code, 1, out)

    def test_the_unreadable_count_starts_again_after_a_good_read(self):
        phases = "Running" + ("," * 16 + "Running") * 2
        code, out, _ = run(phases, done_reads=len(phases.split(",")))
        self.assertEqual(out.count("pod phase unreadable (#15)"), 2, out)
        self.assertNotIn("pod phase unreadable (#16)", out)
        self.assertIn("SHA256_MATCH 1 file(s)", out)
        self.assertEqual(code, 0, out)

    def test_a_pod_that_ended_is_still_reported_so(self):
        code, out, calls = run("Running,Failed")
        self.assertIn("pod ended: Failed (no .done)", out)
        self.assertNotIn("SHA256", out)
        self.assertIn("delete job regression-mod-t1", calls)
        self.assertEqual(code, 0, out)


STOP = "3:WORKER_STOP_WAIT turn off auto-sync … then touch /work/adm-15/worker-stopped"
START = "5:WORKER_START_WAIT (ADM-15) scale deploy/incus-worker back … then touch /work/adm-15/worker-started"
APPS = {"REGRESSION_WORKER_APPS": "root-local,incus-worker-local"}


def worker_calls(calls):
    """The calls that touch the worker, its Applications or the ADM-15 markers, in order."""
    words = ("application", "incus-worker", "adm-15")
    return [c for c in calls.splitlines() if any(w in c for w in words) and " get pods " not in c and " logs " not in c]


class WorkerStopTest(unittest.TestCase):
    def test_the_runner_stops_and_starts_the_worker_when_the_spec_asks(self):
        code, out, calls = run("Running", done_reads=7, FAKE_LOGS=f"{STOP};{START}", **APPS)
        self.assertEqual(worker_calls(calls), [
            "-n regression get deploy incus-worker -o jsonpath={.spec.replicas}",
            "-n regression get deploy incus-worker-inventory --ignore-not-found -o jsonpath={.spec.replicas}",
            "-n argocd get application root-local -o json",
            '-n argocd patch application root-local --type merge -p {"spec":{"syncPolicy":{"automated":null}}}',
            "-n argocd get application incus-worker-local -o json",
            '-n argocd patch application incus-worker-local --type merge -p {"spec":{"syncPolicy":{"automated":null}}}',
            "-n regression scale deploy/incus-worker --replicas=0",
            "-n regression wait --for=delete pod -l app=incus-worker --timeout=5m",
            "-n regression exec regression-mod-t1-pod -- touch /work/adm-15/worker-stopped",
            "-n regression scale deploy/incus-worker --replicas=1",
            '-n argocd patch application incus-worker-local --type merge -p {"spec":{"syncPolicy":{"automated":{"prune": true}}}}',
            '-n argocd patch application root-local --type merge -p {"spec":{"syncPolicy":{"automated":{"prune": true, "selfHeal": true}}}}',
            "-n regression rollout status deploy/incus-worker --timeout=10m",
            "-n regression exec regression-mod-t1-pod -- touch /work/adm-15/worker-started",
        ])
        self.assertIn("worker stopped", out)
        self.assertIn("worker started", out)
        self.assertEqual(code, 0, out)

    def test_with_an_inventory_pod_the_runner_stops_and_starts_it_too_and_keeps_its_log(self):
        code, out, calls = run("Running", done_reads=7, FAKE_LOGS=f"{STOP};{START}", FAKE_INVENTORY="1", **APPS)
        steps = worker_calls(calls)
        stop = [s for s in steps if "scale" in s or "wait --for=delete" in s]
        self.assertEqual(stop, [
            "-n regression scale deploy/incus-worker --replicas=0",
            "-n regression scale deploy/incus-worker-inventory --replicas=0",
            "-n regression wait --for=delete pod -l app=incus-worker --timeout=5m",
            "-n regression wait --for=delete pod -l app=incus-worker-inventory --timeout=5m",
            "-n regression scale deploy/incus-worker --replicas=1",
            "-n regression scale deploy/incus-worker-inventory --replicas=1",
        ])
        self.assertIn("logs incus-worker-inventory-pod", calls)
        self.assertIn("-n regression rollout status deploy/incus-worker-inventory --timeout=10m", steps)
        self.assertEqual(code, 0, out)

    def test_with_an_inventory_pod_a_rollout_that_fails_is_reported_and_tried_again_at_exit(self):
        code, out, calls = run("Running", done_reads=7, FAKE_LOGS=f"{STOP};{START}", FAKE_INVENTORY="1",
                               FAKE_FAIL="rollout status deploy/incus-worker-inventory", **APPS)
        self.assertIn("WORKER_START_FAILED", out)
        self.assertIn("worker still stopped at exit", out)
        self.assertEqual(calls.count("rollout status deploy/incus-worker-inventory"), 2)

    def test_a_failed_read_of_the_inventory_pods_keeps_no_inventory_log(self):
        code, out, calls = run("Running", done_reads=7, FAKE_INVENTORY="1", FAKE_FAIL="get pods -l app=incus-worker-inventory")
        # One read, the one that failed: no log of the inventory pod is started.
        self.assertEqual(calls.count("get pods -l app=incus-worker-inventory"), 1)
        self.assertEqual(code, 0, out)

    def test_with_an_inventory_pod_a_stop_that_fails_puts_both_back(self):
        code, out, calls = run("Running", done_reads=7, FAKE_LOGS=STOP, FAKE_INVENTORY="1",
                               FAKE_FAIL="wait --for=delete pod -l app=incus-worker-inventory", **APPS)
        self.assertIn("WORKER_STOP_FAILED", out)
        steps = worker_calls(calls)
        self.assertIn("-n regression scale deploy/incus-worker --replicas=1", steps)
        self.assertIn("-n regression scale deploy/incus-worker-inventory --replicas=1", steps)

    def test_without_an_inventory_pod_no_inventory_log_is_kept(self):
        code, out, calls = run("Running", done_reads=7)
        self.assertNotIn("logs incus-worker-inventory", calls)
        self.assertEqual(code, 0, out)

    def test_without_the_applications_named_the_runner_leaves_the_worker_alone(self):
        code, out, calls = run("Running", done_reads=7, FAKE_LOGS=f"{STOP};{START}")
        self.assertEqual(worker_calls(calls), [])
        self.assertEqual(code, 0, out)

    def test_a_stop_that_fails_puts_the_worker_back_and_answers_nothing(self):
        code, out, calls = run("Running", done_reads=7, FAKE_LOGS=STOP, FAKE_FAIL="wait --for=delete", **APPS)
        steps = worker_calls(calls)
        self.assertIn("WORKER_STOP_FAILED", out)
        self.assertNotIn("-n regression exec regression-mod-t1-pod -- touch /work/adm-15/worker-stopped", steps)
        self.assertEqual(steps[-4:], [
            "-n regression scale deploy/incus-worker --replicas=1",
            '-n argocd patch application incus-worker-local --type merge -p {"spec":{"syncPolicy":{"automated":{"prune": true}}}}',
            '-n argocd patch application root-local --type merge -p {"spec":{"syncPolicy":{"automated":{"prune": true, "selfHeal": true}}}}',
            "-n regression rollout status deploy/incus-worker --timeout=10m",
        ])
        # Back at once, not at exit: the spec runs on for minutes with nothing of any tenant reaching Incus.
        self.assertNotIn("worker still stopped at exit", out)
        self.assertLess(calls.index("rollout status deploy/incus-worker"), calls.index("delete job"))
        self.assertEqual(code, 0, out)

    def test_a_stop_marker_that_cannot_be_written_is_not_reported_as_an_answer(self):
        code, out, _ = run("Running", done_reads=7, FAKE_LOGS=STOP,
                           FAKE_FAIL="touch /work/adm-15/worker-stopped", **APPS)
        self.assertIn("WORKER_STOPPED_UNANSWERED", out)
        self.assertNotIn("ADM-15 worker stopped", out)
        self.assertIn("worker still stopped", out)
        self.assertEqual(code, 0, out)

    def test_a_stop_that_fails_before_saving_restores_nothing_an_earlier_run_saved(self):
        code, out, calls = run("Running", done_reads=7, FAKE_LOGS=STOP, FAKE_FAIL="get deploy incus-worker",
                               earlier={"worker-autosync-root-local.json": '{"prune": false}'}, **APPS)
        self.assertIn("WORKER_STOP_FAILED", out)
        self.assertNotIn("patch application", calls)
        self.assertEqual(code, 0, out)

    def test_a_run_that_ends_with_the_worker_stopped_puts_it_back(self):
        code, out, calls = run("Running,Running,Running,Running,Failed", done_reads=99, FAKE_LOGS=STOP, **APPS)
        steps = worker_calls(calls)
        self.assertIn("-n regression exec regression-mod-t1-pod -- touch /work/adm-15/worker-stopped", steps)
        self.assertEqual(steps[-1], "-n regression rollout status deploy/incus-worker --timeout=10m")
        self.assertIn("-n regression scale deploy/incus-worker --replicas=1", steps)
        self.assertIn("worker still stopped", out)
        self.assertEqual(code, 0, out)


ROLL = "3:CP_ROLL_WAIT roll deployment/control-plane back to back for three meter cycles"


def roll_calls(calls):
    """The calls that roll the control plane, read its meter Jobs or touch the BIL-25 markers, in order."""
    return [c for c in calls.splitlines() if "bil-25" in c or "rollout" in c or "get jobs" in c]


class ControlPlaneRollTest(unittest.TestCase):
    def test_the_runner_rolls_the_control_plane_when_the_spec_asks_and_logs_the_meter_jobs(self):
        code, out, calls = run("Running", done_reads=6, FAKE_LOGS=ROLL, REGRESSION_CP_ROLL_SECONDS="0")
        self.assertEqual(roll_calls(calls), [
            "-n regression exec regression-mod-t1-pod -- sh -c mkdir -p /work/bil-25 && touch /work/bil-25/rolling",
            "-n regression rollout restart deployment/control-plane",
            "-n regression rollout status deployment/control-plane --timeout=10m",
            "-n regression get jobs -o json",
            "-n regression exec regression-mod-t1-pod -- touch /work/bil-25/rolled",
        ])
        self.assertIn("1 roll(s) of deployment/control-plane; meter Jobs seen: 1", out)
        self.assertEqual(code, 0, out)

    def test_without_the_variable_the_runner_never_rolls_the_control_plane(self):
        code, out, calls = run("Running", done_reads=6, FAKE_LOGS=ROLL)
        self.assertEqual(roll_calls(calls), [])
        self.assertEqual(code, 0, out)

    def test_a_rollout_that_fails_is_reported_and_the_rolled_marker_is_not_written(self):
        code, out, calls = run("Running", done_reads=6, FAKE_LOGS=ROLL, REGRESSION_CP_ROLL_SECONDS="0", FAKE_FAIL="rollout status")
        self.assertIn("CP_ROLL_FAILED", out)
        self.assertNotIn("touch /work/bil-25/rolled", calls)
        self.assertEqual(code, 0, out)

    def test_a_window_that_is_not_whole_seconds_is_refused_before_any_job(self):
        code, out, calls = run("Running", REGRESSION_CP_ROLL_SECONDS="3m")
        self.assertIn("REGRESSION_CP_ROLL_SECONDS must be whole seconds", out)
        self.assertNotIn("create job", calls)
        self.assertEqual(code, 2, out)


class ResultCopyTest(unittest.TestCase):
    def test_a_file_that_differs_is_copied_again_and_the_run_says_so(self):
        code, out, calls = run("Running", FAKE_FIRST_COPY="hel")
        self.assertIn("SHA256_DIFFERS ./a.txt — copying it again", out)
        self.assertIn("-n regression cp regression-mod-t1-pod:/work/results/a.txt", calls)
        self.assertIn("SHA256_MATCH 1 file(s)", out)
        self.assertIn("delete job regression-mod-t1", calls)
        self.assertEqual(code, 0, out)

    def test_a_file_still_different_keeps_the_job_and_names_it(self):
        code, out, calls = run("Running", FAKE_FIRST_COPY="hel", FAKE_RECOPY="he")
        self.assertIn("SHA256_MISMATCH ./a.txt — job regression-mod-t1 kept for a chunked copy", out)
        self.assertNotIn("delete job", calls)
        self.assertEqual(code, 1, out)

    def test_results_of_an_earlier_run_in_the_same_work_dir_are_not_compared(self):
        code, out, _ = run("Running", earlier={"results/old.txt": "from an earlier run\n"})
        self.assertIn("SHA256_MATCH 1 file(s)", out)
        self.assertEqual(code, 0, out)

    def test_a_file_only_on_this_side_copies_nothing_again_and_keeps_the_job(self):
        code, out, calls = run("Running", FAKE_LOCAL_EXTRA="1")
        self.assertNotIn("SHA256_DIFFERS", out)
        self.assertNotIn("cp regression-mod-t1-pod:/work/results/", calls)
        self.assertIn("SHA256_MISMATCH", out)
        self.assertNotIn("delete job", calls)
        self.assertEqual(code, 1, out)


if __name__ == "__main__":
    unittest.main()
