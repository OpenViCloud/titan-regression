#!/usr/bin/env python3
"""Tests of phase4.py against a fake kubectl, ssh and ssh-keygen and a sleep that returns at once. Run: python3 test_phase4.py"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("phase4", HERE / "phase4.py")
phase4 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(phase4)

# The fakes write each call to FAKE_STATE/calls. kubectl: `logs <pod>` prints FAKE_LOG_<n> (n = how many `logs` calls
# came before, the last one repeats); `logs -l app=…` prints FAKE_WORKER_LOG; `exec … touch <file>` creates the file under
# FAKE_STATE/pod, after which `logs <pod>` prints FAKE_LOG_AFTER_TOUCH_<files touched> or FAKE_LOG_AFTER_TOUCH when set. ssh: a command holding `incus query '/1.0/instances/<x>` prints FAKE_INSTANCE_<x> (absent ⇒ exit 1) or,
# for `/storage-pools/`, FAKE_VOLUME; FAKE_COPY_READS_BEFORE_GONE ends the copy after that many reads of it.
# FAKE_GUEST {substring: [[output, exit], …]}: a host command holding the substring gets its next pair (the last repeats).
# kubectl `exec … openssl` prints FAKE_OPENSSL (unset ⇒ exit 127, no openssl); `exec -i … grep` counts the stdin lines
# holding FAKE_POD_PASSWORD, the pod's password file, which no argument carries.
FAKE_KUBECTL = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, pathlib, sys
    state = pathlib.Path(os.environ["FAKE_STATE"])
    args = sys.argv[1:]
    with open(state / "calls", "a") as calls:
        calls.write("kubectl " + " ".join(args) + "\\n")
    if args[:1] == ["--kubeconfig"]:
        args = args[2:]
    if args[:1] == ["-n"]:
        args = args[2:]
    def items(*names):
        print(json.dumps({"items": [{"metadata": {"name": n, "namespace": "ns-" + n}} for n in names]}))
    if args[:2] == ["get", "cronjob"]:
        items("titan-regression")
    elif args[:2] == ["get", "deployment"]:
        items("control-plane")
    elif args[:2] == ["get", "pods"]:
        label = next(a for a in args if "=" in a)
        if label.startswith("job-name="):
            counter = state / "pod-reads"
            n = int(counter.read_text()) if counter.exists() else 0
            counter.write_text(str(n + 1))
            items(*(["regression-phase4-prd-abc"] if n >= int(os.environ.get("FAKE_POD_AFTER", "0")) else []))
        elif label == "app=incus-worker-inventory":
            items(*filter(None, [os.environ.get("FAKE_INVENTORY")]))
        else:
            items("incus-worker-1")
    elif args[:1] == ["logs"] and "-l" in args:
        print(os.environ.get("FAKE_WORKER_LOG", ""))
    elif args[:1] == ["logs"]:
        counter = state / "log-reads"
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        touched = len(list((state / "pod").iterdir())) if (state / "pod").exists() else 0
        if touched and os.environ.get(f"FAKE_LOG_AFTER_TOUCH_{touched}"):
            print(os.environ[f"FAKE_LOG_AFTER_TOUCH_{touched}"])
        elif touched and os.environ.get("FAKE_LOG_AFTER_TOUCH"):
            print(os.environ["FAKE_LOG_AFTER_TOUCH"])
        else:
            logs = [v for k, v in sorted(os.environ.items()) if k.startswith("FAKE_LOG_") and k[9:].isdigit()]
            print(logs[min(n, len(logs) - 1)])
    elif args[:1] == ["exec"] and any("openssl" in a for a in args):
        if "FAKE_OPENSSL" not in os.environ:
            print("sh: 1: openssl: not found", file=sys.stderr)
            sys.exit(127)
        print(os.environ["FAKE_OPENSSL"])
    elif args[:1] == ["exec"] and any("grep" in a for a in args):
        count = sum(os.environ["FAKE_POD_PASSWORD"] in line for line in sys.stdin.read().splitlines())
        print(count)
        sys.exit(0 if count else 1)
    elif args[:1] == ["exec"] and "touch" in args:
        (state / "pod").mkdir(exist_ok=True)
        (state / "pod" / pathlib.Path(args[-1]).name).write_text("")
''')

FAKE_SSH = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, pathlib, re, sys
    state = pathlib.Path(os.environ["FAKE_STATE"])
    with open(state / "calls", "a") as calls:
        calls.write("ssh " + " ".join(sys.argv[1:]) + "\\n")
    if not sys.stdin.isatty() and sys.stdin.read() != "":
        print("stdin was not closed", file=sys.stderr)
        sys.exit(9)
    if "-O" in sys.argv:
        sys.exit(1 if os.environ.get("FAKE_NO_MASTER") else 0)
    command = sys.argv[-1]
    queries = json.loads(os.environ.get("FAKE_QUERIES", "{}"))
    q = re.search(r"incus query '([^']+)'", command)
    if q and os.environ.get("FAKE_HANG") and os.environ["FAKE_HANG"] in q.group(1):
        import time
        time.sleep(5)
    if q and q.group(1) in queries:
        counter = state / "query-reads"
        n = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(n))
        if os.environ.get("FAKE_STOP_AFTER") and n >= int(os.environ["FAKE_STOP_AFTER"]):
            pathlib.Path(os.environ["FAKE_STOP_FILE"]).write_text("")
        print(json.dumps(queries[q.group(1)]))
        sys.exit(0)
    m = re.search(r"incus query '/1.0/instances/([a-z0-9]+)", command)
    if m:
        name = m.group(1)
        counter = state / ("reads-" + name)
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        gone_after = os.environ.get("FAKE_COPY_READS_BEFORE_GONE")
        text = os.environ.get("FAKE_INSTANCE_" + name)
        if text is None or (name.startswith("bk") and gone_after and n >= int(gone_after)):
            print("Error: Instance not found", file=sys.stderr)
            sys.exit(1)
        print(text)
    elif "/storage-pools/" in command and "/custom/bkv" in command:
        counter = state / "reads-bkv"
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        if n >= int(os.environ.get("FAKE_VOLUME_COPY_READS", "0")):
            print("Error: Storage volume not found", file=sys.stderr)
            sys.exit(1)
        print("{}")
    elif "/storage-pools/" in command:
        print(os.environ["FAKE_VOLUME"])
    elif any(k in command for k in json.loads(os.environ.get("FAKE_GUEST", "{}"))):
        guest = json.loads(os.environ["FAKE_GUEST"])
        key = next(k for k in guest if k in command)
        counter = state / ("guest-" + str(sorted(guest).index(key)))
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        output, code = guest[key][min(n, len(guest[key]) - 1)]
        print(output)
        sys.exit(code)
    else:
        print("ran: " + command)
        sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
''')

FAKE_KEYGEN = textwrap.dedent('''\
    #!/usr/bin/env python3
    import pathlib, sys
    path = pathlib.Path(sys.argv[sys.argv.index("-f") + 1])
    comment = sys.argv[sys.argv.index("-C") + 1]
    path.write_text("-----BEGIN OPENSSH PRIVATE KEY-----\\n")
    pathlib.Path(str(path) + ".pub").write_text(f"ssh-ed25519 AAAAC3fake{path.name} {comment}\\n")
''')

HOLD_SETUP = '2026-11-16T10:00:00.000Z HOLD setup {"project":"t-1"}'
GO_SETUP = '2026-11-16T10:00:30.000Z GO setup'
HOLD_VM28 = '2026-11-16T10:01:00.000Z HOLD vm28-limit {"project":"t-1"}'

VM = "vmaaaa"
COPY = "bkaaaa"
VOL = "volbbbb"
SOURCE = {"name": VM, "expanded_devices": {
    "root": {"type": "disk", "path": "/", "pool": "default"},
    "eth0": {"type": "nic", "network": "net-1"},
    VOL: {"type": "disk", "pool": "default", "source": VOL}}}
MASKED = {"name": COPY, "expanded_devices": {
    "root": {"type": "disk", "path": "/", "pool": "default"},
    "eth0": {"type": "nic", "network": "net-1"},
    VOL: {"type": "none"}}}
# `incus query` prints the metadata of the reply, not the envelope
UNMASKED = {"name": COPY, "expanded_devices": SOURCE["expanded_devices"]}
USED_BY_VM = {"name": VOL, "used_by": [f"/1.0/instances/{VM}?project=t-1"]}
USED_BY_BOTH = {"name": VOL, "used_by": [f"/1.0/instances/{VM}?project=t-1", f"/1.0/instances/{COPY}?project=t-1"]}
VOLUME_COPY = "bkvbbbb"
HOLD_GONE = ('2026-11-16T11:03:01.000Z HOLD bak18-gone {"project":"t-1","copy":"%s","volumeCopy":"%s"}'
             % (COPY, VOLUME_COPY))
HOLD_BAK18 = ('2026-11-16T10:02:00.000Z HOLD bak18 '
              + json.dumps({"project": "t-1", "vm": VM, "copy": COPY, "volume": VOL}, separators=(",", ":")))


def run(*args, **env_extra):
    """(exit code, stdout + stderr, calls, state dir) of one phase4.py run against the fakes."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="phase4-"))
    bin_dir, state = tmp / "bin", tmp / "state"
    bin_dir.mkdir()
    state.mkdir()
    for name, text in (("kubectl", FAKE_KUBECTL), ("ssh", FAKE_SSH), ("ssh-keygen", FAKE_KEYGEN),
                       ("sleep", "#!/bin/sh\nexit 0\n")):
        (bin_dir / name).write_text(text)
        (bin_dir / name).chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}
    env.update(PATH=f"{bin_dir}:{os.environ['PATH']}", FAKE_STATE=str(state), PHASE4_POLL_SECONDS="0", **env_extra)
    args = [a.replace("{tmp}", str(tmp)) for a in args]
    result = subprocess.run([sys.executable, str(HERE / "phase4.py"), *args], env=env, capture_output=True, text=True,
                            timeout=60, stdin=subprocess.DEVNULL)
    calls = (state / "calls").read_text() if (state / "calls").exists() else ""
    return result.returncode, result.stdout + result.stderr, calls, state


