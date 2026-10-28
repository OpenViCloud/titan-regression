#!/usr/bin/env python3
"""Runs the regression modules as lanes: one lane per test tenant, lanes side by side, steps of a lane in order.

lanes.json says which lane runs which module and where lanes wait for each other. A step is one of
  {"module": "vm"}            one runner job (run-module.sh) of the lane's CronJob
  {"barrier": "smoke"}        every lane waits here for every other lane
  {"signal": "billing-done"}  tells the lanes waiting for it (fires even when the lane failed)
  {"wait": "billing-done"}    waits for that signal
  {"external": "seed"}        work the agent does outside the runner; the lane waits for <external dir>/seed.done
A module step may carry "always" (runs although the lane failed: cleanup), "label" (names a second run of a module)
and "only_if_failed": "<module>" (runs only when that module of the lane was red).

A red module skips the rest of its lane except "always" steps and signals. A red module listed in "abort_on" (smoke)
stops every lane. "exclusive" lists groups of modules that must never overlap in time (same wallet, same shared list):
a plan in which two of a group may run together is refused when it is loaded, before any job starts. "same_lane" lists
groups of modules that take from one pool the whole cluster shares (an IPv6 block) and must run in one lane.

Usage:
  python3 run-lanes.py --check                      # lanes.json against README.md's Release column, no cluster
  python3 run-lanes.py --check --column dev --lanes lanes-dev.json     # a dev plan against the Dev column
  python3 run-lanes.py --kubeconfig <kc> --src <source tree> --out <work dir> --logs <evidence dir> --label <run> \
      [--binary cli=<path>] [--binary terraform-provider=<path>]
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
KINDS = ("module", "barrier", "signal", "wait", "external")


class PlanError(Exception):
    pass


class Step:
    def __init__(self, lane, raw):
        kinds = [k for k in KINDS if k in raw]
        if len(kinds) != 1:
            raise PlanError(f"lane {lane}: a step has exactly one of {KINDS}, got {raw}")
        self.lane = lane
        self.kind = kinds[0]
        self.name = raw[self.kind]
        self.label = raw.get("label", "")
        self.always = bool(raw.get("always", False))
        self.only_if_failed = raw.get("only_if_failed", "")

    @property
    def key(self):
        if self.kind == "external":
            return f"{self.lane}/external:{self.name}"
        return f"{self.lane}/{self.name}" + (f"#{self.label}" if self.label else "")


class Plan:
    def __init__(self, body):
        self.max_pods = int(body.get("max_pods", 2))
        self.abort_on = set(body.get("abort_on", []))
        self.agent_side = set(body.get("agent_side", []))
        self.per_lane = set(body.get("per_lane", []))
        self.exclusive = [list(g) for g in body.get("exclusive", [])]
        self.same_lane = [list(g) for g in body.get("same_lane", [])]
        self.cronjob = {}
        self.lanes = {}
        for name, lane in body["lanes"].items():
            self.cronjob[name] = lane["cronjob"]
            self.lanes[name] = [Step(name, raw) for raw in lane["steps"]]


def load_plan(body):
    plan = Plan(body)
    signals = {}
    for steps in plan.lanes.values():
        for step in steps:
            if step.kind == "signal":
                if step.name in signals:
                    raise PlanError(f"signal {step.name!r} is sent twice")
                signals[step.name] = step
    for steps in plan.lanes.values():
        for step in steps:
            if step.kind == "wait" and step.name not in signals:
                raise PlanError(f"wait {step.name!r} has no signal")
    barriers = {s.name for steps in plan.lanes.values() for s in steps if s.kind == "barrier"}
    for name in barriers:
        for lane, steps in plan.lanes.items():
            if [s.name for s in steps if s.kind == "barrier"].count(name) != 1:
                raise PlanError(f"barrier {name!r} must appear exactly once in lane {lane}")
    _refuse_overlaps(plan)
    _refuse_split_pools(plan)
    return plan


def _refuse_split_pools(plan):
    """Modules of a same_lane group take from one pool the whole cluster shares (an IPv6 /64): two lanes would race for it."""
    for group in plan.same_lane:
        lanes = {lane for lane, steps in plan.lanes.items() for s in steps if s.kind == "module" and s.name in group}
        if len(lanes) > 1:
            raise PlanError(f"{', '.join(group)} take from one pool and must share a lane, but run in lanes {sorted(lanes)}")


def _refuse_overlaps(plan):
    """Two exclusive modules need a happens-before path between them: lane order, a barrier, or a signal → wait."""
    def node(lane, index, step):
        return ("barrier", step.name) if step.kind == "barrier" else (lane, index)

    after = {}
    for lane, steps in plan.lanes.items():
        for index, step in enumerate(steps):
            after.setdefault(node(lane, index, step), set())
            if index + 1 < len(steps):
                after[node(lane, index, step)].add(node(lane, index + 1, steps[index + 1]))
    sent = {s.name: node(l, i, s) for l, steps in plan.lanes.items() for i, s in enumerate(steps) if s.kind == "signal"}
    for lane, steps in plan.lanes.items():
        for index, step in enumerate(steps):
            if step.kind == "wait":
                after.setdefault(sent[step.name], set()).add(node(lane, index, step))

    def reaches(start, goal):
        seen, todo = set(), [start]
        while todo:
            here = todo.pop()
            if here == goal:
                return True
            if here in seen:
                continue
            seen.add(here)
            todo.extend(after.get(here, ()))
        return False

    for group in plan.exclusive:
        where = [(lane, i, s) for lane, steps in plan.lanes.items() for i, s in enumerate(steps)
                 if s.kind == "module" and s.name in group]
        for x in range(len(where)):
            for y in range(x + 1, len(where)):
                (la, ia, sa), (lb, ib, sb) = where[x], where[y]
                na, nb = node(la, ia, sa), node(lb, ib, sb)
                if not reaches(na, nb) and not reaches(nb, na):
                    raise PlanError(f"{sa.name} (lane {la}) and {sb.name} (lane {lb}) may run at the same time")


def readme_modules(readme_text, column="release"):
    """Modules whose Release (or Dev) column says yes, from the README's `| # | Module | Measures | Dev | Release | Spec |` table."""
    index = {"dev": 4, "release": 5}[column]
    found = []
    for line in readme_text.splitlines():
        cells = [c.strip() for c in line.split("|")]
        if len(cells) >= 7 and cells[1].isdigit() and re.fullmatch(r"`[a-z-]+`", cells[2]):
            if cells[index].lower().startswith("yes"):
                found.append(cells[2].strip("`"))
    return found


