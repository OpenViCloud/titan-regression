#!/usr/bin/env python3
"""The agent's side of Phase 4 (phase4/, phase4-backup/): each step one command, so nobody writes a shell loop by hand.

A Phase 4 spec logs `HOLD <step> <facts JSON>` and waits for /work/results/go-<step> (or skip-<step>) in its pod; the
agent does the step's host commands in between. Every host command and every answer goes to a log of the release's
evidence as `[HH:MM:SSZ]` / `$ <command>` / output / `exit=<n>`.

    python3 phase4.py keys <dir>                      # key pairs v, u, x (ed25519, no passphrase); an existing pair is kept
    python3 phase4.py connect --control <socket> --target <user@host> --known-hosts <file> [--ssh-config <file>]
    python3 phase4.py wait --kubeconfig <kc> --job <job> [--timeout-minutes 80]   # prints the pending HOLD
    python3 phase4.py go|skip <step> --kubeconfig <kc> --job <job> [--log <file>] # answers it, returns once the spec has
    python3 phase4.py host --control <socket> --target <user@host> --log <file> [--keys <dir>] -- '<command>'
    python3 phase4.py host --local --log <file> [--keys <dir>] -- '<command>'      # same entry, on this machine
    python3 phase4.py bak18 --kubeconfig <kc> --job <job> --control <socket> --target <user@host> --log <file>
    python3 phase4.py vm35 --kubeconfig <kc> --job <job> --control <socket> --target <user@host> --log <file>
    python3 phase4.py sample --control <socket> --target <user@host> --project <t-…> --stop <file> --log <file> [--every 30]
                              [--read-timeout 60] [--lane a|b, default sequential]
    python3 phase4.py disconnect --control <socket> --target <user@host>

<job> is the name run-module.sh gives the job (regression-<module>-<label>). The host command runs through the
ControlMaster socket with stdin closed and BatchMode on, and only when `ssh -O check` finds the master (else exit 2: no
connection of its own, which would read the default known_hosts); `{V}`, `{U}`, `{X}` in a command become the
base64 body of <keys>/v.pub, u.pub, x.pub (public halves only). A host command's exit code is this script's.

bak18 (BAK-18, titan-ops features/backup/design.md#incus-backup) answers HOLD bak18 of phase4-backup/: it reads the
copy bk<26> of the held VM on the host until it is there (the hourly backup-schedule run, `:00` UTC), logs the copy's
devices and the volume's used_by, waits for a `reconcile cluster done` of the worker (its inventory pod where there is
one) after the copy was seen, reads both again while the copy still exists, then creates go-bak18; at HOLD bak18-gone
it waits for that copy and the volume's copy bkv<26> to be gone (they hold the spec's network and its detach) and creates
go-bak18-gone. Last line
BAK18_HOST=PASS (exit 0) | FAIL <what> (exit 1, go-bak18 and go-bak18-gone still created: the spec measures the API
side; the spec holds at bak18-gone whatever its API check says) | NOT_COVERED <why> (exit 4, skip-bak18, then
go-bak18-gone: no copy before the timeout, no `reconcile cluster done` after it, or the copy gone before one).

vm35 (VM-35, titan-ops features/vm/design.md#console-password) answers HOLD vm35 of phase4/: it waits on the host for
`cloud-init status --wait` of the held VM to print `status: done`, reads `getent shadow ubuntu`, `passwd -S ubuntu` and
`cloud-init.vendor-data` of it and of the held VM without a console password, then, in the pod, hashes the password
file the spec left there with `openssl passwd -6` and the salt read from the shadow and greps the vendor-data for it:
the password never leaves the pod, so it is in no log, no argv and no file here. Last line VM35_HOST=PASS (exit 0) |
FAIL <what> (exit 1, go-vm35) | NOT_COVERED <why> (exit 4, skip-vm35: no `status:` from cloud-init before the timeout,
or the pod could not hash or grep).

sample reads the project every <every> seconds, read-only, and logs a line per object only when its summary changed
(`GONE <object>` when it left), then `sample objects=<n>`; a failed read (or one with no answer in --read-timeout
seconds) is an `ERROR` line, a sample that breaks is one `ERROR` line, and sampling goes on; it ends after the sample
that finds <stop>.

Exit 2: usage, the pending HOLD is not the step asked for, or no ControlMaster on the socket. wait: exit 3 = the runner finished with no HOLD pending.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

POLL = float(os.environ.get("PHASE4_POLL_SECONDS", "10"))
HOLD = re.compile(r"^\S+ HOLD (\S+) (\{.*\})\s*$")
ANSWER = re.compile(r"^\S+ (GO|SKIP) (\S+)\s*$")
RECONCILE_DONE = "reconcile cluster done"
RECONCILE_WAIT_SECONDS = 6 * 60


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def pending_hold(text):
    """(step, facts) of the last HOLD that no later GO or SKIP of the same step answers, else None."""
    pending = None
    for line in text.splitlines():
        m = HOLD.match(line)
        if m:
            pending = (m.group(1), json.loads(m.group(2)))
            continue
        m = ANSWER.match(line)
        if m and pending and m.group(2) == pending[0]:
            pending = None
    return pending


def answered(text, step):
    """GO or SKIP when the log answers the last HOLD of step, else None."""
    last = None
    for line in text.splitlines():
        m = HOLD.match(line)
        if m and m.group(1) == step:
            last = None
        m = ANSWER.match(line)
        if m and m.group(2) == step:
            last = m.group(1)
    return last


class Log:
    """The evidence log: a header line when the file is new, then one entry per command."""

    def __init__(self, path, header):
        self.path = path
        if path and not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(f"# {header} · {now().strftime('%Y-%m-%dT%H:%M:%SZ')}\n")

    def entry(self, command, output, code):
        if not self.path:
            return
        text = output if output.endswith("\n") or not output else output + "\n"
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(f"[{now().strftime('%H:%M:%SZ')}]\n$ {command}\n{text}exit={code}\n")


class Kube:
    def __init__(self, kubeconfig, job):
        self.kubeconfig, self.job = kubeconfig, job
        self.ns = self.namespace_of("cronjob", "titan-regression")
        self.app_ns = self.namespace_of("deployment", "control-plane")
        self._pod = None

    def run(self, *args, input=None):
        stdin = {"stdin": subprocess.DEVNULL} if input is None else {"input": input}
        return subprocess.run(["kubectl", "--kubeconfig", self.kubeconfig, *args], capture_output=True, text=True, **stdin)

    def json(self, *args):
        out = self.run(*args, "-o", "json")
        if out.returncode != 0:
            raise SystemExit(f"kubectl {' '.join(args)}: {out.stderr.strip()}")
        return json.loads(out.stdout)

    def namespace_of(self, kind, name):
        found = [i["metadata"]["namespace"] for i in self.json("get", kind, "-A")["items"] if i["metadata"]["name"] == name]
        if len(found) != 1:
            raise SystemExit(f"not exactly one {kind} {name} on this cluster")
        return found[0]

    def pod(self, wait_until=None):
        """The job's pod; with wait_until (a time.monotonic() deadline), read again until it is there."""
        while self._pod is None:
            items = self.json("get", "pods", "-n", self.ns, "-l", f"job-name={self.job}")["items"]
            if items:
                self._pod = items[0]["metadata"]["name"]
            elif wait_until is None or time.monotonic() >= wait_until:
                raise SystemExit(f"no pod of job {self.job} in {self.ns}")
            else:
                time.sleep(POLL)
        return self._pod

    def logs(self):
        return self.run("logs", "-n", self.ns, self.pod()).stdout

    def touch(self, name):
        return self.run("exec", "-n", self.ns, self.pod(), "--", "touch", f"/work/results/{name}")

    def exec_pod(self, *command, input=None):
        """A command in the job's pod; with input, that text is its stdin."""
        return self.run("exec", *(["-i"] if input is not None else []), "-n", self.ns, self.pod(), "--", *command,
                        input=input)

    def worker_logs(self, since):
        inventory = self.json("get", "pods", "-n", self.app_ns, "-l", "app=incus-worker-inventory")["items"]
        app = "incus-worker-inventory" if inventory else "incus-worker"
        return self.run("logs", "-n", self.app_ns, "-l", f"app={app}", f"--since-time={since}", "--tail=-1").stdout