KUBE = ["--kubeconfig", "kc", "--job", "regression-phase4-prd"]
SSH = ["--control", "{tmp}/ctl", "--target", "debian@host"]


class PendingHoldTest(unittest.TestCase):
    def test_the_last_hold_without_go_or_skip_is_pending(self):
        self.assertEqual(phase4.pending_hold("\n".join([HOLD_SETUP, GO_SETUP, HOLD_VM28])),
                         ("vm28-limit", {"project": "t-1"}))

    def test_an_answered_hold_is_not_pending(self):
        self.assertIsNone(phase4.pending_hold("\n".join([HOLD_SETUP, GO_SETUP])))
        self.assertIsNone(phase4.pending_hold(HOLD_VM28 + "\n2026-11-16T10:01:09.000Z SKIP vm28-limit"))

    def test_a_go_for_another_step_does_not_answer_it(self):
        self.assertEqual(phase4.pending_hold(HOLD_SETUP + "\n2026-11-16T10:00:30.000Z GO setup-two")[0], "setup")


class WaitTest(unittest.TestCase):
    def test_wait_prints_the_pending_hold_once_it_is_logged(self):
        code, out, calls, _ = run("wait", *KUBE, FAKE_LOG_0="starting", FAKE_LOG_1=HOLD_SETUP)
        self.assertEqual(code, 0, out)
        self.assertIn('HOLD setup {"project": "t-1"}', out)
        self.assertIn("get pods -n ns-titan-regression -l job-name=regression-phase4-prd", calls)

    def test_wait_waits_for_the_pod_of_a_job_just_created(self):
        code, out, _, _ = run("wait", *KUBE, FAKE_POD_AFTER="2", FAKE_LOG_0=HOLD_SETUP)
        self.assertEqual(code, 0, out)
        self.assertIn("HOLD setup", out)

    def test_wait_ends_3_when_the_runner_finished_without_a_hold(self):
        code, out, _, _ = run("wait", *KUBE, FAKE_LOG_0=HOLD_SETUP + "\n" + GO_SETUP + "\nRESULTS_READY")
        self.assertEqual(code, 3, out)
        self.assertIn("NO_HOLD", out)

    def test_wait_gives_up_after_its_timeout(self):
        code, out, _, _ = run("wait", *KUBE, "--timeout-minutes", "0", FAKE_LOG_0="starting")
        self.assertEqual(code, 1, out)


