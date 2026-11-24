#!/usr/bin/env python3
"""Tests of phase4.py against a fake kubectl, ssh and ssh-keygen and a sleep that returns at once. Run: python3 test_phase4.py"""
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("phase4", HERE / "phase4.py")
phase4 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(phase4)

# The fakes write each call to FAKE_STATE/calls. kubectl: `logs <pod>` prints FAKE_LOG_<n> (n = how many `logs` calls
# came before, the last one repeats); `exec … touch <file>` creates the file under
# FAKE_STATE/pod, after which `logs <pod>` prints FAKE_LOG_AFTER_TOUCH_<files touched> or FAKE_LOG_AFTER_TOUCH when set. ssh: a command holding `incus query '<path>'`
# that is a key of FAKE_QUERIES prints its JSON value (FAKE_STOP_AFTER/FAKE_STOP_FILE touch a file after that many such reads).
# FAKE_GUEST {substring: [[output, exit], …]}: a host command holding the substring gets its next pair (the last repeats).
# kubectl `exec … psql` prints the next [output, exit] pair of FAKE_PSQL (the last repeats); when FAKE_PSQL is an object,
# the pairs of its first key the SQL holds, each key with its own count. `create job`/`delete job` exit
# FAKE_JOB_EXIT; `get job <name>` prints the status of FAKE_JOB_STATUS whose key the name holds (none: one pod succeeded),
# `logs job/<name>` a curl error; `get cronjob` adds the names of FAKE_CRONJOBS, `get cronjob <name>` prints the next
# `.status.active` of FAKE_CRONJOB_ACTIVE (unset: none); `get pods -l <the titan-db primary>` is titan-db-1.
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
    if args[:2] == ["get", "cronjob"] and len(args) > 2 and not args[2].startswith("-"):
        counter = state / "cronjob-reads"
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        active = json.loads(os.environ.get("FAKE_CRONJOB_ACTIVE", "[[]]"))
        print(json.dumps({"status": {"active": active[min(n, len(active) - 1)]}}))
    elif args[:2] == ["get", "cronjob"]:
        items("titan-regression", *json.loads(os.environ.get("FAKE_CRONJOBS", "[]")))
    elif args[:2] == ["get", "pods"] and "cnpg.io/cluster=titan-db,cnpg.io/instanceRole=primary" in args:
        items("titan-db-1")
    elif args[:2] == ["get", "pods"]:
        counter = state / "pod-reads"
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        items(*(["regression-phase4-prd-abc"] if n >= int(os.environ.get("FAKE_POD_AFTER", "0")) else []))
    elif args[:1] == ["logs"] and args[1].startswith("job/"):
        print("curl: (22) The requested URL returned error: 500")
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
    elif args[:1] == ["exec"] and "psql" in args:
        counter = state / "psql-reads"
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        reads = json.loads(os.environ["FAKE_PSQL"])
        if isinstance(reads, dict):
            key = next(k for k in reads if k in args[-1])
            counter = state / ("psql-reads-" + str(sorted(reads).index(key)))
            n = int(counter.read_text()) if counter.exists() else 0
            counter.write_text(str(n + 1))
            reads = reads[key]
        output, code = reads[min(n, len(reads) - 1)]
        print(output)
        sys.exit(code)
    elif args[:2] in (["create", "job"], ["delete", "job"]):
        sys.exit(int(os.environ.get("FAKE_JOB_EXIT", "0")))
    elif args[:2] == ["get", "job"]:
        statuses = json.loads(os.environ.get("FAKE_JOB_STATUS", "{}"))
        print(json.dumps({"status": next((v for k, v in statuses.items() if k in args[2]), {"succeeded": 1})}))
    elif args[:1] == ["cp"]:
        pathlib.Path(args[2]).write_text(os.environ.get("FAKE_CP_" + pathlib.Path(args[1]).name, ""))
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
    if any(k in command for k in json.loads(os.environ.get("FAKE_GUEST", "{}"))):
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


SETUP_FACTS = {"project": "t-1", "vmA": "vma", "vmB": "vmb", "volume": "vol1", "net6": "net-6", "netEmpty": "net-e",
               "acl": "acl-6", "vip": "2001:db8::1:1", "ipv6A": "2001:db8::a"}


def hold_line(step, facts, at="10:00:00"):
    return f"2026-11-19T{at}.000Z HOLD {step} " + json.dumps(facts, separators=(",", ":"))


class StepTableTest(unittest.TestCase):
    def test_every_hold_of_phase4_host_but_vm35_has_its_commands(self):
        spec = (HERE / "phase4" / "phase4-host.spec.ts").read_text()
        holds = set(re.findall(r"hold\('([a-z0-9-]+)'", spec))
        self.assertIn("setup", holds)
        self.assertEqual(holds - {"vm35"} - set(phase4.phase4_steps.STEPS), set())
        self.assertIn("cln02", phase4.phase4_steps.STEPS)

    def test_every_step_renders_from_its_holds_facts_and_setups(self):
        spec = (HERE / "phase4" / "phase4-host.spec.ts").read_text()
        facts = {**SETUP_FACTS, "vm": "vmx", "vmSnapshot": "s1", "network": "net-x", "outside": [], "host": [],
                 "alias": "tpl-1", "snapshot": "s2", "ruleId": "r1", "direction": "ingress", "obs05Target": "fp1",
                 "env": "release", "api": "https://api", "keys": "/k", "guestKnownHosts": "/kh"}
        for step, commands in phase4.phase4_steps.STEPS.items():
            for cmd in commands(facts, facts):
                with self.subTest(step=step, command=cmd.text):
                    phase4.phase4_steps.render(cmd.text, facts)
        self.assertTrue(spec)

    def test_an_unknown_name_is_an_error_and_key_tokens_stay(self):
        self.assertEqual(phase4.phase4_steps.render("grep {V} {vm}", {"vm": "vm1"}), "grep {V} vm1")
        with self.assertRaises(KeyError):
            phase4.phase4_steps.render("incus stop {vm}", {})