def ssh_args(control, target):
    return ["ssh", "-S", control, "-o", "ControlMaster=no", "-o", "BatchMode=yes", target]


def substitute(command, keys):
    if not keys:
        return command
    for name in ("v", "u", "x"):
        token = "{" + name.upper() + "}"
        if token in command:
            with open(os.path.join(keys, f"{name}.pub"), encoding="utf-8") as fh:
                command = command.replace(token, fh.read().split()[1])
    return command


class NoMaster(Exception):
    pass


def run_command(args, command, timeout=None):
    """(exit code, stdout+stderr) of one command, on the host through the socket or here with --local. With no master
    on the socket ssh would open a connection of its own (default known_hosts, not the pinned one): refused."""
    if not args.local:
        check = subprocess.run(["ssh", "-S", args.control, "-O", "check", args.target], capture_output=True, text=True,
                               stdin=subprocess.DEVNULL)
        if check.returncode != 0:
            raise NoMaster(f"no ControlMaster on {args.control} for {args.target} (phase4.py connect first): "
                           f"{check.stderr.strip()}")
    argv = ["bash", "-c", command] if args.local else ssh_args(args.control, args.target) + [command]
    try:
        out = subprocess.run(argv, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, f"no answer in {timeout:g} s"
    return out.returncode, out.stdout + out.stderr


def host_log(args):
    where = "local" if getattr(args, "local", False) else f"ssh {args.target}, ControlMaster"
    return Log(args.log, f"phase4.py host ({where}) · {'this machine' if where == 'local' else args.target}")


def cmd_host(args):
    command = substitute(" ".join(args.command), args.keys)
    code, output = run_command(args, command)
    host_log(args).entry(command, output, code)
    sys.stdout.write(output)
    return code


def cmd_keys(args):
    os.makedirs(args.dir, exist_ok=True)
    for name in ("v", "u", "x"):
        path = os.path.join(args.dir, name)
        if not os.path.exists(path + ".pub"):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f"rg-p4-{name}", "-f", path],
                           check=True, stdin=subprocess.DEVNULL)
        print(path + ".pub")
    return 0


