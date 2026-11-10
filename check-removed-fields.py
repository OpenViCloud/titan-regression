#!/usr/bin/env python3
"""Fails when a spec or a helper still reads a field that left the public API and README does not mark its case.

Two copies of the control plane's api/openapi-v1.json are compared: a property a schema (of a response or of a
request) had in the old one and has no more in the new one is a removed field. Every line of `*.spec.ts` and of
`lib/` that reads such a field (`.field`, or the field's name as a string) is listed under the case IDs in the title
of the test it sits in:

  STALE    the field is in no schema of the new contract, and no case of the test is marked `(extended)`,
           `(plan only)` or `(not covered)` in the last cell (the Spec column) of a table row of README: the line
           asserts or uses something the API no longer sends. A test runs from its `test(` line to the `})` at the
           same indentation; a read outside every test (a hook, a helper, `lib/`) has no case and stays STALE
           until it goes.
  MARKED   the same read, in a test with a case README already marks
  ABSENT   the line asserts that the field is not there: `'field' in row` with `.toBe(false)`, `.toBeUndefined()`,
           `.not.toHaveProperty(`; or it only names the field, in a test that checks names with
           `expect(<name> in <row>…).toBe(false)`
  CHECK    another schema of the new contract still has a property of that name: read the line by hand

What it does not see: a field read through destructuring or a computed key; an assertion split over several lines
(each line is judged alone); a field whose type or meaning changed while its name stayed. A test that both checks
names for absence and reads one of them by its name is taken as ABSENT.

Usage:
  check-removed-fields.py --old <openapi json> --new <openapi json> [--root <checkout of this repo>]
  check-removed-fields.py --control-plane <checkout> --base <ref> --head <ref> [--root <checkout of this repo>]
Last line: FIELDS_RESULT=OK|STALE stale=<n> marked=<n> absent=<n> check=<n> removed=<names>. Exit 1 on STALE.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys

CASE_ID = re.compile(r"\b([A-Z][A-Z0-9]*-\d+)\b")
ID_RANGE = re.compile(r"\b([A-Z][A-Z0-9]*)-(\d+)(?:\.\.|…)(\d+)\b")
TEST_LINE = re.compile(r"""^\s*test(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(['"`])(.*?)\1""")
GROUP = re.compile(r"((?:[A-Z][A-Z0-9]*-\d+(?:\s+to\s+[A-Z][A-Z0-9]*-\d+)?(?:\s*,\s*|\s+and\s+)?)+)\s*\(([^)]*)\)")
NAMES_CHECKED_ABSENT = re.compile(r"expect\(\s*[A-Za-z_$][\w$]*\s+in\s+[^)]*\)\s*\.toBe\(false\)")
EXCUSES = ("extended", "plan only", "not covered")


def properties_by_schema(contract):
    schemas = contract.get("components", {}).get("schemas", {})
    return {name: set((schema or {}).get("properties", {}) or {}) for name, schema in schemas.items()}


def removed_fields(old, new):
    """{field: [schemas it left]} for properties the old contract had and the new one's same schema has not."""
    before, after = properties_by_schema(old), properties_by_schema(new)
    removed = {}
    for schema, fields in before.items():
        for field in sorted(fields - after.get(schema, set())):
            removed.setdefault(field, []).append(schema)
    return removed


def fields_still_sent(new):
    still = set()
    for fields in properties_by_schema(new).values():
        still |= fields
    return still


def marked_cases(readme_text):
    """Case IDs the last cell of a table row of README marks as extended, plan only or not covered."""
    marked = set()
    rows = "\n".join(line.rstrip().rstrip("|").rsplit("|", 1)[-1]
                     for line in readme_text.split("\n") if line.lstrip().startswith("|"))
    for ids, mark in GROUP.findall(rows):
        if not any(excuse in mark for excuse in EXCUSES):
            continue
        for start, end in re.findall(r"([A-Z][A-Z0-9]*-\d+)\s+to\s+([A-Z][A-Z0-9]*-\d+)", ids):
            prefix, first = start.rsplit("-", 1)
            last = end.rsplit("-", 1)[1]
            for number in range(int(first), int(last) + 1):
                marked.add(f"{prefix}-{number:0{len(first)}d}")
        marked.update(CASE_ID.findall(ids))
    return marked


def cases_of(title):
    """Every case ID of a test title, a range `X-01..03` or `X-01…03` expanded."""
    cases = CASE_ID.findall(title)
    for prefix, first, last in ID_RANGE.findall(title):
        for number in range(int(first), int(last) + 1):
            case = f"{prefix}-{number:0{len(first)}d}"
            if case not in cases:
                cases.append(case)
    return cases


def code_of(line):
    return line.split("//", 1)[0]


def read_kind(field, line):
    """'access' for `.field`, 'name' for the field's name as a string, None when the line reads neither."""
    code, name = code_of(line), re.escape(field)
    if re.search(rf"\.{name}\b(?!\s*\()", code):
        return "access"
    if re.search(rf"""(['"`]){name}\1""", code):
        return "name"
    return None


def asserts_absence(field, line):
    code, name = code_of(line), re.escape(field)
    if re.search(rf"""(['"`]){name}\1\s+in\s+""", code) and ".toBe(false)" in code:
        return True
    if ".toBeUndefined()" in code and ".not.toBeUndefined()" not in code and re.search(rf"\.{name}\b", code):
        return True
    return bool(re.search(rf"""\.not\.toHaveProperty\(\s*(['"`]){name}\1""", code))


def scan(text, fields):
    """(case ids of the test, line number, field, kind, line, test checks names for absence) for every read."""
    lines = text.split("\n")
    owner = [None] * len(lines)
    starts = [index for index, line in enumerate(lines) if TEST_LINE.match(line)]
    for begin, following in zip(starts, starts[1:] + [len(lines)]):
        indent = re.match(r"\s*", lines[begin]).group(0)
        closing = next((index for index in range(begin + 1, following) if lines[index].startswith(indent + "})")),
                       following - 1)
        cases = cases_of(TEST_LINE.match(lines[begin]).group(2))
        names_checked = any(NAMES_CHECKED_ABSENT.search(code_of(line)) for line in lines[begin:closing + 1])
        for index in range(begin, closing + 1):
            owner[index] = (cases, names_checked)
    hits = []
    for index, line in enumerate(lines):
        cases, names_checked = owner[index] or ([], False)
        for field in fields:
            kind = read_kind(field, line)
            if kind:
                hits.append((cases, index + 1, field, kind, line.strip(), names_checked))
    return hits


def classify(cases, field, kind, line, names_checked, still, marked):
    if asserts_absence(field, line) or (kind == "name" and names_checked):
        return "ABSENT"
    if field in still:
        return "CHECK"
    if any(case in marked for case in cases):
        return "MARKED"
    return "STALE"


def files_read(root):
    found = set(root.rglob("*.spec.ts")) | set((root / "lib").rglob("*.ts"))
    return sorted(path for path in found if "node_modules" not in path.parts)


def run(old, new, root):
    removed = removed_fields(old, new)
    still = fields_still_sent(new)
    marked = marked_cases((root / "README.md").read_text(encoding="utf-8"))
    counts = {"STALE": 0, "MARKED": 0, "ABSENT": 0, "CHECK": 0}
    lines = []
    for path in files_read(root):
        text = path.read_text(encoding="utf-8")
        for cases, number, field, kind, line, names_checked in scan(text, sorted(removed)):
            verdict = classify(cases, field, kind, line, names_checked, still, marked)
            counts[verdict] += 1
            lines.append(f"{verdict:7} {','.join(cases) or '-':10} {path.relative_to(root)}:{number}  {field}  {line[:140]}")
    return removed, counts, lines


def contract_at(checkout, ref):
    shown = subprocess.run(["git", "-C", str(checkout), "show", f"{ref}:api/openapi-v1.json"],
                           capture_output=True, text=True)
    if shown.returncode != 0:
        raise SystemExit(f"cannot read api/openapi-v1.json at {ref} of {checkout}: {shown.stderr.strip()}")
    return json.loads(shown.stdout)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--old")
    parser.add_argument("--new")
    parser.add_argument("--control-plane")
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parent))
    args = parser.parse_args(argv)
    if args.old and args.new and not (args.control_plane or args.base or args.head):
        old = json.loads(pathlib.Path(args.old).read_text(encoding="utf-8"))
        new = json.loads(pathlib.Path(args.new).read_text(encoding="utf-8"))
    elif args.control_plane and args.base and args.head and not (args.old or args.new):
        old, new = contract_at(args.control_plane, args.base), contract_at(args.control_plane, args.head)
    else:
        parser.error("give --old and --new, or --control-plane with --base and --head")
    removed, counts, lines = run(old, new, pathlib.Path(args.root))
    for field in sorted(removed):
        print(f"REMOVED {field}  (left {', '.join(removed[field])})")
    for line in lines:
        print(line)
    verdict = "STALE" if counts["STALE"] else "OK"
    print(f"FIELDS_RESULT={verdict} stale={counts['STALE']} marked={counts['MARKED']} absent={counts['ABSENT']} "
          f"check={counts['CHECK']} removed={','.join(sorted(removed)) or '-'}")
    return 1 if counts["STALE"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