class AnswerTest(unittest.TestCase):
    def test_go_touches_the_file_in_the_pod_and_returns_when_the_spec_said_go(self):
        log = "{tmp}/answers.log"
        code, out, calls, state = run("go", "setup", *KUBE, "--log", log,
                                      FAKE_LOG_0=HOLD_SETUP, FAKE_LOG_AFTER_TOUCH=HOLD_SETUP + "\n" + GO_SETUP)
        self.assertEqual(code, 0, out)
        self.assertTrue((state / "pod" / "go-setup").exists())
        self.assertIn("exec -n ns-titan-regression regression-phase4-prd-abc -- touch /work/results/go-setup", calls)
        text = pathlib.Path(str(state.parent / "answers.log")).read_text()
        self.assertRegex(text, r"\[\d\d:\d\d:\d\dZ\]\n\$ touch /work/results/go-setup\nGO setup\nexit=0\n")

    def test_skip_touches_skip(self):
        code, out, _, state = run("skip", "vm28-limit", *KUBE,
                                  FAKE_LOG_0=HOLD_VM28, FAKE_LOG_AFTER_TOUCH=HOLD_VM28 + "\n2026-11-16T10:01:09.000Z SKIP vm28-limit")
        self.assertEqual(code, 0, out)
        self.assertTrue((state / "pod" / "skip-vm28-limit").exists())

    def test_go_refuses_a_step_that_is_not_the_pending_hold(self):
        code, out, _, state = run("go", "obs01", *KUBE, FAKE_LOG_0=HOLD_VM28)
        self.assertEqual(code, 2, out)
        self.assertIn("vm28-limit", out)
        self.assertFalse((state / "pod").exists())


