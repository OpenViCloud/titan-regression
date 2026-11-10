#!/usr/bin/env python3
"""Tests of check-removed-fields.py. Run: python3 test_check_removed_fields.py"""
import importlib.util
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


OLD = contract(VmOffering=["id", "name", "cpu", "vcpu"], VolumeOffering=["id", "sizeGb"], Volume=["id", "sizeGb"])
NEW = contract(VmOffering=["id", "name", "vcpu"], VolumeOffering=["id"], Volume=["id", "sizeGb"])

README = """| # | Module | What | Dev | Release | Spec |
|---|---|---|---|---|---|
| 2 | `catalog` | offerings | yes | yes | yes, except CAT-14 (host, not covered), CAT-02 and CAT-03 (extended) |
| 3 | `network` | networks | yes | yes | yes, except NET-08 to NET-10 (not covered: measured elsewhere), NET-20 (host) |
| 4 | `vm` | vms | yes | yes | yes, except VM-31 (plan only) |
"""

SPEC = """import { test, expect } from '@playwright/test'

test.describe('catalog', () => {
  test('CAT-01 vm offerings carry sizing', async () => {
    expect(offering.vcpu).toBeGreaterThan(0)
    expect(offering.cpu).toBeGreaterThan(0)
  })

  test('CAT-02 the raw text keeps every digit', async () => {
    expect(rawNumberField(text, id, 'cpu')).toBe('0.5')
    // the cpu field is compared as text: offering.cpu
  })

  test('CAT-04 templates carry no sizing', async () => {
    expect(template.cpu).toBeUndefined()
    expect(template).not.toHaveProperty('cpu')
  })

  test('CAT-05 a volume keeps its size', async () => {
    expect(volume.sizeGb).toBe(10)
    expect(process.cpu()).toBeTruthy()
  })
})
"""


class RemovedFields(unittest.TestCase):
    def test_a_property_a_schema_lost_is_removed_and_one_it_kept_is_not(self):
        self.assertEqual({"cpu": ["VmOffering"], "sizeGb": ["VolumeOffering"]}, check.removed_fields(OLD, NEW))

    def test_a_schema_that_left_the_contract_loses_all_its_properties(self):
        self.assertEqual({"a": ["Gone"], "b": ["Gone"]}, check.removed_fields(contract(Gone=["a", "b"]), contract()))

    def test_nothing_is_removed_between_two_equal_contracts(self):
        self.assertEqual({}, check.removed_fields(NEW, NEW))


class MarkedCases(unittest.TestCase):
    def test_every_id_before_a_mark_carries_it(self):
        marked = check.marked_cases(README)
        self.assertLessEqual({"CAT-14", "CAT-02", "CAT-03", "VM-31"}, marked)

    def test_a_range_is_expanded(self):
        self.assertLessEqual({"NET-08", "NET-09", "NET-10"}, check.marked_cases(README))

    def test_a_mark_that_is_not_an_excuse_marks_nothing(self):
        self.assertNotIn("NET-20", check.marked_cases(README))

    def test_an_unlisted_case_is_not_marked(self):
        self.assertNotIn("CAT-01", check.marked_cases(README))


class Run(unittest.TestCase):
    def run_on(self, readme=README, spec=SPEC, old=OLD, new=NEW):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / "README.md").write_text(readme, encoding="utf-8")
            (root / "catalog").mkdir()
            (root / "catalog" / "catalog.spec.ts").write_text(spec, encoding="utf-8")
            (root / "node_modules" / "x").mkdir(parents=True)
            (root / "node_modules" / "x" / "x.spec.ts").write_text(spec, encoding="utf-8")
            return check.run(old, new, root)

    def verdicts(self, lines):
        return [(line.split()[0], line.split()[1], line.split()[2].rsplit(":", 1)[1]) for line in lines]

    def test_each_read_gets_the_verdict_of_its_case(self):
        removed, counts, lines = self.run_on()
        self.assertEqual(["cpu", "sizeGb"], sorted(removed))
        self.assertEqual([
            ("STALE", "CAT-01", "6"),      # .cpu in a case README does not mark
            ("MARKED", "CAT-02", "10"),    # 'cpu' as a string, in a case marked (extended)
            ("ABSENT", "CAT-04", "15"),    # toBeUndefined
            ("ABSENT", "CAT-04", "16"),    # not.toHaveProperty
            ("CHECK", "CAT-05", "20"),     # sizeGb: Volume still has it
        ], self.verdicts(lines))
        self.assertEqual({"STALE": 1, "MARKED": 1, "ABSENT": 2, "CHECK": 1}, counts)

    def test_a_comment_and_a_method_call_are_not_reads(self):
        _, _, lines = self.run_on()
        self.assertNotIn("11", [number for _, _, number in self.verdicts(lines)])   # // … offering.cpu
        self.assertNotIn("21", [number for _, _, number in self.verdicts(lines)])   # process.cpu()

    def test_marking_the_case_in_readme_clears_the_stale_read(self):
        readme = README.replace("CAT-02 and CAT-03 (extended)", "CAT-01, CAT-02 and CAT-03 (extended)")
        _, counts, _ = self.run_on(readme=readme)
        self.assertEqual(0, counts["STALE"])
        self.assertEqual(2, counts["MARKED"])

    def test_node_modules_is_not_read(self):
        _, _, lines = self.run_on()
        self.assertFalse([line for line in lines if "node_modules" in line])

    def test_main_exits_1_on_a_stale_read_and_0_without(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / "README.md").write_text(README, encoding="utf-8")
            (root / "a.spec.ts").write_text(SPEC, encoding="utf-8")
            (root / "old.json").write_text(json.dumps(OLD), encoding="utf-8")
            (root / "new.json").write_text(json.dumps(NEW), encoding="utf-8")
            base = ["--root", str(root)]
            self.assertEqual(1, check.main(["--old", str(root / "old.json"), "--new", str(root / "new.json")] + base))
            self.assertEqual(0, check.main(["--old", str(root / "new.json"), "--new", str(root / "new.json")] + base))


if __name__ == "__main__":
    unittest.main()
