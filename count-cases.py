#!/usr/bin/env python3
"""Counts the cases of plan.md against the result lines of runner logs, for the report's first line.

Every row of plan.md that opens with `| <ID>` (`| VM-20 (host) |` too) belongs to the module named by the first word of the `## ` heading above it. A runner
log line `✓|✘|-  <n> [chromium] › … › <title>` marks every ID in its title; `X-01..03` and `X-01…03` mark X-01, X-02,
X-03; a word shaped like an ID whose prefix no plan row has (`UTF-8`) is no ID. An ID with several tests takes its
worst mark (fail, then skip, then pass). IDs with no line are printed per module: the report sorts them by hand into
PASS measured elsewhere, NOT COVERED or N/A.

Usage:  python3 count-cases.py [--plan plan.md] <runner.log>...
"""
import argparse
import pathlib
import re
import sys

ROW = re.compile(r"^\|\s*([A-Z]+-\d+)\b")
HEADING = re.compile(r"^##\s+(\S+)")
RESULT = re.compile(r"^\s+(✓|✘|-)\s+\d+\s+\[[^\]]+\]\s+›\s+(.*)$")
ID = re.compile(r"\b([A-Z]+)-(\d+)(?:(?:\.\.|…)(\d+))?")
MARK = {"✓": "pass", "✘": "fail", "-": "skip"}
WORST_FIRST = ["fail", "skip", "pass"]


def plan_ids(text):
    """{module: [ID, …]} in plan order."""
    modules = {}
    module = None
    for line in text.splitlines():
        heading = HEADING.match(line)
        if heading is not None:
            module = heading.group(1)
            continue
        row = ROW.match(line)
        if row is not None and module is not None:
            modules.setdefault(module, []).append(row.group(1))
    return modules


def plan_prefixes(modules):
    """Every ID prefix of the plan (`FW` of FW-01)."""
    return {case_id.split("-")[0] for ids in modules.values() for case_id in ids}


def ids_in(title, prefixes=None):
    """IDs a title names; with prefixes, only those whose prefix is one (`UTF-8` in a title is no ID)."""
    found = []
    for match in ID.finditer(title):
        prefix = match.group(1)
        if prefixes is not None and prefix not in prefixes:
            continue
        first = match.group(2)
        last = match.group(3)
        if last is None:
            found.append(prefix + "-" + first)
            continue
        width = len(first)
        for number in range(int(first), int(last) + 1):
            found.append(prefix + "-" + str(number).zfill(width))
    return found


def log_marks(text, prefixes=None):
    """{ID: pass|fail|skip}, worst mark per ID; prefixes as ids_in()."""
    marks = {}
    for line in text.splitlines():
        result = RESULT.match(line)
        if result is None:
            continue
        mark = MARK[result.group(1)]
        for case_id in ids_in(result.group(2), prefixes):
            old = marks.get(case_id)
            if old is None or WORST_FIRST.index(mark) < WORST_FIRST.index(old):
                marks[case_id] = mark
    return marks


def merge_marks(per_log):
    """One {ID: mark} from many logs (the two lanes', a re-run's): worst mark per ID."""
    marks = {}
    for log in per_log:
        for case_id, mark in log.items():
            old = marks.get(case_id)
            if old is None or WORST_FIRST.index(mark) < WORST_FIRST.index(old):
                marks[case_id] = mark
    return marks


def tally(modules, marks):
    """(rows per module, unseen IDs per module, IDs in logs but not in the plan)."""
    rows = {}
    unseen = {}
    planned = set()
    for module, ids in modules.items():
        row = {"plan": len(ids), "pass": 0, "fail": 0, "skip": 0, "unseen": 0}
        for case_id in ids:
            planned.add(case_id)
            mark = marks.get(case_id)
            if mark is None:
                row["unseen"] += 1
                unseen.setdefault(module, []).append(case_id)
            else:
                row[mark] += 1
        rows[module] = row
    extra = sorted(case_id for case_id in marks if case_id not in planned)
    return rows, unseen, extra


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plan", default=str(pathlib.Path(__file__).resolve().parent / "plan.md"))
    parser.add_argument("logs", nargs="+")
    args = parser.parse_args(argv)

    modules = plan_ids(pathlib.Path(args.plan).read_text(encoding="utf-8"))
    prefixes = plan_prefixes(modules)
    marks = merge_marks([log_marks(pathlib.Path(log).read_text(encoding="utf-8", errors="replace"), prefixes)
                         for log in args.logs])
    rows, unseen, extra = tally(modules, marks)

    total = {"plan": 0, "pass": 0, "fail": 0, "skip": 0, "unseen": 0}
    print("module               plan  pass  fail  skip  unseen")
    for module, row in rows.items():
        print("%-20s %5d %5d %5d %5d %7d" % (module, row["plan"], row["pass"], row["fail"], row["skip"], row["unseen"]))
        for key in total:
            total[key] += row[key]
    print("%-20s %5d %5d %5d %5d %7d" % ("TOTAL", total["plan"], total["pass"], total["fail"], total["skip"],
                                         total["unseen"]))
    for module, ids in unseen.items():
        print("unseen %s: %s" % (module, " ".join(ids)))
    if extra:
        print("in logs, not in plan: " + " ".join(extra))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