class HostTest(unittest.TestCase):
    def test_one_command_through_the_control_socket_with_a_timed_entry(self):
        code, out, calls, state = run("host", *SSH, "--log", "{tmp}/host.log", "--", "sudo incus list -f csv")
        self.assertEqual(code, 0, out)
        self.assertIn("-S " + str(state.parent / "ctl") + " -o ControlMaster=no -o BatchMode=yes debian@host", calls)
        text = (state.parent / "host.log").read_text()
        self.assertRegex(text, r"^# phase4\.py host \(ssh debian@host, ControlMaster\) · debian@host · \d{4}-\d\d-\d\dT")
        self.assertRegex(text, r"\[\d\d:\d\d:\d\dZ\]\n\$ sudo incus list -f csv\nran: sudo incus list -f csv\nexit=0\n$")

    def test_no_master_on_the_socket_stops_before_any_connection(self):
        code, out, calls, state = run("host", *SSH, "--log", "{tmp}/host.log", "--", "sudo incus list", FAKE_NO_MASTER="1")
        self.assertEqual(code, 2, out)
        self.assertIn("-O check", calls)
        self.assertNotIn("sudo incus list", calls)

    def test_the_exit_code_of_the_command_is_logged_and_returned(self):
        code, _, _, state = run("host", *SSH, "--log", "{tmp}/host.log", "--", "false", FAKE_EXIT="5")
        self.assertEqual(code, 5)
        self.assertIn("exit=5", (state.parent / "host.log").read_text())

    def test_key_placeholders_become_the_key_body(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        (tmp / "x.pub").write_text("ssh-ed25519 AAAAC3xbody rg-p4-x\n")
        code, out, calls, _ = run("host", *SSH, "--log", "{tmp}/host.log", "--keys", str(tmp), "--",
                                  "grep -c '{X}' /home/ubuntu/.ssh/authorized_keys")
        self.assertEqual(code, 0, out)
        self.assertIn("grep -c 'AAAAC3xbody' /home/ubuntu/.ssh/authorized_keys", calls)

    def test_local_runs_on_this_machine_and_logs_the_same_way(self):
        code, out, calls, state = run("host", "--local", "--log", "{tmp}/local.log", "--", "echo here")
        self.assertEqual(code, 0, out)
        self.assertNotIn("ssh ", calls)
        self.assertRegex((state.parent / "local.log").read_text(), r"\$ echo here\nhere\nexit=0\n$")


class KeysTest(unittest.TestCase):
    def test_keys_makes_three_pairs_once(self):
        code, out, _, state = run("keys", "{tmp}/keys")
        self.assertEqual(code, 0, out)
        for k in ("v", "u", "x"):
            self.assertTrue((state.parent / "keys" / f"{k}.pub").exists())
            self.assertNotIn("PRIVATE", out)
        (state.parent / "keys" / "v.pub").write_text("ssh-ed25519 AAAAkept rg-p4-v\n")
        code, out, _, _ = run("keys", str(state.parent / "keys"))
        self.assertEqual((state.parent / "keys" / "v.pub").read_text(), "ssh-ed25519 AAAAkept rg-p4-v\n")


class CopyVerdictTest(unittest.TestCase):
    def test_a_masked_copy_and_a_volume_used_only_by_its_vm_pass(self):
        self.assertEqual(phase4.copy_verdict(MASKED, USED_BY_VM, VM, COPY, VOL), [])

    def test_an_unmasked_copy_fails(self):
        self.assertTrue(any(VOL in p for p in phase4.copy_verdict(UNMASKED, USED_BY_VM, VM, COPY, VOL)))

    def test_the_copy_in_used_by_fails(self):
        self.assertTrue(any("used_by" in p for p in phase4.copy_verdict(MASKED, USED_BY_BOTH, VM, COPY, VOL)))

    def test_a_copy_without_root_or_nic_fails(self):
        bare = {"name": COPY, "expanded_devices": {VOL: {"type": "none"}}}
        problems = phase4.copy_verdict(bare, USED_BY_VM, VM, COPY, VOL)
        self.assertTrue(any("root" in p for p in problems) and any("nic" in p for p in problems), problems)


class Bak18Test(unittest.TestCase):
    def env(self, **extra):
        go = HOLD_BAK18 + "\n2026-11-16T11:03:00.000Z GO bak18\n" + HOLD_GONE
        env = {"FAKE_LOG_0": HOLD_BAK18, "FAKE_LOG_AFTER_TOUCH": go,
               "FAKE_LOG_AFTER_TOUCH_2": go + "\n2026-11-16T11:10:00.000Z GO bak18-gone",
               # poll, first read, read after the reconcile; the fourth read finds it gone
               "FAKE_COPY_READS_BEFORE_GONE": "3",
               f"FAKE_INSTANCE_{VM}": json.dumps(SOURCE), f"FAKE_INSTANCE_{COPY}": json.dumps(MASKED),
               "FAKE_VOLUME": json.dumps(USED_BY_VM),
               "FAKE_WORKER_LOG": '{"time":"2026-11-16T11:01:00Z","msg":"reconcile cluster done"}'}
        env.update(extra)
        return env

    def test_copy_seen_then_a_reconcile_then_go(self):
        code, out, calls, state = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log", **self.env())
        self.assertEqual(code, 0, out)
        self.assertIn("BAK18_HOST=PASS", out)
        self.assertTrue((state / "pod" / "go-bak18").exists())
        self.assertTrue((state / "pod" / "go-bak18-gone").exists())
        self.assertIn(f"{COPY} gone", out)
        self.assertIn(f"{VOLUME_COPY} gone", out)

    def test_the_volume_copy_is_waited_for_too(self):
        code, out, calls, state = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log",
                                      **self.env(FAKE_VOLUME_COPY_READS="3"))
        self.assertEqual(code, 0, out)
        self.assertEqual((state / "reads-bkv").read_text(), "4")
        self.assertIn(f"/storage-pools/default/volumes/custom/{VOLUME_COPY}?project=t-1", calls)
        self.assertIn("/storage-pools/default/volumes/custom/" + VOL, calls)
        self.assertIn("logs -n ns-control-plane -l app=incus-worker --since-time=", calls)
        log = (state.parent / "bak18.log").read_text()
        # seen, read again after the reconcile, and the read that finds it gone
        self.assertEqual(log.count(f"incus query '/1.0/instances/{COPY}?project=t-1'"), 3)

    def test_the_inventory_pod_is_read_where_the_worker_runs_one(self):
        code, out, calls, _ = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log",
                                  **self.env(FAKE_INVENTORY="incus-worker-inventory-1"))
        self.assertEqual(code, 0, out)
        self.assertIn("-l app=incus-worker-inventory --since-time=", calls)

    def test_an_unmasked_copy_is_a_fail_but_the_spec_still_goes(self):
        code, out, _, state = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log",
                                  **self.env(**{f"FAKE_INSTANCE_{COPY}": json.dumps(UNMASKED)}))
        self.assertEqual(code, 1, out)
        self.assertIn("BAK18_HOST=FAIL", out)
        self.assertTrue((state / "pod" / "go-bak18").exists())

    def test_no_copy_before_the_timeout_skips(self):
        env = self.env()
        del env[f"FAKE_INSTANCE_{COPY}"]
        env["FAKE_LOG_AFTER_TOUCH"] = HOLD_BAK18 + "\n2026-11-16T11:03:00.000Z SKIP bak18\n" + HOLD_GONE
        env["FAKE_LOG_AFTER_TOUCH_2"] = env["FAKE_LOG_AFTER_TOUCH"] + "\n2026-11-16T11:04:00.000Z GO bak18-gone"
        code, out, _, state = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log", "--timeout-minutes", "0", **env)
        self.assertEqual(code, 4, out)
        self.assertIn("BAK18_HOST=NOT_COVERED", out)
        self.assertTrue((state / "pod" / "skip-bak18").exists())
        self.assertTrue((state / "pod" / "go-bak18-gone").exists())

    def test_a_copy_gone_before_the_reconcile_is_not_covered(self):
        skipped = HOLD_BAK18 + "\n2026-11-16T11:03:00.000Z SKIP bak18\n" + HOLD_GONE
        code, out, _, state = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log",
                                  **self.env(FAKE_COPY_READS_BEFORE_GONE="2", FAKE_LOG_AFTER_TOUCH=skipped,
                                             FAKE_LOG_AFTER_TOUCH_2=skipped + "\n2026-11-16T11:04:00.000Z GO bak18-gone"))
        self.assertEqual(code, 4, out)
        self.assertIn("BAK18_HOST=NOT_COVERED", out)
        self.assertTrue((state / "pod" / "skip-bak18").exists())
        self.assertTrue((state / "pod" / "go-bak18-gone").exists())

    def test_a_volume_not_on_the_vm_fails_and_still_answers_both_holds(self):
        detached = {"name": VM, "expanded_devices": {"root": {"type": "disk", "path": "/", "pool": "default"}}}
        code, out, _, state = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log",
                                  **self.env(**{f"FAKE_INSTANCE_{VM}": json.dumps(detached), "FAKE_COPY_READS_BEFORE_GONE": "0"}))
        self.assertEqual(code, 1, out)
        self.assertIn("BAK18_HOST=FAIL", out)
        self.assertTrue((state / "pod" / "go-bak18").exists())
        self.assertTrue((state / "pod" / "go-bak18-gone").exists())

    def test_the_reconcile_wait_ends_with_the_copy_deadline(self):
        skipped = HOLD_BAK18 + "\n2026-11-16T11:03:00.000Z SKIP bak18\n" + HOLD_GONE
        code, out, _, _ = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log", "--timeout-minutes", "0",
                              **self.env(FAKE_WORKER_LOG="", FAKE_LOG_AFTER_TOUCH=skipped,
                                         FAKE_LOG_AFTER_TOUCH_2=skipped + "\n2026-11-16T11:04:00.000Z GO bak18-gone"))
        self.assertEqual(code, 4, out)
        self.assertIn("no 'reconcile cluster done'", out)

    def test_a_metrics_loop_line_is_not_a_reconcile(self):
        # the worker's text log, as on prd: the metrics runner ends its cycle with the same message
        metrics = ('time=2026-11-16T11:01:00.000Z level=INFO msg="reconcile cluster done" worker=w loop=metrics '
                   'clusterId=singapore01 totalMs=171 durationsMs.vm-metrics=171')
        skipped = HOLD_BAK18 + "\n2026-11-16T11:03:00.000Z SKIP bak18\n" + HOLD_GONE
        code, out, _, state = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log", "--timeout-minutes", "0",
                                  **self.env(FAKE_WORKER_LOG=metrics, FAKE_LOG_AFTER_TOUCH=skipped,
                                             FAKE_LOG_AFTER_TOUCH_2=skipped + "\n2026-11-16T11:04:00.000Z GO bak18-gone"))
        self.assertEqual(code, 4, out)
        self.assertIn("no 'reconcile cluster done'", out)
        self.assertTrue((state / "pod" / "skip-bak18").exists())

    def test_the_reconciler_line_after_a_metrics_line_counts(self):
        lines = ('time=2026-11-16T11:01:00.000Z level=INFO msg="reconcile cluster done" worker=w loop=metrics '
                 'clusterId=singapore01 totalMs=171\n'
                 'time=2026-11-16T11:01:01.000Z level=INFO msg="reconcile cluster done" worker=w '
                 'clusterId=singapore01 totalMs=134')
        code, out, _, _ = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log", **self.env(FAKE_WORKER_LOG=lines))
        self.assertEqual(code, 0, out)
        self.assertIn("BAK18_HOST=PASS", out)

    def test_an_unreadable_vm_is_named_as_such(self):
        env = self.env()
        del env[f"FAKE_INSTANCE_{VM}"]
        code, out, _, _ = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log", **env)
        self.assertEqual(code, 1, out)
        self.assertIn(f"BAK18_HOST=FAIL cannot read {VM}", out)

    def test_bak18_refuses_when_the_pending_hold_is_another_step(self):
        code, out, _, _ = run("bak18", *KUBE, *SSH, "--log", "{tmp}/bak18.log", **self.env(FAKE_LOG_0=HOLD_VM28))
        self.assertEqual(code, 2, out)


