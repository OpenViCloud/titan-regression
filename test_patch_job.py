#!/usr/bin/env python3
"""Tests of patch-job.py. Run: python3 test_patch_job.py"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("patch_job", HERE / "patch-job.py")
patch_job = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(patch_job)


def job(volumes):
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": "regression-smoke-r1", "ownerReferences": [{"kind": "CronJob", "name": "titan-regression"}]},
        "spec": {"template": {"spec": {"volumes": volumes, "containers": [{"name": "playwright"}]}}},
    }


SPECS = {"name": "specs", "configMap": {"name": "titan-regression-specs", "optional": True}}
RUNNER = {"name": "runner", "configMap": {"name": "titan-regression-runner"}}
WORK = {"name": "work", "emptyDir": {}}


class PatchJobTest(unittest.TestCase):
    def test_renames_the_specs_config_map_and_nothing_else(self):
        out = patch_job.patch(job([RUNNER, SPECS, WORK]), "titan-regression-specs-regression-smoke-r1")
        volumes = {v["name"]: v for v in out["spec"]["template"]["spec"]["volumes"]}
        self.assertEqual(volumes["specs"]["configMap"]["name"], "titan-regression-specs-regression-smoke-r1")
        self.assertTrue(volumes["specs"]["configMap"]["optional"])
        self.assertEqual(volumes["runner"]["configMap"]["name"], "titan-regression-runner")
        self.assertEqual(out["metadata"], job([])["metadata"])
        self.assertEqual(out["spec"]["template"]["spec"]["containers"], [{"name": "playwright"}])

    def test_does_not_mutate_its_input(self):
        original = job([RUNNER, SPECS, WORK])
        patch_job.patch(original, "other")
        self.assertEqual(original, job([RUNNER, SPECS, WORK]))

    def test_a_job_without_the_specs_volume_is_an_error(self):
        with self.assertRaises(patch_job.PatchError):
            patch_job.patch(job([RUNNER, WORK]), "x")

    def test_a_specs_volume_that_is_not_a_config_map_is_an_error(self):
        with self.assertRaises(patch_job.PatchError):
            patch_job.patch(job([{"name": "specs", "emptyDir": {}}]), "x")

    def test_cli_reads_stdin_and_writes_stdout(self):
        run = subprocess.run([sys.executable, str(HERE / "patch-job.py"), "cm-for-this-job"],
                             input=json.dumps(job([SPECS])), capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        out = json.loads(run.stdout)
        self.assertEqual(out["spec"]["template"]["spec"]["volumes"][0]["configMap"]["name"], "cm-for-this-job")

    def test_cli_exits_non_zero_on_a_job_it_cannot_patch(self):
        run = subprocess.run([sys.executable, str(HERE / "patch-job.py"), "x"],
                             input=json.dumps(job([WORK])), capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(run.stdout, "")

    def test_env_is_added_to_every_container_after_what_it_had(self):
        j = job([SPECS])
        j["spec"]["template"]["spec"]["containers"] = [{"name": "playwright", "env": [{"name": "HOME", "value": "/work"}]}]
        out = patch_job.patch(j, "cm", {"PHASE4_KEY_V": "ssh-ed25519 AAAA v"})
        self.assertEqual(out["spec"]["template"]["spec"]["containers"][0]["env"],
                         [{"name": "HOME", "value": "/work"}, {"name": "PHASE4_KEY_V", "value": "ssh-ed25519 AAAA v"}])

    def test_cli_takes_env_as_name_equals_value(self):
        run = subprocess.run([sys.executable, str(HERE / "patch-job.py"), "cm", "--env", "A=x=y", "--env", "B="],
                             input=json.dumps(job([SPECS])), capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        env = json.loads(run.stdout)["spec"]["template"]["spec"]["containers"][0]["env"]
        self.assertEqual(env, [{"name": "A", "value": "x=y"}, {"name": "B", "value": ""}])

    def test_cli_refuses_env_without_a_name(self):
        for bad in ("novalue", "=x", "lower-case=x"):
            run = subprocess.run([sys.executable, str(HERE / "patch-job.py"), "cm", "--env", bad],
                                 input=json.dumps(job([SPECS])), capture_output=True, text=True)
            self.assertEqual(run.returncode, 2, bad)
            self.assertEqual(run.stdout, "")


if __name__ == "__main__":
    unittest.main()
