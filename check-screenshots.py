#!/usr/bin/env python3
"""Checks that every UI case of the regression suite leaves a screenshot, the evidence
titan-ops architecture/evidence.md#evidence asks for.

A UI case is a `test('<ID> …', …)` of a spec whose body drives a browser: a `{ page }`, `{ browser }` or `{ context }`
fixture, or a call to pageOf(, newPage( or newContext(. Its ID is the first ID of the title.

Without logs (static, for a spec being written): every UI case's body calls screenshot( with a path under
`${RESULTS}/<ID>-`.
With a shots dir and runner logs (run-module.sh, after the copy): also every UI case marked ✓ in a log has at least
one `<ID>-*.png` in the shots dir. A ✘ or skipped case is not asked for one: a failed case's picture is the FINDING's.

Usage:  python3 check-screenshots.py <spec dir>
        python3 check-screenshots.py <spec dir> <shots dir> <runner.log>...
Exit 0 ok · 1 missing. The last stdout line is SCREENSHOT_RESULT=OK <n> UI case(s)|MISSING <n>.
Silent about: what a picture shows (a blank page passes); a UI case whose browser work sits in a helper defined in
another file; a screenshot call that is never reached. A hook (test.beforeAll…) that opens a browser right after a
case without one makes that case a UI case: the body runs to the next test(.
"""
import importlib.util
import pathlib
import re
import sys

_spec = importlib.util.spec_from_file_location(
    "count_cases", pathlib.Path(__file__).resolve().parent / "count-cases.py")
count_cases = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(count_cases)

TEST_START = re.compile(r"\btest\(\s*(['\"`])((?:(?!\1).)*)\1")
CASE_ID = re.compile(r"\b[A-Z]+-\d+\b")
BROWSER = re.compile(r"async\s*\(\s*\{[^}]*\b(?:page|browser|context)\b[^}]*\}|\b(?:pageOf|newPage|newContext)\(")


def ui_cases(source):
    """[(ID, body)] of the UI cases of one spec file; a body runs to the next test( or the end of the file."""
    starts = list(TEST_START.finditer(source))
    cases = []
    for index, start in enumerate(starts):
        end = len(source)
        if index + 1 < len(starts):
            end = starts[index + 1].start()
        body = source[start.start():end]
        found = CASE_ID.search(start.group(2))
        if found is None or BROWSER.search(body) is None:
            continue
        cases.append((found.group(0), body))
    return cases


def takes_screenshot(case_id, body):
    return "screenshot(" in body and ("${RESULTS}/" + case_id + "-") in body


def main(argv):
    if len(argv) != 1 and len(argv) < 3:
        print("Usage: check-screenshots.py <spec dir> [<shots dir> <runner.log>...]", file=sys.stderr)
        return 2
    spec_dir = pathlib.Path(argv[0])
    cases = []
    for spec in sorted(spec_dir.glob("*.spec.ts")):
        cases += ui_cases(spec.read_text(encoding="utf-8"))
    ids = sorted(set(case_id for case_id, _ in cases))
    print("UI cases: " + (" ".join(ids) or "none"))

    missing = []
    no_call = sorted(set(case_id for case_id, body in cases if not takes_screenshot(case_id, body)))
    if no_call:
        print("no screenshot call into ${RESULTS}/<ID>-: " + " ".join(no_call))
        missing += no_call

    if len(argv) >= 3:
        shots = pathlib.Path(argv[1])
        marks = {}
        for log in argv[2:]:
            marks.update(count_cases.log_marks(pathlib.Path(log).read_text(encoding="utf-8", errors="replace")))
        no_file = [case_id for case_id in ids
                   if marks.get(case_id) == "pass" and not list(shots.glob(case_id + "-*.png"))]
        if no_file:
            print("passed with no <ID>-*.png in %s: %s" % (shots, " ".join(no_file)))
            missing += no_file

    if missing:
        print("SCREENSHOT_RESULT=MISSING %d" % len(missing))
        return 1
    print("SCREENSHOT_RESULT=OK %d UI case(s)" % len(ids))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
