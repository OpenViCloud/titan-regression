#!/usr/bin/env python3
"""Tests of check-removed-fields.py. Run: python3 test_check_removed_fields.py"""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "check_removed_fields", pathlib.Path(__file__).resolve().parent / "check-removed-fields.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)


def contract(**schemas):
    return {"components": {"schemas": {
        name: {"properties": {field: {} for field in fields}} for name, fields in schemas.items()}}}


OLD = contract(VmOffering=["id", "name", "cpu", "vcpu"], VolumeOffering=["id", "sizeGb"], Volume=["id", "sizeGb"],
               Vm=["id", "transition"])
NEW = contract(VmOffering=["id", "name", "vcpu"], VolumeOffering=["id"], Volume=["id", "sizeGb"], Vm=["id"])

README = """Prose that is not a table row: CAT-01 (extended) here marks nothing.

| # | Module | What | Dev | Release | Spec |
|---|---|---|---|---|---|
| 2 | `catalog` | offerings | yes | yes | yes, except CAT-14 (host, not covered), CAT-02 and CAT-03 (extended) |
| 3 | `network` | networks | yes | yes | yes, except NET-08 to NET-10 (not covered: measured elsewhere), NET-20 (host) |
| 4 | `vm` | vms | yes | yes | yes, except VM-31 (plan only) |
"""

SPEC = """import { test, expect } from '@playwright/test'

const early = row.cpu

test.describe('catalog', () => {
  test('CAT-01 vm offerings carry sizing', async () => {
    expect(offering.vcpu).toBeGreaterThan(0)
    expect(offering.cpu).toBeGreaterThan(0)
    expect(offering.cpu).not.toBeNull()
  })

  test('CAT-02 the raw text keeps every digit', async () => {
    expect(rawNumberField(text, id, 'cpu')).toBe('0.5')
    // the cpu field is compared as text: offering.cpu
  })

  test('CAT-04 templates carry no sizing', async () => {
    expect(template.cpu).toBeUndefined()
    expect(template).not.toHaveProperty('cpu')
    expect('cpu' in template).toBe(false)
    expect(template.cpu).not.toBeUndefined()
  })

  test('CAT-05 a volume keeps its size', async () => {
    expect(volume.sizeGb).toBe(10)
    expect(process.cpu()).toBeTruthy()
  })

  test('CON-11 the old fields are gone', async () => {
    const oldFields = ['transition', 'cpu']
    for (const field of oldFields) {
      expect(field in row, `${field} must be gone`).toBe(false)
    }
  })

  test('TFP-01..03, VM-31 several cases in one test', async () => {
    expect(vm.transition).toBe('Creating')
  })

  test.afterAll(async () => {
    await waitVm((v) => v.transition === null)
  })
})

function cpuOf(offering: any): number {
  return offering.cpu
}
"""

HELPER = """export function sizeOf(offering: any): number {
  return offering.cpu
}
"""


def verdicts(lines):
    return [(line.split()[0], line.split()[1], line.split()[2].rsplit(":", 1)[1]) for line in lines]


class RemovedFields(unittest.TestCase):
    def test_a_property_a_schema_lost_is_removed_and_one_it_kept_is_not(self):
        self.assertEqual({"cpu": ["VmOffering"], "sizeGb": ["VolumeOffering"], "transition": ["Vm"]},
                         check.removed_fields(OLD, NEW))

    def test_a_schema_that_left_the_contract_loses_all_its_properties(self):
        self.assertEqual({"a": ["Gone"], "b": ["Gone"]}, check.removed_fields(contract(Gone=["a", "b"]), contract()))

    def test_nothing_is_removed_between_two_equal_contracts(self):
        self.assertEqual({}, check.removed_fields(NEW, NEW))