PW_VM = "vmpwpw"
PASSWORD = "Probe-Pass-123"
# OpenViCloud/titan-control-plane:Titan.Tests/Services/Sha512CryptTests.cs (AKnownPasswordAndSalt_GiveWhatOpensslGives)
HASH = "$6$rgprobesalt$nSxi4dKg3obBTV33X0Wnws7kIi8jT50mu.DpARo.IQtM4NQ/SAJt4uuiOqBLf8QgnyKzhezr5SvghngykEqvO0"
OTHER = "$6$rgprobesalt$V.1tXI3VaN1kXH7WHJ5/N42r4ZReZ26CKNbqXXSfPSHEEP7Qm9l5O5mxvINbD7Sn7yk9cwx8/ciOubCuxKlpm."
HOLD_VM35 = ('2026-11-16T10:05:00.000Z HOLD vm35 '
             + json.dumps({"project": "t-1", "vm": PW_VM, "vmWithout": VM, "passwordFile": "/work/vm-35/password"},
                          separators=(",", ":")))
VENDOR_PW = f"#cloud-boothook\n#!/bin/sh\necho 'ubuntu:{HASH}' | chpasswd -e\n"
VENDOR_KEYS = "#cloud-boothook\n#!/bin/sh\ncat > /etc/ssh/openvicloud/ubuntu <<'KEYS'\nssh-ed25519 AAAAC3fake\nKEYS\n"