class StepTest(unittest.TestCase):
    def go_log(self, step):
        return {"FAKE_LOG_AFTER_TOUCH": f"2026-11-19T10:00:30.000Z GO {step}"}

    def test_setup_runs_its_reads_keeps_its_facts_and_answers_go(self):
        code, out, calls, state = run("step", "setup", *KUBE, *SSH, "--log", "{tmp}/setup.log", "--state", "{tmp}/phase4-state.json", "--api", "https://api.x",
                                      FAKE_LOG_0=hold_line("setup", SETUP_FACTS), **self.go_log("setup"))
        self.assertEqual(code, 0, out)
        self.assertIn("sudo incus network acl show acl-6 --project t-1", calls)
        self.assertIn("sudo incus exec --project t-1 vma -- sh -c 'wc -l < /home/ubuntu/.ssh/authorized_keys; uptime -s'", calls)
        self.assertNotIn("curl", calls)  # outside on the release environment: this machine, not the host
        log = (state.parent / "setup.log").read_text()
        self.assertIn("$ (this machine) curl -s https://api.x/v1/os-images", log)
        self.assertEqual(json.loads((state.parent / "phase4-state.json").read_text())["setup"]["vmA"], "vma")
        self.assertNotIn("phase4-state", " ".join(p.name for p in (state.parent).glob("*.log")))
        self.assertTrue((state / "pod" / "go-setup").exists())

    def test_a_later_step_takes_the_project_from_setups_facts(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        (tmp / "phase4-state.json").write_text(json.dumps({"setup": SETUP_FACTS, "recorded": {}}))
        code, out, calls, state = run("step", "obs01", *KUBE, *SSH, "--log", str(tmp / "w.log"), "--state", str(tmp / "phase4-state.json"),
                                      FAKE_LOG_0=hold_line("obs01", {"vm": "vmc"}), **self.go_log("obs01"))
        self.assertEqual(code, 0, out)
        self.assertIn("sudo incus stop --project t-1 vmc", calls)
        self.assertTrue((state / "pod" / "go-obs01").exists())

    def test_another_pending_step_runs_nothing(self):
        code, out, calls, state = run("step", "obs01", *KUBE, *SSH, "--log", "{tmp}/w.log", "--state", "{tmp}/phase4-state.json",
                                      FAKE_LOG_0=hold_line("obs02", {"vm": "vmc", "project": "t-1"}))
        self.assertEqual(code, 2, out)
        self.assertIn("the pending HOLD is obs02, not obs01", out)
        self.assertNotIn("incus", calls)
        self.assertFalse((state / "pod").exists())

    def test_no_go_leaves_the_answer(self):
        code, out, calls, state = run("step", "net25", *KUBE, *SSH, "--log", "{tmp}/r.log", "--state", "{tmp}/phase4-state.json", "--no-go",
                                      FAKE_LOG_0=hold_line("net25", {"network": "net-d", "project": "t-1"}))
        self.assertEqual(code, 0, out)
        self.assertIn("sudo incus network show net-d --project t-1", calls)
        self.assertFalse((state / "pod").exists())

    def test_no_master_stops_before_the_answer(self):
        code, out, calls, state = run("step", "obs01", *KUBE, *SSH, "--log", "{tmp}/w.log", "--state", "{tmp}/phase4-state.json", FAKE_NO_MASTER="1",
                                      FAKE_LOG_0=hold_line("obs01", {"vm": "vmc", "project": "t-1"}))
        self.assertEqual(code, 2, out)
        self.assertFalse((state / "pod").exists())

    def test_vm24_restart_reads_again_until_the_guest_answers_with_a_new_boot(self):
        keys = pathlib.Path(tempfile.mkdtemp())
        for k in "vux":
            (keys / f"{k}.pub").write_text(f"ssh-ed25519 AAAAC3{k}body rg-p4-{k}\n")
        guest = {"uptime -s": [["1\n2026-11-19 09:00:00", 0], ["", 255], ["1\n2026-11-19 09:00:00", 0],
                               ["1\n2026-11-19 10:05:00", 0]]}
        code, out, calls, state = run("step", "vm24-restart", *KUBE, *SSH, "--log", "{tmp}/w.log", "--state", "{tmp}/phase4-state.json", "--keys", str(keys),
                                      FAKE_LOG_0=hold_line("vm24-restart", {"vm": "vma", "project": "t-1"}),
                                      FAKE_GUEST=json.dumps(guest), **self.go_log("vm24-restart"))
        self.assertEqual(code, 0, out)
        self.assertEqual(calls.count("uptime -s"), 4)
        self.assertLess(calls.index("sudo incus restart --project t-1 vma"), calls.rindex("uptime -s"))
        self.assertIn("grep -c 'AAAAC3xbody' /home/ubuntu/.ssh/authorized_keys", calls)
        self.assertIn("grep -c AAAAC3vbody /etc/ssh/openvicloud/ubuntu", calls)

    def test_obs05_after_sync_deletes_the_recorded_image_only_when_the_alias_moved(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        state_file = tmp / "phase4-state.json"
        state_file.write_text(json.dumps({"setup": SETUP_FACTS, "recorded": {}}))
        target = "images/aliases/tpl-1"
        code, out, calls, _ = run("step", "obs05", *KUBE, *SSH, "--log", str(tmp / "w.log"), "--state", str(tmp / "phase4-state.json"),
                                  FAKE_LOG_0=hold_line("obs05", {"alias": "tpl-1"}), FAKE_GUEST=json.dumps({target: [["fpold", 0]]}),
                                  **self.go_log("obs05"))
        self.assertEqual(code, 0, out)
        self.assertIn("sudo incus image alias delete tpl-1", calls)
        self.assertEqual(json.loads(state_file.read_text())["recorded"]["obs05Target"], "fpold")
        for now, deleted in (("fpold", False), ("fpnew", True)):
            code, out, calls, _ = run("step", "obs05-after-sync", *KUBE, *SSH, "--log", str(tmp / "w.log"), "--state", str(tmp / "phase4-state.json"),
                                      FAKE_LOG_0=hold_line("obs05-after-sync", {"alias": "tpl-1"}),
                                      FAKE_GUEST=json.dumps({target: [[now, 0]]}), **self.go_log("obs05-after-sync"))
            with self.subTest(now=now):
                self.assertEqual(code, 0, out)
                self.assertEqual("image delete --project default fpold" in calls, deleted)
        self.assertIn("skipped: the alias still points at the image recorded at obs05", (tmp / "w.log").read_text())

    def test_fw08_runs_the_facts_commands_outside_here_and_on_the_host_with_sudo(self):
        facts = {"project": "t-1", "uplink": "ovnup", "devPrecondition": "dev only", "outside": ["echo out-1"],
                 "host": ["incus exec vmb --project t-1 -- tail -n 8 /var/log/rg-out.log"]}
        code, out, calls, state = run("step", "fw08-before", *KUBE, *SSH, "--log", "{tmp}/v6.log", "--state", "{tmp}/phase4-state.json",
                                      FAKE_LOG_0=hold_line("fw08-before", facts), **self.go_log("fw08-before"))
        self.assertEqual(code, 0, out)
        self.assertIn("sudo incus network get ovnup ipv6.gateway", calls)
        self.assertIn("sudo incus exec vmb --project t-1 -- tail -n 8 /var/log/rg-out.log", calls)
        self.assertNotIn("ovnbr", calls)
        self.assertNotIn("echo out-1", calls)
        self.assertRegex((state.parent / "v6.log").read_text(), r"\$ \(this machine\) echo out-1\nout-1\nexit=0")
        code, out, calls, _ = run("step", "fw08-before", *KUBE, *SSH, "--log", "{tmp}/v6.log", "--state", "{tmp}/phase4-state.json", "--env", "dev",
                                  FAKE_LOG_0=hold_line("fw08-before", facts), **self.go_log("fw08-before"))
        self.assertIn("ip -6 addr show ovnbr", calls)
        self.assertIn("echo out-1", calls)  # dev: from outside the cluster is the host

    def test_a_missing_option_runs_nothing(self):
        code, out, calls, state = run("step", "setup", *KUBE, *SSH, "--log", "{tmp}/setup.log", "--state", "{tmp}/phase4-state.json",
                                      FAKE_LOG_0=hold_line("setup", SETUP_FACTS), **self.go_log("setup"))
        self.assertEqual(code, 2, out)
        self.assertIn("step setup needs api", out)
        self.assertNotIn("incus", calls)
        self.assertFalse((state / "pod").exists())

    def test_setup_clears_values_an_earlier_run_recorded_and_a_failed_read_records_none(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        state_file = tmp / "phase4-state.json"
        state_file.write_text(json.dumps({"setup": {}, "recorded": {"obs05Target": "fpold"}}))
        run("step", "setup", *KUBE, *SSH, "--log", str(tmp / "s.log"), "--state", str(tmp / "phase4-state.json"), "--api", "https://api.x",
            FAKE_LOG_0=hold_line("setup", SETUP_FACTS), **self.go_log("setup"))
        self.assertEqual(json.loads(state_file.read_text())["recorded"], {})
        run("step", "obs05", *KUBE, *SSH, "--log", str(tmp / "w.log"), "--state", str(tmp / "phase4-state.json"), FAKE_LOG_0=hold_line("obs05", {"alias": "tpl-1"}),
            FAKE_GUEST=json.dumps({"images/aliases/tpl-1": [["Error: not found", 1]]}), **self.go_log("obs05"))
        self.assertEqual(json.loads(state_file.read_text())["recorded"], {"obs05Target": None})
        _, _, calls, _ = run("step", "obs05-after-sync", *KUBE, *SSH, "--log", str(tmp / "w.log"), "--state", str(tmp / "phase4-state.json"),
                             FAKE_LOG_0=hold_line("obs05-after-sync", {"alias": "tpl-1"}),
                             FAKE_GUEST=json.dumps({"images/aliases/tpl-1": [["fpnew", 0]]}), **self.go_log("obs05-after-sync"))
        self.assertNotIn("image delete", calls)

    def test_a_failed_write_stops_the_step_without_an_answer(self):
        code, out, calls, state = run("step", "obs01", *KUBE, *SSH, "--log", "{tmp}/w.log", "--state",
                                      "{tmp}/phase4-state.json", FAKE_EXIT="1",
                                      FAKE_LOG_0=hold_line("obs01", {"vm": "vmc", "project": "t-1"}), **self.go_log("obs01"))
        self.assertEqual(code, 1, out)
        self.assertIn("a write of step obs01 failed (exit 1)", out)
        self.assertFalse((state / "pod").exists())

    def test_obs11_answers_go_when_the_rule_is_gone(self):
        guest = {"grep -c r1": [["0", 1]]}
        facts = {"acl": "acl-6", "ruleId": "r1", "direction": "ingress", "project": "t-1"}
        code, out, calls, state = run("step", "obs11", *KUBE, *SSH, "--log", "{tmp}/w.log", "--state",
                                      "{tmp}/phase4-state.json", FAKE_LOG_0=hold_line("obs11", facts),
                                      FAKE_GUEST=json.dumps(guest), **self.go_log("obs11"))
        self.assertEqual(code, 0, out)
        self.assertIn("sudo incus network acl rule remove acl-6 ingress description=r1 --project t-1", calls)
        self.assertTrue((state / "pod" / "go-obs11").exists())

    def test_a_step_reading_the_keys_runs_nothing_without_keys(self):
        code, out, calls, state = run("step", "vm24-restart", *KUBE, *SSH, "--log", "{tmp}/w.log", "--state",
                                      "{tmp}/phase4-state.json",
                                      FAKE_LOG_0=hold_line("vm24-restart", {"vm": "vma", "project": "t-1"}))
        self.assertEqual(code, 2, out)
        self.assertIn("needs --keys", out)
        self.assertNotIn("incus", calls)

    def test_writes_lists_the_steps_with_a_host_write(self):
        self.assertEqual(len(phase4.phase4_steps.WRITES), 18)
        self.assertNotIn("net25", phase4.phase4_steps.WRITES)
        self.assertIn("obs11", phase4.phase4_steps.WRITES)

    def test_cln02_needs_no_hold(self):
        code, out, calls, state = run("step", "cln02", *SSH, "--log", "{tmp}/cln.log", "--state", "{tmp}/phase4-state.json", "--project", "t-9")
        self.assertEqual(code, 0, out)
        self.assertNotIn("kubectl", calls)
        self.assertIn("project=t-9", calls)


class Cli10Test(unittest.TestCase):
    FAKE_CLI = textwrap.dedent('''\
        #!/usr/bin/env python3
        import os, pathlib, sys
        state = pathlib.Path(os.environ["FAKE_STATE"])
        with open(state / "calls", "a") as calls:
            calls.write("cli " + " ".join(sys.argv[1:]) + " token-set=" + str(bool(os.environ.get("OPENVICLOUD_TOKEN"))) + "\\n")
        (state / "cli-env").write_text(os.environ.get("OPENVICLOUD_API_URL", "") + " " + os.environ.get("XDG_CONFIG_HOME", ""))
        print(os.environ.get("FAKE_CLI_OUT", "alive"))
        sys.exit(int(os.environ.get("FAKE_CLI_EXIT", "0")))
    ''')
    FACTS = {"vmName": "rg-vmedge-1", "vmId": "id-1", "token": "/work/cli-10/token", "key": "/work/cli-10/key",
             "command": "vm ssh <vmName> -- …"}

    def cli(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        (tmp / "openvicloud").write_text(self.FAKE_CLI)
        (tmp / "openvicloud").chmod(0o755)
        return str(tmp / "openvicloud")

    def run_cli10(self, **env):
        return run("cli10", "--kubeconfig", "kc", "--job", "regression-edge-p1", "--cli", self.cli(), "--api",
                   "https://api.x", "--log", "{tmp}/cli10.log", "--seconds", "0",
                   **{"FAKE_LOG_0": hold_line("cli10", self.FACTS), "FAKE_LOG_AFTER_TOUCH": "2026-11-19T10:06:00.000Z GO cli10",
                      "FAKE_CP_token": "sekret-token-123", "FAKE_CP_key": "-----BEGIN OPENSSH PRIVATE KEY-----", **env})

    def test_the_session_runs_here_with_the_token_in_the_environment_only_then_go(self):
        code, out, calls, state = self.run_cli10()
        self.assertEqual(code, 0, out)
        self.assertIn("L_CLI10=PASS", out)
        self.assertIn("cli vm ssh rg-vmedge-1 -- -i ", calls)
        self.assertIn("token-set=True", calls)
        self.assertTrue((state / "pod" / "go-cli10").exists())
        log = (state.parent / "cli10.log").read_text()
        for text in (out, calls, log):
            self.assertNotIn("sekret-token-123", text)
        self.assertTrue(log.rstrip().endswith("L_CLI10=PASS"))
        self.assertTrue((state / "cli-env").read_text().startswith("https://api.x "))

    def test_a_token_that_cannot_be_copied_out_is_not_covered_and_skips(self):
        code, out, calls, state = self.run_cli10(FAKE_CP_token="")
        self.assertEqual(code, 4, out)
        self.assertIn("L_CLI10=NOT_COVERED could not copy /work/cli-10/token out of the pod", out)
        self.assertNotIn("cli vm ssh", calls)
        self.assertTrue((state / "pod" / "skip-cli10").exists())

    def test_a_session_that_did_not_end_alive_fails_and_still_goes(self):
        code, out, _, state = self.run_cli10(FAKE_CLI_EXIT="255", FAKE_CLI_OUT="Connection closed")
        self.assertEqual(code, 1, out)
        self.assertIn("L_CLI10=FAIL exit=255 alive=False", out)
        self.assertTrue((state / "pod" / "go-cli10").exists())


class Bak20Test(unittest.TestCase):
    VM_ID = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
    KEY = f"vm-backup-{VM_ID}-20261120"
    FACTS = {"vmId": VM_ID, "vmName": "rg-bak20-1", "backupKey": KEY}
    SNAP = "vm-snapshot-create-s1-r1"

    def rows(self, backup=None, attempts=0, snap=None, snap_attempts=0):
        lines = [f"vm.create|vm-create-{self.VM_ID}-r0|Done|1"]
        if backup:
            lines.append(f"vm.backup|{self.KEY}|{backup}|{attempts}")
        if snap:
            lines.append(f"vm-snapshot.create|{self.SNAP}|{snap}|{snap_attempts}")
        return ["\n".join(lines), 0]

    def run_bak20(self, reads, facts=None, **env):
        return run("bak20", "--kubeconfig", "kc", "--job", "regression-command-wait-p1", "--log", "{tmp}/bak20.log",
                   "--every", "0", "--leased-minutes", "0.05",
                   **{"FAKE_LOG_0": hold_line("bak20", facts or self.FACTS),
                      "FAKE_LOG_AFTER_TOUCH": "2026-11-20T10:06:00.000Z GO bak20",
                      "FAKE_CRONJOBS": json.dumps(["control-plane-job-backup-schedule"]),
                      "FAKE_PSQL": json.dumps(reads), **env})

    def test_the_job_makes_the_backup_leased_then_go_and_the_snapshot_waits_pending_until_both_are_done(self):
        reads = [self.rows(), self.rows("Pending"), self.rows("Leased", 1), self.rows("Leased", 1),
                 self.rows("Leased", 1, "Pending"), self.rows("Leased", 1, "Pending"), self.rows("Done", 1, "Pending"),
                 self.rows("Done", 1, "Leased", 1), self.rows("Done", 1, "Done", 1)]
        code, out, calls, state = self.run_bak20(reads)
        self.assertEqual(code, 0, out)
        self.assertIn("L_BAK20=PASS readings=2", out)
        self.assertTrue((state / "pod" / "go-bak20").exists())
        self.assertRegex(calls, r"create job rg-bak20-\d+ --from=cronjob/control-plane-job-backup-schedule -n ns-control-plane-job-backup-schedule")
        self.assertIn("exec -n ns-titan-db-1 titan-db-1 -c postgres -- psql -U postgres -d titan -At -F | -c SELECT", calls)
        self.assertIn(f"WHERE resource_id = '{self.VM_ID}'", calls)
        self.assertRegex(calls, r"delete job rg-bak20-\d+ -n ns-control-plane-job-backup-schedule")
        log = (state.parent / "bak20.log").read_text()
        self.assertTrue(log.rstrip().endswith("L_BAK20=PASS readings=2 with the snapshot's row Pending attempts=0 while the backup was Leased"))
        # a read is logged only when it changed: of the four reads with the backup Leased, two
        self.assertEqual(log.count(f"vm.backup|{self.KEY}|Leased|1\n"), 2)

    def test_a_backup_already_queued_by_the_hourly_pass_needs_no_job(self):
        reads = [self.rows("Leased", 1), self.rows("Leased", 1, "Pending"), self.rows("Done", 1, "Done", 1)]
        code, out, calls, _ = self.run_bak20(reads)
        self.assertEqual(code, 0, out)
        self.assertNotIn("create job", calls)
        self.assertNotIn("delete job", calls)

    def test_a_snapshot_row_leased_while_the_backup_is_fails(self):
        reads = [self.rows("Leased", 1), self.rows("Leased", 1, "Leased", 1), self.rows("Done", 1, "Done", 1)]
        code, out, _, _ = self.run_bak20(reads)
        self.assertEqual(code, 1, out)
        self.assertIn(f"L_BAK20=FAIL {self.SNAP} Leased attempts=1 while the backup was Leased", out)

    def test_a_pending_snapshot_row_with_attempts_fails(self):
        reads = [self.rows("Leased", 1), self.rows("Leased", 1, "Pending", 2), self.rows("Done", 1, "Done", 3)]
        code, out, _, _ = self.run_bak20(reads)
        self.assertEqual(code, 1, out)
        self.assertIn("Pending attempts=2", out)

    def test_todays_backup_already_done_is_not_covered_and_skips(self):
        code, out, calls, state = self.run_bak20([self.rows("Done", 1)])
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK20=NOT_COVERED today's backup of the VM is already Done", out)
        self.assertTrue((state / "pod" / "skip-bak20").exists())
        self.assertNotIn("create job", calls)

    def test_a_backup_never_leased_in_time_is_not_covered_and_skips_and_the_job_is_deleted(self):
        code, out, calls, state = self.run_bak20([self.rows(), self.rows("Pending")])
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK20=NOT_COVERED the backup was not Leased in 0.05 minutes (Pending)", out)
        self.assertTrue((state / "pod" / "skip-bak20").exists())
        self.assertIn("delete job rg-bak20-", calls)

    def test_a_backup_that_ended_before_the_snapshot_row_was_read_is_not_covered_after_go(self):
        reads = [self.rows("Leased", 1), self.rows("Done", 1), self.rows("Done", 1, "Done", 1)]
        code, out, _, state = self.run_bak20(reads)
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK20=NOT_COVERED no read had the snapshot's row while the backup was Leased", out)
        self.assertTrue((state / "pod" / "go-bak20").exists())

    def test_a_job_that_cannot_be_created_is_not_covered(self):
        code, out, _, state = self.run_bak20([self.rows()], FAKE_JOB_EXIT="1")
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK20=NOT_COVERED could not create a Job", out)
        self.assertTrue((state / "pod" / "skip-bak20").exists())

    def test_facts_out_of_shape_run_no_sql(self):
        code, out, calls, _ = self.run_bak20([self.rows()], facts={"vmId": "x'; drop table t; --", "backupKey": "k"})
        self.assertEqual(code, 2, out)
        self.assertNotIn("psql", calls)

    def test_the_verdict_reads_the_last_rows_for_the_ends(self):
        key = self.KEY
        leased = [("vm.backup", key, "Leased", 1), ("vm-snapshot.create", "s", "Pending", 0)]
        self.assertEqual(phase4.bak20_verdict([leased, [("vm.backup", key, "Failed", 5)]], key)[0], "FAIL")
        self.assertIn("ended Failed", phase4.bak20_verdict([leased, [("vm.backup", key, "Done", 1), ("vm-snapshot.create", "s", "Failed", 5)]], key)[1])
        self.assertIn("did not land", phase4.bak20_verdict([[("vm.backup", key, "Done", 1)]], key)[1])
        self.assertEqual(phase4.command_rows("a|b|Pending|0\nnoise\n(0 rows)"), [("a", "b", "Pending", 0)])


class Bak22Test(unittest.TestCase):
    VM_ID = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
    DAY = "20261124"
    KEY = f"vm-backup-{VM_ID}-{DAY}"
    FIRST = f"cluster-backup-local-{DAY}"
    AGAIN = f"cluster-backup-local-{DAY}10"
    FACTS = {"vmId": VM_ID, "vmName": "rg-bak22-1", "clusterId": "local", "backupKey": KEY,
             "vmCreatedAt": "2026-11-24T10:03:00.000Z"}
    # rows of core.provider_commands as the SELECT prints them: kind, key, status, attempts, created_at, last_error
    CONFIG = ("cluster.backup", FIRST, "Done", "1", f"{DAY}090010.000000", "")
    OTHER = ("volume.backup", f"volume-backup-11111111-2222-3333-4444-555555555555-{DAY}", "Done", "1", f"{DAY}090001.000000", "")

    def backup(self, status, attempts="1", error=""):
        return ("vm.backup", self.KEY, status, attempts, f"{self.DAY}100500.000000", error)

    def again(self, status, attempts="1", error="", key=None, created="100900.000000"):
        return ("cluster.backup", key or self.AGAIN, status, attempts, self.DAY + created, error)

    def read(self, clock, *rows, day=None):
        """One read at <clock> (HHmmss of the day): the two rows every case has, then rows."""
        rows = (self.OTHER, self.CONFIG, *rows)
        return ["\n".join("|".join(((day or self.DAY) + clock, *row)) for row in rows), 0]

    def copies(self, clock, read_at, *taken, outcome="Read"):
        """One read of core.backups at <clock>: the incus observation last read at <read_at>, one config row per <taken>."""
        lines = [f"{self.DAY}{clock}|{outcome}|{read_at}|{t[:8]}T{t[8:]}Z|{t}" for t in taken] or [f"{self.DAY}{clock}|{outcome}|{read_at}||"]
        return ["\n".join(lines), 0]

    # the reads of a run that passes: the gate, Job a's row, Leased, Done, settled, Job b's config, Leased, Done
    def passing(self):
        return [self.read("100400"), self.read("100501", self.backup("Pending", "0")), self.read("100510", self.backup("Leased")),
                self.read("100800", self.backup("Done")), self.read("100805", self.backup("Done")),
                self.read("100901", self.backup("Done"), self.again("Pending", "0")),
                self.read("100905", self.backup("Done"), self.again("Leased")),
                self.read("100930", self.backup("Done"), self.again("Done"))]

    def run_bak22(self, reads, copies=None, facts=None, hold_minutes="1e9", **env):
        copies = copies or [self.copies("101001", f"{self.DAY}101000", "20261123090020", f"{self.DAY}100910")]
        return run("bak22", "--kubeconfig", "kc", "--job", "regression-config-again-p1", "--log", "{tmp}/bak22.log",
                   "--every", "0", "--gate-minutes", "0.02", "--backup-minutes", "0.02", "--settle-minutes", "0.02",
                   "--config-minutes", "0.02", "--read-minutes", "0.02", "--job-minutes", "0.02", "--hold-minutes", hold_minutes,
                   **{"FAKE_LOG_0": hold_line("bak22", facts or self.FACTS),
                      "FAKE_LOG_AFTER_TOUCH": "2026-11-24T10:09:31.000Z GO bak22",
                      "FAKE_CRONJOBS": json.dumps(["control-plane-job-backup-schedule"]),
                      "FAKE_PSQL": json.dumps({"core.provider_commands": reads, "core.backup_observations": copies}), **env})

    def creates(self, calls):
        return [l for l in calls.splitlines() if " create job " in l]

    def test_two_jobs_around_the_vms_backup_then_go_and_one_config_row_of_the_day(self):
        code, out, calls, state = self.run_bak22(self.passing())
        self.assertEqual(code, 0, out)
        self.assertIn(f"L_BAK22=PASS {self.KEY} Done (row created {self.DAY}100500.000000), then {self.AGAIN} Done", out)
        self.assertIn(f"L_BAK23=PASS days=2 today={self.DAY}T100910Z", out)
        self.assertTrue((state / "pod" / "go-bak22").exists())
        self.assertFalse((state / "pod" / "skip-bak22").exists())
        lines = calls.splitlines()
        first = next(i for i, l in enumerate(lines) if re.search(r"create job rg-bak22a-\d+ --from=cronjob/control-plane-job-backup-schedule -n ns-control-plane-job-backup-schedule", l))
        second = next(i for i, l in enumerate(lines) if re.search(r"create job rg-bak22b-\d+ --from=cronjob/control-plane-job-backup-schedule", l))
        # one read before the first Job; the row, Leased, Done and the settled read between the two
        self.assertEqual(sum("core.provider_commands" in l for l in lines[:first]), 1)
        self.assertEqual(sum("core.provider_commands" in l for l in lines[first:second]), 4)
        self.assertEqual(sum("core.backup_observations" in l for l in lines[:second]), 0)
        # the CronJob is read idle before each Job
        self.assertEqual(sum("get cronjob control-plane-job-backup-schedule -n ns-control-plane-job-backup-schedule -o json" in l for l in lines[:first]), 1)
        self.assertEqual(sum("get cronjob control-plane-job-backup-schedule -n" in l for l in lines[first:second]), 1)
        self.assertRegex(calls, r"delete job rg-bak22a-\d+ -n ns-control-plane-job-backup-schedule")
        self.assertRegex(calls, r"delete job rg-bak22b-\d+ -n ns-control-plane-job-backup-schedule")
        self.assertIn("exec -n ns-titan-db-1 titan-db-1 -c postgres -- psql -U postgres -d titan -At -F | -c SELECT", calls)
        self.assertIn(f"c.cluster_id = 'local' AND c.kind IN ('vm.backup', 'volume.backup', 'cluster.backup', 'restore.drill') AND c.key ~ '-{self.DAY}([0-9][0-9])?$'", calls)
        self.assertIn("b.kind = 'cluster' AND b.resource_name = 'local'", calls)
        log = (state.parent / "bak22.log").read_text()
        self.assertEqual(log.rstrip().splitlines()[-1], f"L_BAK23=PASS days=2 today={self.DAY}T100910Z")
        self.assertTrue(log.rstrip().splitlines()[-2].startswith("L_BAK22=PASS "))
        # a read is logged when its rows changed, whatever the clock: the Done read and the settled read are one entry
        self.assertEqual(log.count(f"vm.backup|{self.KEY}|Done|1|{self.DAY}100500.000000|\nexit=0"), 1)
        # the clocks the steps were decided on are in the log
        for line in (f"# the read before the first Job\ndatabase clock {self.DAY}100400",
                     f"# the read before the second Job\ndatabase clock {self.DAY}100805",
                     f"# the read that saw {self.AGAIN} Done\ndatabase clock {self.DAY}100930",
                     f"# the first read of the bucket after it\ndatabase clock {self.DAY}101001"):
            self.assertIn(line, log)

    def test_no_config_done_today_is_not_covered_and_creates_no_job(self):
        pending = ["\n".join([f"{self.DAY}100400|cluster.backup|{self.FIRST}|Leased|1|{self.DAY}100001.000000|"]), 0]
        for reads in ([[f"{self.DAY}100400||||||", 0]], [pending]):
            code, out, calls, state = self.run_bak22(reads)
            self.assertEqual(code, 4, out)
            self.assertIn(f"L_BAK22=NOT_COVERED no cluster config of {self.DAY} is Done yet", out)
            self.assertIn("L_BAK23=NOT_COVERED BAK-22 did not pass before it", out)
            self.assertEqual(self.creates(calls), [])
            self.assertTrue((state / "pod" / "skip-bak22").exists())

    def test_a_config_asked_after_the_vm_was_created_is_not_covered(self):
        code, out, calls, _ = self.run_bak22([self.read("100400", self.again("Done", created="100300.000000"))])
        self.assertEqual(code, 4, out)
        self.assertIn(f"L_BAK22=NOT_COVERED a config of the day was asked after the VM was created ({self.AGAIN}=Done)", out)
        self.assertEqual(self.creates(calls), [])
        # one microsecond earlier than the VM is older than it
        code, out, _, _ = self.run_bak22([self.read("100400", self.again("Done", created="100259.999999"))])
        self.assertNotIn("was asked after the VM", out)

    def test_a_backup_the_cronjobs_own_pass_queued_first_is_not_covered(self):
        code, out, calls, _ = self.run_bak22([self.read("100400", self.backup("Pending", "0"))])
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK22=NOT_COVERED the CronJob's own pass queued the VM's backup before the agent's Job", out)
        self.assertEqual(self.creates(calls), [])

    def test_a_job_only_from_minute_3_with_a_pass_before_the_next_hour_and_the_cronjob_idle(self):
        jm = 0.02
        self.assertFalse(phase4.clear_of_the_hourly_pass("20261124100259", jm))
        self.assertTrue(phase4.clear_of_the_hourly_pass("20261124100300", jm))
        self.assertTrue(phase4.clear_of_the_hourly_pass("20261124105858", jm))
        self.assertFalse(phase4.clear_of_the_hourly_pass("20261124105859", jm))
        self.assertTrue(phase4.clear_of_the_hourly_pass("20261124105500", 4))
        self.assertFalse(phase4.clear_of_the_hourly_pass("20261124105501", 4))
        # minute 1, then minute 3 with a Job of the CronJob still running, then idle: the rows of the third read decide
        reads = [self.read("100100"), self.read("100300"), self.read("100310", self.backup("Pending", "0"))]
        code, out, calls, _ = self.run_bak22(reads, FAKE_CRONJOB_ACTIVE=json.dumps([[{"name": "control-plane-job-backup-schedule-1"}], []]))
        self.assertEqual(code, 4, out)
        self.assertIn("the CronJob's own pass queued the VM's backup", out)
        self.assertEqual(calls.count("core.provider_commands"), 3)
        self.assertEqual(calls.count("get cronjob control-plane-job-backup-schedule -n"), 2)
        self.assertEqual(self.creates(calls), [])
        code, out, calls, _ = self.run_bak22([self.read("105930")])
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK22=NOT_COVERED no moment in 0.02 minutes from minute 3 of an hour", out)
        self.assertEqual(self.creates(calls), [])

    def test_another_utc_day_than_the_holds_is_not_covered(self):
        code, out, calls, _ = self.run_bak22([self.read("000400", day="20261125")])
        self.assertEqual(code, 4, out)
        self.assertIn(f"L_BAK22=NOT_COVERED the run crossed 00:00Z: the hold's day is {self.DAY}, the database's 20261125", out)
        self.assertEqual(self.creates(calls), [])

    def test_a_first_read_that_fails_is_not_covered_and_a_later_failed_read_is_read_again(self):
        code, out, calls, state = self.run_bak22([["psql: error: connection refused", 2]])
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK22=NOT_COVERED could not read core.provider_commands", out)
        self.assertTrue((state / "pod" / "skip-bak22").exists())
        self.assertEqual(self.creates(calls), [])
        reads = [self.read("100100"), ["psql: error: connection refused", 2], self.read("100400", self.backup("Pending", "0"))]
        code, out, calls, state = self.run_bak22(reads)
        self.assertIn("the CronJob's own pass queued the VM's backup", out)
        # the failure is logged once, not on every read
        reads = [["psql: error: connection refused", 2]] * 3 + [self.read("100400", self.backup("Pending", "0"))]
        code, out, calls, state = self.run_bak22([self.read("100100")] + reads)
        self.assertEqual((state.parent / "bak22.log").read_text().count("connection refused"), 1)

    def test_a_job_that_cannot_be_created_or_does_not_complete_is_not_covered(self):
        code, out, calls, state = self.run_bak22([self.read("100400")], FAKE_JOB_EXIT="1")
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK22=NOT_COVERED could not create a Job from CronJob control-plane-job-backup-schedule", out)
        self.assertNotIn("delete job", calls)
        code, out, calls, state = self.run_bak22([self.read("100400")], FAKE_JOB_STATUS=json.dumps({"rg-bak22a": {"active": 1}}))
        self.assertEqual(code, 4, out)
        self.assertRegex(out, r"L_BAK22=NOT_COVERED Job rg-bak22a-\d+ did not complete in 0\.02 minutes")
        self.assertIn("delete job rg-bak22a-", calls)
        self.assertEqual(len(self.creates(calls)), 1)
        self.assertTrue((state / "pod" / "skip-bak22").exists())

    def test_a_job_whose_pass_answered_an_error_fails_at_once(self):
        failed = {"rg-bak22a": {"failed": 3, "conditions": [{"type": "Failed", "status": "True"}]}}
        code, out, calls, state = self.run_bak22([self.read("100400")], FAKE_JOB_STATUS=json.dumps(failed))
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r"L_BAK22=FAIL Job rg-bak22a-\d+ failed \(3 pods\): its curl got an error from the pass of the schedule, or did not reach the control plane")
        self.assertEqual(calls.count(" get job rg-bak22a-"), 1)
        self.assertIn("logs job/rg-bak22a-", calls)
        self.assertIn("returned error: 500", (state.parent / "bak22.log").read_text())
        self.assertTrue((state / "pod" / "skip-bak22").exists())

    def test_a_first_job_that_queued_no_backup_of_the_vm_fails(self):
        code, out, calls, state = self.run_bak22([self.read("100400")])
        self.assertEqual(code, 1, out)
        self.assertIn(f"L_BAK22=FAIL the pass of the first Job queued no row {self.KEY}", out)
        self.assertTrue((state / "pod" / "skip-bak22").exists())
        self.assertEqual(len(self.creates(calls)), 1)

    def test_a_pass_read_in_the_next_hour_or_day_is_not_covered_not_failed(self):
        code, out, _, _ = self.run_bak22([self.read("105800"), self.read("110005")])
        self.assertEqual(code, 4, out)
        self.assertIn(f"the first Job's pass may have run in the next hour ({self.DAY}11, the read before it {self.DAY}10)", out)
        code, out, _, _ = self.run_bak22([self.read("235800"), self.read("000005", day="20261125")])
        self.assertEqual(code, 4, out)
        self.assertIn("the first Job's pass may have run in the next hour (2026112500", out)
        head = self.passing()[:5]
        code, out, _, _ = self.run_bak22(head + [self.read("110001", self.backup("Done"))])
        self.assertEqual(code, 4, out)
        self.assertIn(f"the second Job's pass may have run in the next hour ({self.DAY}11, the read before it {self.DAY}10)", out)

    def test_a_backup_of_the_vm_that_failed_or_did_not_end_is_not_covered(self):
        failed = self.backup("Failed", "5", "export: no space left")
        code, out, calls, _ = self.run_bak22([self.read("100400"), self.read("100501", failed)])
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK22=NOT_COVERED the VM's backup ended Failed attempts=5 last_error='export: no space left'", out)
        self.assertEqual(len(self.creates(calls)), 1)
        ahead = ("volume.backup", f"volume-backup-99999999-2222-3333-4444-555555555555-{self.DAY}", "Leased", "1", f"{self.DAY}060000.000000", "")
        code, out, _, _ = self.run_bak22([self.read("100400"), self.read("100501", ahead, self.backup("Pending", "0"))])
        self.assertEqual(code, 4, out)
        self.assertIn(f"the VM's backup did not end in 0.02 minutes (Pending); other disk backups of the cluster waiting: {ahead[1]}=Leased", out)

    def test_a_backup_or_config_still_waiting_before_the_second_job_is_not_covered(self):
        reopened = ("volume.backup", f"volume-backup-99999999-2222-3333-4444-555555555555-{self.DAY}", "Pending", "0", f"{self.DAY}090002.000000", "")
        code, out, calls, _ = self.run_bak22([self.read("100400"), self.read("100800", self.backup("Done"), reopened)])
        self.assertEqual(code, 4, out)
        self.assertIn(f"a backup or a config of the day still waits ({reopened[1]}=Pending)", out)
        self.assertEqual(len(self.creates(calls)), 1)
        leased = self.again("Leased", key=f"cluster-backup-local-{self.DAY}09", created="095000.000000")
        code, out, calls, _ = self.run_bak22([self.read("100400", leased), self.read("100800", leased, self.backup("Done"))])
        self.assertEqual(code, 4, out)
        self.assertIn(f"still waits (cluster-backup-local-{self.DAY}09=Leased)", out)
        self.assertEqual(len(self.creates(calls)), 1)

    def test_the_second_job_waits_for_a_moment_clear_of_the_cronjobs_pass(self):
        done = self.backup("Done")
        reads = [self.read("100400"), self.read("100501", done), self.read("105859", done), self.read("110100", done)]
        code, out, calls, _ = self.run_bak22(reads)
        self.assertEqual(code, 4, out)
        self.assertIn("or no moment clear of the CronJob's own pass came", out)
        self.assertEqual(len(self.creates(calls)), 1)

    def test_a_config_or_disk_row_queued_since_the_vms_backup_row_before_the_second_job_is_not_covered(self):
        code, out, calls, _ = self.run_bak22([self.read("100400"), self.read("100800", self.backup("Done"), self.again("Done"))])
        self.assertEqual(code, 4, out)
        self.assertIn(f"a pass other than the agent's queued a config after the VM's backup row, before the second Job ({self.AGAIN}=Done)", out)
        self.assertEqual(len(self.creates(calls)), 1)
        disk = ("vm.backup", f"vm-backup-77777777-2222-3333-4444-555555555555-{self.DAY}", "Done", "1", f"{self.DAY}100700.000000", "")
        code, out, calls, _ = self.run_bak22([self.read("100400"), self.read("100800", self.backup("Done"), disk)])
        self.assertEqual(code, 4, out)
        self.assertIn(f"another disk was created in between: its backup row is newer than the VM's ({disk[1]}=Done)", out)
        self.assertEqual(len(self.creates(calls)), 1)

    def test_the_hours_config_key_already_there_is_not_covered(self):
        earlier = self.again("Done", created="100100.000000")
        reads = [self.read("100400", earlier), self.read("100800", earlier, self.backup("Done"))]
        code, out, calls, _ = self.run_bak22(reads, facts={**self.FACTS, "vmCreatedAt": "2026-11-24T10:03:30.000Z"})
        self.assertEqual(code, 4, out)
        self.assertIn(f"this UTC hour's config key {self.AGAIN} is there already", out)
        self.assertEqual(len(self.creates(calls)), 1)

    def test_a_second_job_that_queued_another_disks_backup_is_not_covered_and_one_that_queued_nothing_fails(self):
        done = self.read("100800", self.backup("Done"))
        new_disk = ("vm.backup", f"vm-backup-77777777-2222-3333-4444-555555555555-{self.DAY}", "Pending", "0", f"{self.DAY}100901.000000", "")
        code, out, calls, state = self.run_bak22([self.read("100400"), done, done, done, self.read("100901", self.backup("Done"), new_disk)])
        self.assertEqual(code, 4, out)
        self.assertIn(f"another disk was created in between: the second Job queued its backup, not a config ({new_disk[1]}=Pending)", out)
        self.assertEqual(len(self.creates(calls)), 2)
        self.assertEqual(calls.count("delete job"), 2)
        code, out, calls, state = self.run_bak22([self.read("100400"), done])
        self.assertEqual(code, 1, out)
        self.assertIn(f"L_BAK22=FAIL the pass of the second Job queued no config {self.AGAIN} (configs of the day: {self.FIRST}=Done)", out)
        self.assertTrue((state / "pod" / "skip-bak22").exists())
        self.assertFalse((state / "pod" / "go-bak22").exists())

    def test_a_config_under_another_hours_key_fails(self):
        other = self.again("Done", key=f"cluster-backup-local-{self.DAY}17")
        reads = self.passing()[:5] + [self.read("100930", self.backup("Done"), other)]
        code, out, _, _ = self.run_bak22(reads)
        self.assertEqual(code, 1, out)
        self.assertIn(f"L_BAK22=FAIL the pass of the second Job queued cluster-backup-local-{self.DAY}17, not {self.AGAIN}", out)

    def test_a_config_that_failed_fails_and_one_that_did_not_end_is_not_covered(self):
        head = self.passing()[:6]
        failed = self.read("100930", self.backup("Done"), self.again("Failed", "5", "cannot reach the cluster"))
        code, out, _, state = self.run_bak22(head + [failed])
        self.assertEqual(code, 1, out)
        self.assertIn(f"L_BAK22=FAIL {self.AGAIN} ended Failed attempts=5 last_error='cannot reach the cluster'", out)
        self.assertTrue((state / "pod" / "skip-bak22").exists())
        code, out, _, _ = self.run_bak22(head)
        self.assertEqual(code, 4, out)
        self.assertIn(f"L_BAK22=NOT_COVERED {self.AGAIN} did not end in 0.02 minutes (Pending)", out)

    def test_a_restore_drill_the_second_job_queued_is_named(self):
        drill = ("restore.drill", f"restore-drill-local-{self.DAY}", "Pending", "0", f"{self.DAY}100900.000000", "")
        reads = self.passing()[:5] + [self.read("100930", self.backup("Done"), self.again("Done"), drill)]
        code, out, _, _ = self.run_bak22(reads)
        self.assertEqual(code, 0, out)
        self.assertIn(f"; the second Job also queued restore-drill-local-{self.DAY}=Pending", out)

    def test_no_job_once_the_spec_has_stopped_waiting(self):
        # the HOLD line is of 2026-11-19: a spec that waits 40 minutes stopped long ago
        code, out, calls, state = self.run_bak22([self.read("100400")], hold_minutes="40")
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK22=NOT_COVERED the spec stops waiting at 10:40:00Z: too little time left for the two passes", out)
        self.assertEqual(self.creates(calls), [])
        self.assertTrue((state / "pod" / "skip-bak22").exists())

    def test_bak23_judges_the_first_read_of_the_bucket_later_than_the_config(self):
        # the config was read Done at 10:09:30: a read of the bucket in that second does not count, the next one does
        early = self.copies("100935", f"{self.DAY}100930", "20261123090020", f"{self.DAY}090020")
        unreadable = self.copies("101001", f"{self.DAY}101000", "20261123090020", f"{self.DAY}090020", outcome="Unreadable")
        late = self.copies("101501", f"{self.DAY}101500", "20261123090020", f"{self.DAY}100910")
        code, out, calls, _ = self.run_bak22(self.passing(), [early, late])
        self.assertEqual(code, 0, out)
        self.assertEqual(calls.count("core.backup_observations"), 2)
        code, out, _, state = self.run_bak22(self.passing(), [early, unreadable, late])
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK22=PASS ", out)
        self.assertIn(f"L_BAK23=NOT_COVERED the read of the bucket at {self.DAY}101000 could not list it (outcome=Unreadable)", out)
        self.assertTrue((state / "pod" / "go-bak22").exists())
        code, out, _, _ = self.run_bak22(self.passing(), [early])
        self.assertIn(f"L_BAK23=NOT_COVERED no read of the bucket after {self.DAY}100930 in 0.02 minutes (outcome=Read last_read_at={self.DAY}100930)", out)
        code, out, _, _ = self.run_bak22(self.passing(), [["", 0]])
        self.assertIn("L_BAK23=NOT_COVERED no read of the bucket", out)
        nextday = ["20261125000101|Read|20261125000100|20261124T100910Z|20261124100910", 0]
        code, out, _, _ = self.run_bak22(self.passing(), [nextday])
        self.assertIn("L_BAK23=NOT_COVERED the run crossed 00:00Z before the bucket was read (20261125)", out)

    def test_bak23_fails_on_two_rows_of_the_day_and_the_exit_is_1(self):
        two = self.copies("101001", f"{self.DAY}101000", f"{self.DAY}090020", f"{self.DAY}100910")
        code, out, _, _ = self.run_bak22(self.passing(), [two])
        self.assertEqual(code, 1, out)
        self.assertIn("L_BAK22=PASS ", out)
        self.assertIn(f"L_BAK23=FAIL 2 config rows of {self.DAY}, not one: {self.DAY}T090020Z {self.DAY}T100910Z", out)

    def test_bak23_verdict(self):
        day, after = self.DAY, f"{self.DAY}100500.000000"
        today = (f"{day}100910", f"{day}T100910Z")
        week = [(f"202611{d}090020", f"202611{d}T090020Z") for d in range(18, 24)]
        self.assertEqual(phase4.bak23_verdict(week + [today], day, after), ("PASS", f"days=7 today={day}T100910Z"))
        self.assertIn("none", phase4.bak23_verdict(week, day, after)[1])
        self.assertEqual(phase4.bak23_verdict([("20261117090020", "a")] + week + [today], day, after)[1], "config rows of 8 UTC days, more than 7")
        self.assertEqual(phase4.bak23_verdict(week + [("20261123100000", "b"), today], day, after)[1], "more than one config row on 20261123")
        # the day's earlier config kept instead of the one asked after the VM's backup
        old = (f"{day}090020", f"{day}T090020Z")
        self.assertIn("is not later than the VM's backup row", phase4.bak23_verdict(week + [old], day, after)[1])
        self.assertIn("is not the newest", phase4.bak23_verdict([today, ("20261125000001", "c")], day, after)[1])

    def test_the_rows_are_parsed_by_shape(self):
        text = f"{self.DAY}100400|vm.backup|{self.KEY}|Failed|5|{self.DAY}100500.000000|export\x0c no space\nnoise\n(1 row)\n"
        clock, rows = phase4.backup_rows(text)
        self.assertEqual(clock, f"{self.DAY}100400")
        self.assertEqual([(r.kind, r.key, r.status, r.attempts, r.created, r.error) for r in rows],
                         [("vm.backup", self.KEY, "Failed", 5, f"{self.DAY}100500.000000", "export\x0c no space")])
        self.assertEqual(phase4.backup_rows(f"{self.DAY}100400||||||"), (f"{self.DAY}100400", []))
        self.assertEqual(phase4.backup_rows("psql: error"), (None, []))
        self.assertIsNone(phase4.config_copies(""))
        self.assertEqual(phase4.config_copies(f"{self.DAY}101001|Read|{self.DAY}101000||"), (f"{self.DAY}101001", "Read", f"{self.DAY}101000", []))
        self.assertIn("regexp_replace(left(coalesce(c.last_error, ''), 200), '[[:cntrl:]|]', ' ', 'g')", phase4.backup_rows_of("local", self.DAY))
        self.assertEqual(phase4.hold_started(hold_line("bak22", self.FACTS), "bak22"),
                         phase4.datetime.datetime(2026, 11, 19, 10, 0, tzinfo=phase4.datetime.timezone.utc))
        self.assertIsNone(phase4.hold_started(hold_line("bak20", self.FACTS), "bak22"))

    def test_facts_out_of_shape_run_no_sql_and_answer_skip(self):
        for bad in ({"clusterId": "x'; drop table t; --"}, {"vmId": "x"}, {"backupKey": "k"}, {"vmCreatedAt": "2026-11-24 10:03"}):
            code, out, calls, state = self.run_bak22([self.read("100400")], facts={**self.FACTS, **bad})
            self.assertEqual(code, 2, out)
            self.assertNotIn("psql", calls)
            self.assertEqual(self.creates(calls), [])
            self.assertTrue((state / "pod" / "skip-bak22").exists())

    def test_an_error_of_the_command_answers_skip_and_deletes_its_jobs(self):
        # no CronJob control-plane-job-backup-schedule on the cluster: namespace_of stops the command
        code, out, calls, state = self.run_bak22([self.read("100400")], FAKE_CRONJOBS="[]")
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK22=NOT_COVERED the command stopped: not exactly one cronjob control-plane-job-backup-schedule", out)
        self.assertTrue((state / "pod" / "skip-bak22").exists())
        # a Job whose `.status` is not an object breaks the command after the first Job: that Job is still deleted
        code, out, calls, state = self.run_bak22([self.read("100400")], FAKE_JOB_STATUS='{"rg-bak22a": "not an object"}')
        self.assertEqual(code, 4, out)
        self.assertIn("L_BAK22=NOT_COVERED the command stopped: 'str' object has no attribute 'get'", out)
        self.assertRegex(calls, r"delete job rg-bak22a-\d+ -n ns-control-plane-job-backup-schedule")
        self.assertTrue((state / "pod" / "skip-bak22").exists())

    def test_an_error_after_the_go_keeps_bak22s_pass_and_one_before_it_answers_skip(self):
        import contextlib
        import io

        class Kube:
            def __init__(self, *_):
                self.ns = "ns"

            def run(self, *args, **_):
                return subprocess.CompletedProcess(args, 0, "", "")

        answers = []

        def fake_answer(_, step, word, __):
            answers.append(f"{word}-{step}")
            return 0

        def fails(after_go):
            def bak22(args, kube, facts, run):
                run.log = phase4.Log(args.log, "test")
                run.cp_ns = "ns"
                run.jobs.append("rg-bak22b-1")
                if after_go:
                    run.answered, run.passed = True, "rows Done"
                raise RuntimeError("boom")
            return bak22

        saved = phase4.Kube, phase4.wait_for, phase4.answer, phase4.bak22
        try:
            phase4.Kube, phase4.wait_for, phase4.answer = Kube, (lambda *_: dict(self.FACTS)), fake_answer
            for after_go, lines in ((True, ["L_BAK22=PASS rows Done", "L_BAK23=NOT_COVERED the command stopped: boom"]),
                                    (False, ["L_BAK22=NOT_COVERED the command stopped: boom", "L_BAK23=NOT_COVERED BAK-22 did not pass before it"])):
                answers.clear()
                phase4.bak22 = fails(after_go)
                log = pathlib.Path(tempfile.mkdtemp()) / "bak22.log"
                out = io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                    code = phase4.cmd_bak22(types.SimpleNamespace(kubeconfig="kc", job="j", timeout_minutes=1, log=str(log)))
                self.assertEqual(code, 4)
                self.assertEqual(out.getvalue().splitlines()[-2:], lines)
                self.assertEqual(log.read_text().splitlines()[-2:], lines)
                self.assertIn("$ kubectl delete job rg-bak22b-1 -n ns", log.read_text())
                self.assertEqual(answers, [] if after_go else ["skip-bak22"])
        finally:
            phase4.Kube, phase4.wait_for, phase4.answer, phase4.bak22 = saved


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
