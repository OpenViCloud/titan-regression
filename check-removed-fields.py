#!/usr/bin/env python3
"""Fails when a spec still reads a response field that left the public API and README does not mark its case.

Two copies of the control plane's api/openapi-v1.json are compared: a property a schema had in the old one and has
no more in the new one is a removed field. Every spec line that reads such a field (`.field`, or the field's name as a
string) is listed under the case ID of the test it sits in:

  STALE    the field is in no schema of the new contract, and README's Spec column does not mark the case
           `(extended)`, `(plan only)` or `(not covered)`: the spec asserts something the API no longer sends
  MARKED   the same read, in a case README already marks
  ABSENT   the line asserts that the field is not there (`not.` or `toBeUndefined`)
  CHECK    another schema of the new contract still has a property of that name: read the line by hand

What it does not see: a field read through destructuring or a computed key, and a field whose type or meaning
changed while its name stayed.

Usage:
  check-removed-fields.py --old <openapi json> --new <openapi json>
  check-removed-fields.py --control-plane <checkout> --base <ref> --head <ref>
Last line: FIELDS_RESULT=OK|STALE stale=<n> marked=<n> absent=<n> check=<n> removed=<names>. Exit 1 on STALE.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys

CASE_ID = re.compile(r"\b([A-Z][A-Z0-9]*-\d+)\b")
TEST_LINE = re.compile(r"""^\s*test(?:\.(?:only|skip|fixme|fail|slow))?\(\s*(['"`])(.*?)\1""")
GROUP = re.compile(r"((?:[A-Z][A-Z0-9]*-\d+(?:\s+to\s+[A-Z][A-Z0-9]*-\d+)?(?:\s*,\s*|\s+and\s+)?)+)\s*\(([^)]*)\)")
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
    """Case IDs README's module table marks as extended, plan only or not covered (ranges `X-1 to X-3` expanded)."""
    marked = set()
    for ids, mark in GROUP.findall(readme_text):
        if not any(excuse in mark for excuse in EXCUSES):
            continue
        for start, end in re.findall(r"([A-Z][A-Z0-9]*-\d+)\s+to\s+([A-Z][A-Z0-9]*-\d+)", ids):
            prefix, first = start.rsplit("-", 1)
            last = end.rsplit("-", 1)[1]
            for number in range(int(first), int(last) + 1):
                marked.add(f"{prefix}-{number:0{len(first)}d}")
        marked.update(CASE_ID.findall(ids))
    return marked


def reads_of(field, line):
    code = line.split("//", 1)[0]
    name = re.escape(field)
    return bool(re.search(rf"\.{name}\b(?!\s*\()", code) or re.search(rf"""(['"`]){name}\1""", code))


def scan_spec(path, text, fields):
    """(case id or None, line number, field, line) for every read of one of the fields."""
    hits, case = [], None
    for number, line in enumerate(text.split("\n"), 1):
        title = TEST_LINE.match(line)
        if title:
            found = CASE_ID.search(title.group(2))
            case = found.group(1) if found else None
        for field in fields:
            if reads_of(field, line):
                hits.append((case, number, field, line.strip()))
    return hits


def classify(case, field, line, still, marked):
    if "not." in line or "toBeUndefined" in line:
        return "ABSENT"
    if field in still:
        return "CHECK"
    if case in marked:
        return "MARKED"
    return "STALE"


def run(old, new, root):
    removed = removed_fields(old, new)
    still = fields_still_sent(new)
    marked = marked_cases((root / "README.md").read_text(encoding="utf-8"))
    counts = {"STALE": 0, "MARKED": 0, "ABSENT": 0, "CHECK": 0}
    lines = []
    for path in sorted(root.rglob("*.spec.ts")):
        if "node_modules" in path.parts:
            continue
        for case, number, field, line in scan_spec(path, path.read_text(encoding="utf-8"), sorted(removed)):
            verdict = classify(case, field, line, still, marked)
            counts[verdict] += 1
            lines.append(f"{verdict:7} {case or '-':10} {path.relative_to(root)}:{number}  {field}  {line[:140]}")
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