def cmd_connect(args):
    # --ssh-config: a host only an ssh config names (dev: ~/.lima/titan-incus/ssh.config, target lima-titan-incus)
    config = ["-F", args.ssh_config] if args.ssh_config else []
    return subprocess.run(["ssh", *config, "-M", "-N", "-f", "-S", args.control, "-o", "ControlPersist=4h", "-o",
                           "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={args.known_hosts}", "-o",
                           "BatchMode=yes", args.target], stdin=subprocess.DEVNULL).returncode


def cmd_disconnect(args):
    return subprocess.run(["ssh", "-S", args.control, "-O", "exit", args.target], stdin=subprocess.DEVNULL).returncode


def cmd_wait(args):
    kube = Kube(args.kubeconfig, args.job)
    deadline = time.monotonic() + args.timeout_minutes * 60
    kube.pod(wait_until=deadline)
    while True:
        text = kube.logs()
        held = pending_hold(text)
        if held:
            print(f"HOLD {held[0]} {json.dumps(held[1])}")
            return 0
        if "RESULTS_READY" in text:
            print("NO_HOLD the runner finished")
            return 3
        if time.monotonic() >= deadline:
            print(f"no HOLD after {args.timeout_minutes} minutes")
            return 1
        time.sleep(POLL)


def answer(kube, step, word, log):
    """Creates go-/skip-<step> once the pending HOLD is that step; returns when the spec logged the answer."""
    held = pending_hold(kube.logs())
    if not held or held[0] != step:
        print(f"the pending HOLD is {held[0] if held else 'none'}, not {step}")
        return 2
    out = kube.touch(f"{word}-{step}")
    if out.returncode != 0:
        log.entry(f"touch /work/results/{word}-{step}", out.stderr, out.returncode)
        print(out.stderr, end="")
        return out.returncode
    deadline = time.monotonic() + 60
    while True:
        said = answered(kube.logs(), step)
        if said or time.monotonic() >= deadline:
            line = f"{said} {step}" if said else f"no GO/SKIP for {step} in the log after 60 s"
            log.entry(f"touch /work/results/{word}-{step}", line, 0 if said else 1)
            print(line)
            return 0 if said else 1
        time.sleep(POLL)