def coverage_problems(plan, readme_text, column="release"):
    """Every runner module of the README runs exactly once (once per lane for `per_lane` modules, which every tenant needs)."""
    known = readme_modules(readme_text, column)
    in_lanes = {lane: [s.name for s in steps if s.kind == "module" and not s.label] for lane, steps in plan.lanes.items()}
    everywhere = [name for names in in_lanes.values() for name in names]
    problems = []
    for module in known:
        if module in plan.agent_side:
            continue
        if module in plan.per_lane:
            for lane, names in in_lanes.items():
                if names.count(module) != 1:
                    problems.append(f"{module} must run once in lane {lane}, runs {names.count(module)} times")
            continue
        count = everywhere.count(module)
        if count == 0:
            problems.append(f"{module} is in the README and in no lane")
        elif count > 1:
            problems.append(f"{module} is in {count} lanes")
    for module in dict.fromkeys(everywhere):
        if module not in known:
            problems.append(f"{module} is in a lane and not in the README")
    return problems


class Result:
    def __init__(self):
        self.codes = {}
        self.skipped = []
        self.timed_out = []
        self.aborted = False

    @property
    def exit_code(self):
        red = any(code != 0 for code in self.codes.values())
        return 1 if (red or self.timed_out or self.aborted) else 0


def execute(plan, runner, external_dir, max_pods=None, poll=2.0, external_timeout=3600.0, join_timeout=None):
    """Runs every lane in its own thread. runner(lane, cronjob, module, label) -> exit code."""
    result = Result()
    lock = threading.Lock()
    abort = threading.Event()
    pods = threading.BoundedSemaphore(max_pods if max_pods is not None else plan.max_pods)
    signals = {s.name: threading.Event() for steps in plan.lanes.values() for s in steps if s.kind == "signal"}
    barriers = {s.name: threading.Barrier(len(plan.lanes)) for steps in plan.lanes.values()
                for s in steps if s.kind == "barrier"}

    def stop_everything():
        abort.set()
        for barrier in barriers.values():
            barrier.abort()

    def wait_for(done):
        """Polls done() until it is true; False when the run was aborted first."""
        while not done():
            if abort.is_set():
                return False
            time.sleep(poll)
        return True

    def run_lane(lane):
        failed = False
        ran_red = set()
        steps = plan.lanes[lane]
        for position, step in enumerate(steps):
            if abort.is_set():
                with lock:
                    result.skipped.extend(s.key for s in steps[position:] if s.kind in ("module", "external"))
                return
            if step.kind == "signal":
                signals[step.name].set()
            elif step.kind == "wait":
                if not wait_for(signals[step.name].is_set):
                    return
            elif step.kind == "barrier":
                try:
                    barriers[step.name].wait()
                except threading.BrokenBarrierError:
                    return
            elif step.kind == "external":
                if failed:
                    with lock:
                        result.skipped.append(step.key)
                    continue
                marker = pathlib.Path(external_dir) / f"{step.name}.done"
                deadline = time.time() + external_timeout
                if not wait_for(lambda: marker.exists() or time.time() > deadline):
                    return
                if not marker.exists():
                    failed = True
                    with lock:
                        result.timed_out.append(step.key)
            else:
                if step.only_if_failed:
                    if step.only_if_failed not in ran_red:
                        continue
                elif failed and not step.always:
                    with lock:
                        result.skipped.append(step.key)
                    continue
                with pods:
                    code = runner(lane, plan.cronjob[lane], step.name, step.label)
                with lock:
                    result.codes[step.key] = code
                if code != 0:
                    failed = True
                    ran_red.add(step.name)
                    if step.name in plan.abort_on:
                        result.aborted = True
                        stop_everything()

    threads = [threading.Thread(target=run_lane, args=(lane,), name=f"lane-{lane}", daemon=True) for lane in plan.lanes]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=join_timeout)
    return result