class MarkedCases(unittest.TestCase):
    def test_every_id_before_a_mark_carries_it(self):
        self.assertLessEqual({"CAT-14", "CAT-02", "CAT-03", "VM-31"}, check.marked_cases(README))

    def test_a_range_is_expanded(self):
        self.assertLessEqual({"NET-08", "NET-09", "NET-10"}, check.marked_cases(README))

    def test_a_mark_that_is_not_an_excuse_marks_nothing(self):
        self.assertNotIn("NET-20", check.marked_cases(README))

    def test_a_mark_outside_a_table_row_marks_nothing(self):
        self.assertNotIn("CAT-01", check.marked_cases(README))

    def test_a_mark_in_another_cell_than_the_last_marks_nothing(self):
        self.assertEqual(set(), check.marked_cases("| 2 | `x` | CAT-09 (extended) | yes | yes | yes |\n"))


class CasesOfATitle(unittest.TestCase):
    def test_every_id_of_the_title_counts_and_a_range_is_expanded(self):
        self.assertEqual(["TFP-01", "VM-31", "TFP-02", "TFP-03"], check.cases_of("TFP-01..03, VM-31 several cases"))
        self.assertEqual(["SSH-01", "SSH-02", "SSH-03"], check.cases_of("SSH-01…03 keys"))

    def test_a_title_without_an_id_has_no_case(self):
        self.assertEqual([], check.cases_of("a helper test"))


class Run(unittest.TestCase):
    def run_on(self, readme=README, spec=SPEC, helper=HELPER, old=OLD, new=NEW):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / "README.md").write_text(readme, encoding="utf-8")
            (root / "catalog").mkdir()
            (root / "catalog" / "catalog.spec.ts").write_text(spec, encoding="utf-8")
            (root / "lib").mkdir()
            (root / "lib" / "sizes.ts").write_text(helper, encoding="utf-8")
            (root / "node_modules" / "x").mkdir(parents=True)
            (root / "node_modules" / "x" / "x.spec.ts").write_text(spec, encoding="utf-8")
            return check.run(old, new, root)

    def test_each_read_gets_the_verdict_of_its_test(self):
        removed, counts, lines = self.run_on()
        self.assertEqual(["cpu", "sizeGb", "transition"], sorted(removed))
        self.assertEqual([
            ("STALE", "-", "3"),             # a read before the first test has no case
            ("STALE", "CAT-01", "8"),        # .cpu in a case README does not mark
            ("STALE", "CAT-01", "9"),        # .not.toBeNull() asserts presence
            ("MARKED", "CAT-02", "13"),      # 'cpu' as a string, in a case marked (extended)
            ("ABSENT", "CAT-04", "18"),      # .toBeUndefined()
            ("ABSENT", "CAT-04", "19"),      # .not.toHaveProperty('cpu')
            ("ABSENT", "CAT-04", "20"),      # 'cpu' in template … toBe(false)
            ("STALE", "CAT-04", "21"),       # .not.toBeUndefined() asserts presence
            ("CHECK", "CAT-05", "25"),       # sizeGb: Volume still has it
            ("ABSENT", "CON-11", "30"),      # names listed in a test that checks names for absence
            ("ABSENT", "CON-11", "30"),
            ("MARKED", "TFP-01,VM-31,TFP-02,TFP-03", "37"),   # one of the title's cases is marked
            ("STALE", "-", "41"),            # a hook after a marked test is not that test
            ("STALE", "-", "46"),            # nor is a helper below the last test
            ("STALE", "-", "2"),             # lib/sizes.ts: a helper has no case
        ], verdicts(lines))
        self.assertEqual({"STALE": 7, "MARKED": 2, "ABSENT": 5, "CHECK": 1}, counts)

    def test_a_comment_and_a_method_call_are_not_reads(self):
        _, _, lines = self.run_on()
        numbers = [number for _, case, number in verdicts(lines) if case != "-"]
        self.assertNotIn("14", numbers)   # // … offering.cpu
        self.assertNotIn("26", numbers)   # process.cpu()

    def test_marking_the_case_in_readme_clears_its_stale_reads(self):
        readme = README.replace("CAT-02 and CAT-03 (extended)", "CAT-01, CAT-02 and CAT-03 (extended)")
        _, counts, lines = self.run_on(readme=readme)
        self.assertEqual([("STALE", "-", "3"), ("STALE", "CAT-04", "21"), ("STALE", "-", "41"), ("STALE", "-", "46"),
                          ("STALE", "-", "2")],
                         [verdict for verdict in verdicts(lines) if verdict[0] == "STALE"])
        self.assertEqual(4, counts["MARKED"])

    def test_absence_wins_over_a_mark_and_a_name_still_sent_wins_over_a_mark(self):
        readme = README.replace("CAT-02 and CAT-03 (extended)", "CAT-02, CAT-04 and CAT-05 (extended)")
        _, _, lines = self.run_on(readme=readme)
        self.assertIn(("ABSENT", "CAT-04", "18"), verdicts(lines))
        self.assertIn(("CHECK", "CAT-05", "25"), verdicts(lines))

    def test_absence_wins_over_a_name_still_sent(self):
        spec = "test('CAT-05 x', async () => {\n  expect(volume.sizeGb).toBeUndefined()\n})\n"
        _, _, lines = self.run_on(spec=spec, helper="")
        self.assertEqual([("ABSENT", "CAT-05", "2")], verdicts(lines))

    def test_an_access_in_a_test_that_checks_names_for_absence_stays_stale(self):
        spec = ("test('CON-11 x', async () => {\n  expect(field in row).toBe(false)\n"
                "  expect(row.cpu).toBe(1)\n})\n")
        _, _, lines = self.run_on(spec=spec, helper="")
        self.assertEqual([("STALE", "CON-11", "3")], verdicts(lines))

    def test_a_test_written_on_one_line_ends_on_that_line(self):
        readme = README.replace("CAT-02 and CAT-03 (extended)", "CAT-01, CAT-02 and CAT-03 (extended)")
        spec = ("test('CAT-01 x', async () => { expect(offering.cpu).toBe(1) })\n"
                "test.afterAll(async () => {\n  await wait((v) => v.cpu === 1)\n})\n")
        _, _, lines = self.run_on(readme=readme, spec=spec, helper="")
        self.assertEqual([("MARKED", "CAT-01", "1"), ("STALE", "-", "3")], verdicts(lines))

    def test_node_modules_is_not_read(self):
        _, _, lines = self.run_on()
        self.assertFalse([line for line in lines if "node_modules" in line])