def cmd_answer(args):
    kube = Kube(args.kubeconfig, args.job)
    return answer(kube, args.step, args.word, Log(args.log, f"phase4.py {args.word} · job {args.job}"))


def copy_verdict(copy, volume, vm, copy_name, vol):
    """What is wrong with the copy and the volume's used_by (empty when nothing): the volume's device on the copy is
    `{"type": "none"}`, root and NIC are there, used_by holds the VM and not the copy."""
    problems = []
    devices = copy.get("expanded_devices", {})
    if devices.get(vol) != {"type": "none"}:
        problems.append(f"device {vol} on {copy_name} is {json.dumps(devices.get(vol))}, not {{\"type\": \"none\"}}")
    if not any(d.get("type") == "disk" and d.get("path") == "/" for d in devices.values()):
        problems.append(f"no root disk on {copy_name}")
    if not any(d.get("type") == "nic" for d in devices.values()):
        problems.append(f"no nic on {copy_name}")
    users = [u.split("?")[0].rsplit("/", 1)[-1] for u in volume.get("used_by", [])]
    if users != [vm]:
        problems.append(f"used_by of {vol} is {users}, not [{vm}]")
    return problems


def cmd_bak18(args):
    kube = Kube(args.kubeconfig, args.job)
    log = Log(args.log, f"phase4.py bak18 (ssh {args.target}, ControlMaster) · {args.target}")
    held = pending_hold(kube.logs())
    if not held or held[0] != "bak18":
        print(f"the pending HOLD is {held[0] if held else 'none'}, not bak18")
        return 2
    facts = held[1]
    project, vm, copy, vol = facts["project"], facts["vm"], facts["copy"], facts["volume"]
    args.local = False

    def query(path, logged=True):
        command = f"sudo incus query '{path}?project={project}'"
        code, output = run_command(args, command)
        if logged:
            log.entry(command, output, code)
        return json.loads(output) if code == 0 else None

    pool = None

    def give_up(why):
        # the spec holds at bak18-gone after a skip too: a copy seen but not measured still holds the network
        answer(kube, "bak18", "skip", log)
        wait_until_gone(args, kube, log, project, pool)
        print(f"BAK18_HOST=NOT_COVERED {why}")
        return 4

    source = query(f"/1.0/instances/{vm}")
    pool = next((d.get("pool") for d in (source or {}).get("expanded_devices", {}).values() if d.get("source") == vol), None)
    if pool is None:
        answer(kube, "bak18", "go", log)
        wait_until_gone(args, kube, log, project, None)
        print(f"BAK18_HOST=FAIL {'cannot read ' + vm if source is None else vol + ' is not attached to ' + vm}")
        return 1
    deadline = time.monotonic() + args.timeout_minutes * 60
    reads = 0
    while query(f"/1.0/instances/{copy}", logged=False) is None:
        reads += 1
        if time.monotonic() >= deadline:
            return give_up(f"no {copy} on the host in {args.timeout_minutes} minutes ({reads} reads)")
        time.sleep(POLL)
    seen = now().strftime("%Y-%m-%dT%H:%M:%SZ")
    first = query(f"/1.0/instances/{copy}")
    if first is None:
        return give_up(f"{copy} gone right after it was seen")
    used = query(f"/1.0/storage-pools/{pool}/volumes/custom/{vol}")
    # the same deadline as the copy's: the spec's hold started before this script, and waits no longer
    reconcile_deadline = min(time.monotonic() + RECONCILE_WAIT_SECONDS, deadline)
    while RECONCILE_DONE not in kube.worker_logs(seen):
        if time.monotonic() >= reconcile_deadline:
            return give_up(f"no '{RECONCILE_DONE}' of the worker since {seen}")
        time.sleep(POLL)
    log.entry(f"kubectl logs -n {kube.app_ns} <worker> --since-time={seen} | grep '{RECONCILE_DONE}'", RECONCILE_DONE, 0)
    after = query(f"/1.0/instances/{copy}")
    if after is None:
        return give_up(f"{copy} gone before a reconcile ended")
    used_after = query(f"/1.0/storage-pools/{pool}/volumes/custom/{vol}")
    problems = copy_verdict(first, used or {}, vm, copy, vol) + copy_verdict(after, used_after or {}, vm, copy, vol)
    answer(kube, "bak18", "go", log)
    wait_until_gone(args, kube, log, project, pool)
    if problems:
        print("BAK18_HOST=FAIL " + "; ".join(sorted(set(problems))))
        return 1
    print(f"BAK18_HOST=PASS {copy} seen {seen}, masked, used_by [{vm}], before and after a reconcile")
    return 0