class Vm35Test(unittest.TestCase):
    def env(self, guest=None, **extra):
        reads = {
            f"exec {PW_VM} --project t-1 -- cloud-init": [["...\nstatus: done", 0]],
            f"exec {PW_VM} --project t-1 -- getent": [[f"ubuntu:{HASH}:20410:0:99999:7:::", 0]],
            f"exec {PW_VM} --project t-1 -- passwd": [["ubuntu P 2026-11-18 0 99999 7 -1", 0]],
            f"config get {PW_VM} ": [[VENDOR_PW, 0]],
            f"exec {VM} --project t-1 -- getent": [["ubuntu:!:20410:0:99999:7:::", 0]],
            f"exec {VM} --project t-1 -- passwd": [["ubuntu L 2026-11-18 0 99999 7 -1", 0]],
            f"config get {VM} ": [[VENDOR_KEYS, 0]],
        }
        reads.update(guest or {})
        env = {"FAKE_LOG_0": HOLD_VM35, "FAKE_LOG_AFTER_TOUCH": HOLD_VM35 + "\n2026-11-16T10:20:00.000Z GO vm35",
               "FAKE_GUEST": json.dumps(reads), "FAKE_OPENSSL": HASH, "FAKE_POD_PASSWORD": PASSWORD}
        env.update(extra)
        return env

    def vm35(self, **env):
        return run("vm35", *KUBE, *SSH, "--log", "{tmp}/vm35.log", **env)

    def test_a_hash_of_the_password_in_shadow_and_vendor_data_and_a_locked_vm_pass(self):
        code, out, calls, state = self.vm35(**self.env())
        self.assertEqual(code, 0, out)
        self.assertIn("VM35_HOST=PASS", out)
        self.assertTrue((state / "pod" / "go-vm35").exists())
        log = (state.parent / "vm35.log").read_text()
        self.assertRegex(log, r"^# phase4\.py vm35 \(ssh debian@host, ControlMaster\) · debian@host · ")
        for command in (f"sudo incus exec {PW_VM} --project t-1 -- cloud-init status --wait",
                        f"sudo incus exec {PW_VM} --project t-1 -- getent shadow ubuntu",
                        f"sudo incus exec {VM} --project t-1 -- passwd -S ubuntu",
                        f"sudo incus config get {PW_VM} cloud-init.vendor-data --project t-1"):
            self.assertIn("$ " + command + "\n", log)
        self.assertIn("exec -n ns-titan-regression regression-phase4-prd-abc -- sh -c openssl passwd -6 -salt "
                      "\"$1\" -stdin < \"$2\" sh rgprobesalt /work/vm-35/password", calls)
        self.assertIn("exec -i -n ns-titan-regression regression-phase4-prd-abc -- sh -c", calls)

    def test_the_password_is_in_no_argument_no_log_and_no_output(self):
        code, out, calls, state = self.vm35(**self.env())
        self.assertEqual(code, 0, out)
        for text in (out, calls, (state.parent / "vm35.log").read_text()):
            self.assertNotIn(PASSWORD, text)

    def test_cloud_init_is_read_again_until_the_guest_agent_answers_and_logged_once(self):
        guest = {f"exec {PW_VM} --project t-1 -- cloud-init": [
            ["Error: VM agent isn't currently running", 1], ["Error: VM agent isn't currently running", 1],
            ["....\nstatus: done", 0]]}
        code, out, _, state = self.vm35(**self.env(guest))
        self.assertEqual(code, 0, out)
        self.assertEqual((state.parent / "vm35.log").read_text().count("cloud-init status --wait"), 1)

    def test_a_hash_that_is_not_the_passwords_fails_and_still_goes(self):
        code, out, _, state = self.vm35(**self.env(FAKE_OPENSSL=OTHER))
        self.assertEqual(code, 1, out)
        self.assertIn("VM35_HOST=FAIL the hash field of ubuntu is not openssl passwd -6", out)
        self.assertTrue((state / "pod" / "go-vm35").exists())

    def test_the_password_in_vendor_data_fails(self):
        guest = {f"config get {PW_VM} ": [[VENDOR_PW + f"# {PASSWORD}\n", 0]]}
        code, out, _, _ = self.vm35(**self.env(guest))
        self.assertEqual(code, 1, out)
        self.assertIn("cloud-init.vendor-data holds the password (1 lines)", out)
        self.assertNotIn(PASSWORD, out)

    def test_a_locked_or_missing_password_and_an_unlocked_vm_without_one_fail(self):
        guest = {f"exec {PW_VM} --project t-1 -- getent": [["ubuntu:!:20410:0:99999:7:::", 0]],
                 f"exec {PW_VM} --project t-1 -- passwd": [["ubuntu L 2026-11-18 0 99999 7 -1", 0]],
                 f"exec {VM} --project t-1 -- getent": [[f"ubuntu:{OTHER}:20410:0:99999:7:::", 0]]}
        code, out, calls, _ = self.vm35(**self.env(guest))
        self.assertEqual(code, 1, out)
        for problem in ("not a $6$ hash", "passwd -S ubuntu is L, not P",
                        "on the VM without a password starts '$6$', not '!'"):
            self.assertIn(problem, out)
        self.assertNotIn("openssl", calls)

    def test_vendor_data_without_the_hash_fails(self):
        guest = {f"config get {PW_VM} ": [[VENDOR_KEYS, 0]]}
        code, out, _, _ = self.vm35(**self.env(guest))
        self.assertEqual(code, 1, out)
        self.assertIn("cloud-init.vendor-data does not hold the hash of /etc/shadow", out)

    def test_cloud_init_in_error_fails(self):
        guest = {f"exec {PW_VM} --project t-1 -- cloud-init": [["status: error", 1]]}
        code, out, _, _ = self.vm35(**self.env(guest))
        self.assertEqual(code, 1, out)
        self.assertIn("cloud-init status error, not done", out)

    def test_no_status_before_the_timeout_skips(self):
        guest = {f"exec {PW_VM} --project t-1 -- cloud-init": [["Error: VM agent isn't currently running", 1]]}
        code, out, _, state = run("vm35", *KUBE, *SSH, "--log", "{tmp}/vm35.log", "--timeout-minutes", "0",
                                  **self.env(guest, FAKE_LOG_AFTER_TOUCH=HOLD_VM35 + "\n2026-11-16T10:20:00.000Z SKIP vm35"))
        self.assertEqual(code, 4, out)
        self.assertIn("VM35_HOST=NOT_COVERED no 'status:'", out)
        self.assertTrue((state / "pod" / "skip-vm35").exists())

    def test_no_openssl_in_the_pod_skips(self):
        env = self.env(FAKE_LOG_AFTER_TOUCH=HOLD_VM35 + "\n2026-11-16T10:20:00.000Z SKIP vm35")
        del env["FAKE_OPENSSL"]
        code, out, _, state = self.vm35(**env)
        self.assertEqual(code, 4, out)
        self.assertIn("VM35_HOST=NOT_COVERED openssl passwd in the pod: exit 127", out)
        self.assertTrue((state / "pod" / "skip-vm35").exists())

    def test_vm35_refuses_another_pending_step_or_facts_out_of_shape(self):
        code, out, _, _ = self.vm35(**self.env(FAKE_LOG_0=HOLD_VM28))
        self.assertEqual(code, 2, out)
        outside = HOLD_VM35.replace("/work/vm-35/password", "/etc/shadow")
        code, out, calls, _ = self.vm35(**self.env(FAKE_LOG_0=outside))
        self.assertEqual(code, 2, out)
        self.assertNotIn("incus exec", calls)

    def test_the_shadow_field_and_the_passwd_state_are_read_from_the_ubuntu_line(self):
        self.assertEqual(phase4.shadow_hash("root:*:1::::::\nubuntu:!:20410:0:99999:7:::\n"), "!")
        self.assertIsNone(phase4.shadow_hash("Error: VM agent isn't currently running"))
        self.assertEqual(phase4.passwd_state("ubuntu P 2026-11-18 0 99999 7 -1"), "P")
        self.assertIsNone(phase4.passwd_state(""))