def log_dir(logs, lane, module, label, per_lane):
    """<logs>/<module>[-<lane>][-<step label>]: the release's evidence/<module>/. A module every lane runs (smoke,
    cleanup) gets the lane in its name, else two lanes overwrite each other's system logs and screenshots."""
    name = module + (f"-{lane}" if module in per_lane else "") + (f"-{label}" if label else "")
    return pathlib.Path(logs) / name


class ClusterRunner:
    """One module = `bash run-module.sh …` with REGRESSION_CRONJOB naming the lane's CronJob and REGRESSION_LANE its name."""

    def __init__(self, kubeconfig, src, out, logs, label, binaries, per_lane):
        self.kubeconfig, self.src, self.out, self.logs = kubeconfig, src, pathlib.Path(out), pathlib.Path(logs)
        self.label, self.binaries, self.per_lane = label, binaries, per_lane

    def __call__(self, lane, cronjob, module, label):
        suffix = f"-{label}" if label else ""
        work = self.out / lane / f"{module}{suffix}"
        logs = log_dir(self.logs, lane, module, label, self.per_lane)
        work.mkdir(parents=True, exist_ok=True)
        command = ["bash", str(HERE / "run-module.sh"), self.kubeconfig, self.src, module,
                   f"{self.label}{lane}{suffix}", str(work), str(logs)]
        if module in self.binaries:
            command.append(self.binaries[module])
        started = time.strftime("%H:%M:%S", time.gmtime())
        print(f"[{lane}] {module}{suffix} start {started} UTC", flush=True)
        with open(work / "run.log", "w") as log:
            code = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT,
                                  env={**os.environ, "REGRESSION_CRONJOB": cronjob, "REGRESSION_LANE": lane}).returncode
        print(f"[{lane}] {module}{suffix} exit {code} end {time.strftime('%H:%M:%S', time.gmtime())} UTC", flush=True)
        return code


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lanes", default=str(HERE / "lanes.json"))
    parser.add_argument("--check", action="store_true", help="validate the plan (--lanes) against the README column (--column) and exit")
    parser.add_argument("--column", choices=["release", "dev"], default="release",
                        help="README column the plan must cover: release (lanes.json), dev (give --lanes lanes-dev.json or lanes-dev-sequential.json too)")
    parser.add_argument("--kubeconfig")
    parser.add_argument("--src")
    parser.add_argument("--out")
    parser.add_argument("--logs")
    parser.add_argument("--label")
    parser.add_argument("--external-dir")
    parser.add_argument("--max-pods", type=int)
    parser.add_argument("--external-timeout-minutes", type=float, default=90.0)
    parser.add_argument("--binary", action="append", default=[], metavar="MODULE=PATH")
    args = parser.parse_args(argv)

    try:
        plan = load_plan(json.loads(pathlib.Path(args.lanes).read_text()))
    except PlanError as error:
        print(f"run-lanes.py: {error}", file=sys.stderr)
        return 2
    problems = coverage_problems(plan, (HERE / "README.md").read_text(), args.column)
    if problems:
        print("run-lanes.py: " + "; ".join(problems), file=sys.stderr)
        return 2
    if args.check:
        print(f"lanes OK: {', '.join(f'{lane}={len(steps)} steps' for lane, steps in plan.lanes.items())}")
        return 0
    missing = [name for name in ("kubeconfig", "src", "out", "logs", "label") if getattr(args, name) is None]
    if missing:
        parser.error("needs --" + ", --".join(missing))
    external = pathlib.Path(args.external_dir or pathlib.Path(args.out) / "external")
    external.mkdir(parents=True, exist_ok=True)
    binaries = dict(item.split("=", 1) for item in args.binary)
    runner = ClusterRunner(args.kubeconfig, args.src, args.out, args.logs, args.label, binaries, plan.per_lane)
    result = execute(plan, runner, external, max_pods=args.max_pods,
                     external_timeout=args.external_timeout_minutes * 60)
    for key, code in sorted(result.codes.items()):
        print(f"{'ok ' if code == 0 else 'RED'} {key} exit={code}")
    for key in result.skipped:
        print(f"skipped {key}")
    for key in result.timed_out:
        print(f"TIMED OUT waiting for {key}")
    if result.aborted:
        print("ABORTED: a gate module was red; no later step started in any lane, cleanup included. Run cleanup by hand.")
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