CRYPT6 = re.compile(r"^\$6\$([./0-9A-Za-z]{1,16})\$[./0-9A-Za-z]{86}$")
INCUS_NAME = re.compile(r"^[a-z0-9-]+$")
HAND_OFF_FILE = re.compile(r"^/work/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
# Run in the pod: the password file is read there and never printed (VM-35).
POD_HASH = 'openssl passwd -6 -salt "$1" -stdin < "$2"'
POD_GREP = 'test -s "$1" && grep -c -F -f "$1"'


def shadow_hash(output):
    """The password field of the `ubuntu` line of `getent shadow ubuntu`, else None."""
    for line in output.splitlines():
        parts = line.split(":")
        if len(parts) >= 2 and parts[0] == "ubuntu":
            return parts[1]
    return None


def passwd_state(output):
    """The second word of `passwd -S ubuntu` (P usable, L locked, NP none), else None."""
    for line in output.splitlines():
        words = line.split()
        if len(words) >= 2 and words[0] == "ubuntu":
            return words[1]
    return None


def vm35_verdict(status, hashed, state, vendor, expected, matches, locked):
    """What is wrong (empty when nothing) with VM-35's reads: cloud-init done; the shadow field a $6$ hash equal to
    `openssl passwd -6` of the password with its salt (expected); passwd -S P; vendor-data holding that hash and not the
    password (matches = grep -c of the password in it); the VM without a password locked (`!`)."""
    problems = []
    if status != "done":
        problems.append(f"cloud-init status {status}, not done")
    if hashed is None or not CRYPT6.match(hashed):
        problems.append(f"the hash field of ubuntu starts {(hashed or '')[:3]!r}, not a $6$ hash")
    elif expected != hashed:
        problems.append("the hash field of ubuntu is not openssl passwd -6 of the password with its salt")
    if state != "P":
        problems.append(f"passwd -S ubuntu is {state}, not P")
    if hashed is not None and CRYPT6.match(hashed):
        if hashed not in vendor:
            problems.append("cloud-init.vendor-data does not hold the hash of /etc/shadow")
    elif not re.search(r"\$6\$[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}", vendor):
        problems.append("cloud-init.vendor-data holds no $6$ hash")
    if matches != "0":
        problems.append(f"cloud-init.vendor-data holds the password ({matches} lines)")
    if locked is None or not locked.startswith("!"):
        problems.append(f"the hash field of ubuntu on the VM without a password starts {(locked or '')[:3]!r}, not '!'")
    return problems


def wait_cloud_init(args, log, project, vm, deadline):
    """The word after `status:` once `cloud-init status --wait` in the guest prints one (the reads before the guest
    agent runs print none and are not logged), or None at the deadline."""
    command = f"sudo incus exec {vm} --project {project} -- cloud-init status --wait"
    while True:
        code, output = run_command(args, command, timeout=max(deadline - time.monotonic(), 1))
        status = re.search(r"^status: (\S+)", output, re.M)
        if status or time.monotonic() >= deadline:
            log.entry(command, output, code)
            return status.group(1) if status else None
        time.sleep(POLL)


def cmd_vm35(args):
    kube = Kube(args.kubeconfig, args.job)
    log = Log(args.log, f"phase4.py vm35 (ssh {args.target}, ControlMaster) · {args.target}")
    held = pending_hold(kube.logs())
    if not held or held[0] != "vm35":
        print(f"the pending HOLD is {held[0] if held else 'none'}, not vm35")
        return 2
    facts = held[1]
    project, vm, without, secret = facts["project"], facts["vm"], facts["vmWithout"], facts["passwordFile"]
    if not all(INCUS_NAME.match(x) for x in (project, vm, without)) or not HAND_OFF_FILE.match(secret):
        print(f"HOLD vm35 facts out of shape: {json.dumps(facts)}")
        return 2
    args.local = False

    def not_covered(why):
        answer(kube, "vm35", "skip", log)
        print(f"VM35_HOST=NOT_COVERED {why}")
        return 4

    def read(name, what):
        command = f"sudo incus exec {name} --project {project} -- {what}"
        code, output = run_command(args, command, timeout=args.read_timeout)
        log.entry(command, output, code)
        return output

    def vendor_data(name):
        command = f"sudo incus config get {name} cloud-init.vendor-data --project {project}"
        code, output = run_command(args, command, timeout=args.read_timeout)
        log.entry(command, output, code)
        return output if code == 0 else ""

    status = wait_cloud_init(args, log, project, vm, time.monotonic() + args.timeout_minutes * 60)
    if status is None:
        return not_covered(f"no 'status:' from cloud-init status --wait in {vm} in {args.timeout_minutes:g} minutes")
    hashed = shadow_hash(read(vm, "getent shadow ubuntu"))
    state = passwd_state(read(vm, "passwd -S ubuntu"))
    vendor = vendor_data(vm)
    locked = shadow_hash(read(without, "getent shadow ubuntu"))
    read(without, "passwd -S ubuntu")
    vendor_data(without)

    pod = kube.pod()
    expected = None
    salt = CRYPT6.match(hashed or "")
    if salt:
        out = kube.exec_pod("sh", "-c", POD_HASH, "sh", salt.group(1), secret)
        log.entry(f"kubectl exec -n {kube.ns} {pod} -- sh -c '{POD_HASH}' sh {salt.group(1)} {secret}",
                  out.stdout + out.stderr, out.returncode)
        if out.returncode != 0:
            return not_covered(f"openssl passwd in the pod: exit {out.returncode} {out.stderr.strip()[:200]}")
        expected = out.stdout.strip()
    out = kube.exec_pod("sh", "-c", POD_GREP, "sh", secret, input=vendor)
    log.entry(f"kubectl exec -i -n {kube.ns} {pod} -- sh -c '{POD_GREP}' sh {secret} < <cloud-init.vendor-data of {vm}>",
              out.stdout + out.stderr, out.returncode)
    matches = out.stdout.strip()
    if not matches.isdigit():
        return not_covered(f"grep in the pod: exit {out.returncode} {out.stderr.strip()[:200]}")

    problems = vm35_verdict(status, hashed, state, vendor, expected, matches, locked)
    answer(kube, "vm35", "go", log)
    if problems:
        print("VM35_HOST=FAIL " + "; ".join(problems))
        return 1
    print(f"VM35_HOST=PASS {vm}: $6$ hash of the password in /etc/shadow, passwd -S P, in vendor-data without the "
          f"password; {without}: locked")
    return 0


def wait_until_gone(args, kube, log, project, pool):
    """HOLD bak18-gone: the VM's copy holds a NIC on the spec's network until its upload ends (before that Incus refuses
    the network delete: "The network is currently in use"), and the same backup run copies the attached volume next
    (bkv<26>), during which a detach times out; so the spec cleans up only after both copies are gone."""
    deadline = time.monotonic() + 5 * 60
    while True:
        held = pending_hold(kube.logs())
        if held and held[0] == "bak18-gone":
            break
        if time.monotonic() >= deadline:
            print("no HOLD bak18-gone after 5 minutes")
            return
        time.sleep(POLL)
    facts = held[1]
    copies = [(facts["copy"], f"sudo incus query '/1.0/instances/{facts['copy']}?project={project}'")]
    if pool and facts.get("volumeCopy"):
        copies.append((facts["volumeCopy"], f"sudo incus query "
                       f"'/1.0/storage-pools/{pool}/volumes/custom/{facts['volumeCopy']}?project={project}'"))
    deadline = time.monotonic() + args.gone_timeout_minutes * 60
    for name, command in copies:
        while True:
            code, output = run_command(args, command)
            if code != 0:
                log.entry(command, output, code)
                print(f"{name} gone")
                break
            if time.monotonic() >= deadline:
                print(f"BAK18_COPY_STILL_THERE {name} after {args.gone_timeout_minutes} minutes: the spec's clean-up may fail")
                break
            time.sleep(POLL)
    answer(kube, "bak18-gone", "go", log)


def summaries(query, project, pool):
    """{object: one-line summary} of the project on the host: instances, networks, network ACLs, custom volumes with
    their snapshots, load balancers, image aliases (the objects Titan names); and the reads that failed."""
    lines, errors = {}, []

    def read(label, path):
        found, err = query(path)
        if err:
            errors.append(f"{label}: {err}")
        return found or []

    for i in read("instances", f"/1.0/instances?recursion=1&project={project}"):
        cfg, devices = i.get("config", {}), i.get("expanded_devices", {})
        nics = {k: v.get("network") for k, v in devices.items() if v.get("type") == "nic"}
        disks = {k: v.get("source") for k, v in devices.items() if v.get("type") == "disk" and v.get("path") != "/"}
        # a backup copy masks the volumes of its VM as `none` (BAK-18)
        none = sorted(k for k, v in devices.items() if v.get("type") == "none")
        lines[f"instance {i['name']}"] = (f"status={i.get('status')} type={i.get('type')} titan-name={cfg.get('user.titan-name')} "
                                          f"limits.cpu={cfg.get('limits.cpu')} limits.memory={cfg.get('limits.memory')} "
                                          f"nics={nics} disks={disks} none={none}")
    for n in read("networks", f"/1.0/networks?recursion=1&project={project}"):
        if not n.get("managed"):
            continue
        cfg = n.get("config", {})
        keep = {k: cfg.get(k) for k in ("network", "ipv4.address", "ipv4.nat", "ipv6.address", "ipv6.nat",
                                          "security.acls", "volatile.network.ipv6.address")}
        lines[f"network {n['name']}"] = f"type={n.get('type')} {keep} used_by={len(n.get('used_by') or [])}"
    for a in read("acls", f"/1.0/network-acls?recursion=1&project={project}"):
        rules = [f"{r.get('action')}:{r.get('protocol') or 'any'}:{r.get('source') or '-'}->{r.get('destination') or '-'}:"
                 f"{r.get('destination_port') or '-'}:{r.get('state')}" for r in a.get("ingress", [])]
        lines[f"acl {a['name']}"] = f"ingress={rules} egress_rules={len(a.get('egress', []))} used_by={len(a.get('used_by') or [])}"
    for v in read("volumes", f"/1.0/storage-pools/{pool}/volumes/custom?recursion=1&project={project}"):
        snaps, serr = query(f"/1.0/storage-pools/{pool}/volumes/custom/{v['name']}/snapshots?project={project}")
        names = sorted(x.rsplit("/", 1)[-1] for x in (snaps or []))
        lines[f"volume {v['name']}"] = (f"size={v.get('config', {}).get('size')} used_by={v.get('used_by')} "
                                        f"snapshots={names}{' snapshot-error=' + serr if serr else ''}")
    for net in read("network names", f"/1.0/networks?recursion=0&project={project}"):
        name = net.rsplit("/", 1)[-1].split("?")[0]
        if not name.startswith("net-"):
            continue
        for lb in read(f"load balancers of {name}", f"/1.0/networks/{name}/load-balancers?recursion=1&project={project}"):
            ports = [f"{x.get('protocol')}:{x.get('listen_port')}->{x.get('target_backend')}" for x in lb.get("ports", [])]
            backends = [f"{b.get('name')}={b.get('target_address')}:{b.get('target_port')}" for b in lb.get("backends", [])]
            lines[f"load-balancer {name}/{lb.get('listen_address')}"] = f"ports={ports} backends={backends}"
    for a in read("aliases", "/1.0/images/aliases?recursion=1"):
        image, ierr = query(f"/1.0/images/{a.get('target')}")
        arch = (image or {}).get("architecture")
        lines[f"alias {a['name']}"] = f"target={a.get('target')} type={a.get('type')} architecture={arch}{' image-error=' + ierr if ierr else ''}"
    return lines, errors


def changes(previous, current):
    """Lines for what differs from the previous sample: `GONE <object>`, or `<object> <summary>`."""
    out = []
    for key in sorted(set(previous) | set(current)):
        if key not in current:
            out.append(f"GONE {key}")
        elif previous.get(key) != current[key]:
            out.append(f"{key} {current[key]}")
    return out


def cmd_sample(args):
    args.local = False

    def query(path):
        try:
            code, output = run_command(args, f"sudo incus query '{path}'", timeout=args.read_timeout)
        except NoMaster as error:
            return None, str(error)
        if code != 0:
            return None, output.strip()
        try:
            return json.loads(output), None
        except json.JSONDecodeError as error:
            return None, f"not JSON: {error}"

    log = open(args.log, "a", encoding="utf-8")
    if log.tell() == 0:
        log.write(f"# phase4.py sample (ssh {args.target}, ControlMaster, project {args.project}, lane {args.lane}) · "
                  f"{args.target} · {now().strftime('%Y-%m-%dT%H:%M:%SZ')}\n")
    previous = {}
    while True:
        stamp = now().strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            current, errors = summaries(query, args.project, args.pool)
        except Exception as error:  # keep sampling; the failure is a line of the log, the last objects stand
            current, errors = previous, [f"sample failed: {type(error).__name__}: {error}"]
        for line in [f"ERROR {e}" for e in errors] + changes(previous, current) + [f"sample objects={len(current)}"]:
            log.write(f"{stamp} {line}\n")
        log.flush()
        previous = current
        if os.path.exists(args.stop):
            return 0
        time.sleep(args.every)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    def kube_args(p):
        p.add_argument("--kubeconfig", required=True)
        p.add_argument("--job", required=True)

    def ssh_opts(p, required=True):
        p.add_argument("--control", required=required)
        p.add_argument("--target", required=required)

    p = sub.add_parser("keys")
    p.add_argument("dir")
    p.set_defaults(func=cmd_keys)
    p = sub.add_parser("connect")
    ssh_opts(p)
    p.add_argument("--known-hosts", required=True)
    p.add_argument("--ssh-config")
    p.set_defaults(func=cmd_connect)
    p = sub.add_parser("disconnect")
    ssh_opts(p)
    p.set_defaults(func=cmd_disconnect)
    p = sub.add_parser("wait")
    kube_args(p)
    p.add_argument("--timeout-minutes", type=float, default=80)
    p.set_defaults(func=cmd_wait)
    for word in ("go", "skip"):
        p = sub.add_parser(word)
        p.add_argument("step")
        kube_args(p)
        p.add_argument("--log")
        p.set_defaults(func=cmd_answer, word=word)
    p = sub.add_parser("host")
    ssh_opts(p, required=False)
    p.add_argument("--local", action="store_true")
    p.add_argument("--log", required=True)
    p.add_argument("--keys")
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_host)
    p = sub.add_parser("sample")
    ssh_opts(p)
    p.add_argument("--project", required=True)
    p.add_argument("--every", type=float, default=30)
    p.add_argument("--stop", required=True)
    p.add_argument("--log", required=True)
    p.add_argument("--pool", default="default")
    p.add_argument("--read-timeout", type=float, default=60)
    p.add_argument("--lane", default="sequential", help="a or b in a run of two lanes, for the log's first line")
    p.set_defaults(func=cmd_sample)
    p = sub.add_parser("bak18")
    kube_args(p)
    ssh_opts(p)
    p.add_argument("--log", required=True)
    # under the spec's holds (60 and 12 minutes), when bak18 starts within a minute or two of HOLD bak18
    p.add_argument("--timeout-minutes", type=float, default=58)
    p.add_argument("--gone-timeout-minutes", type=float, default=11)
    p.set_defaults(func=cmd_bak18)
    p = sub.add_parser("vm35")
    kube_args(p)
    ssh_opts(p)
    p.add_argument("--log", required=True)
    # under the spec's hold (45 minutes); the console password is in /etc/shadow after cloud-init's final stage
    p.add_argument("--timeout-minutes", type=float, default=30)
    p.add_argument("--read-timeout", type=float, default=60)
    p.set_defaults(func=cmd_vm35)

    args = parser.parse_args(argv)
    if not hasattr(args, "local"):
        args.local = False
    if args.func is cmd_host:
        if args.command[:1] == ["--"]:
            args.command = args.command[1:]
        if not args.command or (not args.local and not (args.control and args.target)):
            parser.error("host wants --control and --target (or --local) and a command after --")
    try:
        return args.func(args)
    except NoMaster as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