class Main(unittest.TestCase):
    def main_on(self, spec, old, new):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / "README.md").write_text(README, encoding="utf-8")
            (root / "a.spec.ts").write_text(spec, encoding="utf-8")
            (root / "old.json").write_text(json.dumps(old), encoding="utf-8")
            (root / "new.json").write_text(json.dumps(new), encoding="utf-8")
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                code = check.main(["--old", str(root / "old.json"), "--new", str(root / "new.json"),
                                   "--root", str(root)])
            return code, printed.getvalue().strip().split("\n")[-1]

    def test_a_stale_read_exits_1_and_the_last_line_counts_every_verdict(self):
        code, last = self.main_on(SPEC, OLD, NEW)
        self.assertEqual(1, code)
        self.assertEqual("FIELDS_RESULT=STALE stale=6 marked=2 absent=5 check=1 removed=cpu,sizeGb,transition", last)

    def test_marked_absent_and_check_lines_alone_exit_0(self):
        spec = "\n".join(line for line in SPEC.split("\n")
                         if "early" not in line and "CAT-01" not in line and "not.toBe" not in line
                         and "toBeGreaterThan" not in line and "waitVm" not in line and "return offering" not in line)
        code, last = self.main_on(spec, OLD, NEW)
        self.assertEqual(0, code)
        self.assertEqual("FIELDS_RESULT=OK stale=0 marked=2 absent=5 check=1 removed=cpu,sizeGb,transition", last)

    def test_two_equal_contracts_exit_0_with_nothing_removed(self):
        code, last = self.main_on(SPEC, NEW, NEW)
        self.assertEqual(0, code)
        self.assertEqual("FIELDS_RESULT=OK stale=0 marked=0 absent=0 check=0 removed=-", last)

    def test_half_of_the_arguments_is_refused(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            check.main(["--old", "x.json"])


if __name__ == "__main__":
    unittest.main()