class ConnectTest(unittest.TestCase):
    def test_connect_opens_a_master_that_checks_the_pinned_host_key(self):
        code, out, calls, state = run("connect", *SSH, "--known-hosts", "{tmp}/known_hosts")
        self.assertEqual(code, 0, out)
        self.assertIn(f"ssh -M -N -f -S {state.parent}/ctl -o ControlPersist=4h -o StrictHostKeyChecking=yes "
                      f"-o UserKnownHostsFile={state.parent}/known_hosts -o BatchMode=yes debian@host", calls)

    def test_connect_reads_an_ssh_config_when_given(self):
        code, out, calls, _ = run("connect", "--control", "{tmp}/ctl", "--target", "lima-titan-incus",
                                  "--known-hosts", "{tmp}/kh", "--ssh-config", "{tmp}/ssh.config")
        self.assertEqual(code, 0, out)
        self.assertRegex(calls, r"ssh -F \S+/ssh.config -M -N -f -S ")

    def test_disconnect_closes_the_master(self):
        code, out, calls, state = run("disconnect", *SSH)
        self.assertEqual(code, 0, out)
        self.assertIn(f"ssh -S {state.parent}/ctl -O exit debian@host", calls)


P = "?project=t-1"
SAMPLE_QUERIES = {
    f"/1.0/instances?recursion=1&project=t-1": [
        {"name": COPY, "status": "Stopped", "type": "virtual-machine", "config": {"user.titan-name": "rg-vm-x"},
         "expanded_devices": {"root": {"type": "disk", "path": "/"}, "eth0": {"type": "nic", "network": "net-1"},
                              VOL: {"type": "none"}}}],
    "/1.0/networks?recursion=1&project=t-1": [
        {"name": "net-1", "managed": True, "type": "ovn", "config": {"ipv4.address": "10.77.0.1/24"}, "used_by": ["a"]}],
    "/1.0/network-acls?recursion=1&project=t-1": [],
    "/1.0/storage-pools/default/volumes/custom?recursion=1&project=t-1": [
        {"name": VOL, "config": {"size": "10GiB"}, "used_by": [f"/1.0/instances/{VM}{P}"]}],
    f"/1.0/storage-pools/default/volumes/custom/{VOL}/snapshots{P}": [],
    "/1.0/networks?recursion=0&project=t-1": ["/1.0/networks/net-1?project=t-1"],
    "/1.0/networks/net-1/load-balancers?recursion=1&project=t-1": [],
    "/1.0/images/aliases?recursion=1": [],
}


class SampleTest(unittest.TestCase):
    def test_one_sample_prints_a_line_per_object_through_the_socket(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        (tmp / "stop").write_text("")
        code, out, calls, state = run("sample", *SSH, "--project", "t-1", "--every", "0", "--stop", str(tmp / "stop"),
                                      "--log", "{tmp}/sampler.log", FAKE_QUERIES=json.dumps(SAMPLE_QUERIES))
        self.assertEqual(code, 0, out)
        log = (state.parent / "sampler.log").read_text()
        self.assertRegex(log, r"^# phase4.py sample \(ssh debian@host, ControlMaster, project t-1, lane sequential\) · debian@host · ")
        self.assertRegex(log, rf"\dZ instance {COPY} status=Stopped type=virtual-machine titan-name=rg-vm-x .*"
                              rf"nics=\{{'eth0': 'net-1'\}} disks=\{{\}} none=\['{VOL}'\]")
        self.assertRegex(log, rf"\dZ volume {VOL} size=10GiB used_by=\['/1.0/instances/{VM}\?project=t-1'\] snapshots=\[\]")
        self.assertIn("network net-1 type=ovn", log)
        self.assertRegex(log, r"sample objects=3\n$")
        self.assertIn("-S " + str(state.parent / "ctl"), calls)

    def test_changes_only_and_gone_objects(self):
        before = {"instance a": "x", "network n": "same", "volume v": "y"}
        after = {"instance a": "x2", "network n": "same"}
        self.assertEqual(phase4.changes(before, after), ["instance a x2", "GONE volume v"])

    def test_it_samples_until_the_stop_file_is_there(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        # 8 reads make one sample; the stop file appears during the second
        code, out, _, state = run("sample", *SSH, "--project", "t-1", "--every", "0", "--stop", str(tmp / "stop"),
                                  "--log", "{tmp}/sampler.log", FAKE_QUERIES=json.dumps(SAMPLE_QUERIES),
                                  FAKE_STOP_AFTER="9", FAKE_STOP_FILE=str(tmp / "stop"))
        self.assertEqual(code, 0, out)
        log = (state.parent / "sampler.log").read_text()
        self.assertEqual(log.count("sample objects=3"), 2)
        self.assertEqual(log.count(f"instance {COPY} "), 1)

    def test_a_read_that_hangs_is_an_error_line(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        (tmp / "stop").write_text("")
        code, out, _, state = run("sample", *SSH, "--project", "t-1", "--every", "0", "--stop", str(tmp / "stop"),
                                  "--log", "{tmp}/sampler.log", "--read-timeout", "1",
                                  FAKE_QUERIES=json.dumps(SAMPLE_QUERIES), FAKE_HANG="network-acls")
        self.assertEqual(code, 0, out)
        log = (state.parent / "sampler.log").read_text()
        self.assertIn("ERROR acls: no answer in 1", log)
        self.assertIn(f"volume {VOL}", log)

    def test_a_sample_that_breaks_is_an_error_line_and_the_last_objects_stay(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        queries = dict(SAMPLE_QUERIES)
        queries["/1.0/network-acls?recursion=1&project=t-1"] = [{"no": "name"}]
        code, out, _, state = run("sample", *SSH, "--project", "t-1", "--every", "0", "--stop", str(tmp / "stop"),
                                  "--log", "{tmp}/sampler.log", FAKE_QUERIES=json.dumps(queries),
                                  FAKE_STOP_AFTER="1", FAKE_STOP_FILE=str(tmp / "stop"))
        self.assertEqual(code, 0, out)
        log = (state.parent / "sampler.log").read_text()
        self.assertIn("ERROR sample failed: KeyError", log)
        self.assertNotIn("GONE", log)

    def test_a_failed_read_is_an_error_line_and_the_sample_goes_on(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        (tmp / "stop").write_text("")
        queries = dict(SAMPLE_QUERIES)
        del queries["/1.0/network-acls?recursion=1&project=t-1"]
        code, out, _, state = run("sample", *SSH, "--project", "t-1", "--every", "0", "--stop", str(tmp / "stop"),
                                  "--log", "{tmp}/sampler.log", "--lane", "b", FAKE_QUERIES=json.dumps(queries))
        self.assertEqual(code, 0, out)
        log = (state.parent / "sampler.log").read_text()
        self.assertIn("ERROR acls:", log)
        self.assertIn(", lane b) · debian@host · ", log.splitlines()[0])
        self.assertIn(f"volume {VOL}", log)


if __name__ == "__main__":
    unittest.main()
