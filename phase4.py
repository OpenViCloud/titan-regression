#!/usr/bin/env python3
"""The agent's side of Phase 4 (phase4/): each step one command, so nobody writes a shell loop by hand.

A Phase 4 spec logs `HOLD <step> <facts JSON>` and waits for /work/results/go-<step> (or skip-<step>) in its pod; the
agent does the step's host commands in between. Every host command and every answer goes to a log of the release's
evidence as `[HH:MM:SSZ]` / `$ <command>` / output / `exit=<n>`.

    python3 phase4.py keys <dir>                      # key pairs v, u, x (ed25519, no passphrase); an existing pair is kept
    python3 phase4.py connect --control <socket> --target <user@host> --known-hosts <file> [--ssh-config <file>]
    python3 phase4.py wait --kubeconfig <kc> --job <job> [--timeout-minutes 80]   # prints the pending HOLD
    python3 phase4.py go|skip <step> --kubeconfig <kc> --job <job> [--log <file>] # answers it, returns once the spec has
    python3 phase4.py host --control <socket> --target <user@host> --log <file> [--keys <dir>] -- '<command>'
    python3 phase4.py host --local --log <file> [--keys <dir>] -- '<command>'      # same entry, on this machine
    python3 phase4.py vm35 --kubeconfig <kc> --job <job> --control <socket> --target <user@host> --log <file>
    python3 phase4.py sample --control <socket> --target <user@host> --project <t-…> --stop <file> --log <file> [--every 30]
                              [--read-timeout 60] [--lane a|b, default sequential]
    python3 phase4.py step <step> [--kubeconfig <kc> --job <job>] --control <socket> --target <user@host> --log <file>
                              --state <file> [--keys <dir>] [--guest-known-hosts <file>] [--api <url>]
                              [--env release|dev] [--project <t-…>] [--no-go]
    python3 phase4.py cli10 --kubeconfig <kc> --job <job> --cli <openvicloud> --api <url> --log <file> [--seconds 330]
    python3 phase4.py bak20 --kubeconfig <kc> --job <job> --log <file> [--every 3] [--leased-minutes 30] [--watch-minutes 45]
    python3 phase4.py bak22 --kubeconfig <kc> --job <job> --log <file> [--every 5] [--gate-minutes 8] [--backup-minutes 15]
                              [--settle-minutes 6] [--config-minutes 4] [--read-minutes 12] [--job-minutes 2] [--hold-minutes 40]
    python3 phase4.py disconnect --control <socket> --target <user@host>

<job> is the name run-module.sh gives the job (regression-<module>-<label>). The host command runs through the
ControlMaster socket with stdin closed and BatchMode on, and only when `ssh -O check` finds the master (else exit 2: no
connection of its own, which would read the default known_hosts); `{V}`, `{U}`, `{X}` in a command become the
base64 body of <keys>/v.pub, u.pub, x.pub (public halves only). A host command's exit code is this script's.

vm35 (VM-35, titan-ops features/vm/design.md#console-password) answers HOLD vm35 of phase4/: it waits on the host for
`cloud-init status --wait` of the held VM to print a `status:` line (FAIL unless it is `done`), reads `getent shadow ubuntu`, `passwd -S ubuntu` and
`cloud-init.vendor-data` of it and of the held VM without a console password, then, in the pod, hashes the password
file the spec left there with `openssl passwd -6` and the salt read from the shadow and greps the vendor-data for it:
the password never leaves the pod, so it is in no log, no argv and no file here. Last line VM35_HOST=PASS (exit 0) |
FAIL <what> (exit 1, go-vm35) | NOT_COVERED <why> (exit 4, skip-vm35: no `status:` from cloud-init before the timeout,
or the pod could not hash or grep).

sample reads the project every <every> seconds, read-only, and logs a line per object only when its summary changed
(`GONE <object>` when it left), then `sample objects=<n>`; a failed read (or one with no answer in --read-timeout
seconds) is an `ERROR` line, a sample that breaks is one `ERROR` line, and sampling goes on; it ends after the sample
that finds <stop>.

step runs the commands phase4_steps.py lists for that HOLD (README §Phase 4), each logged like host, then answers
go-<step>; with --no-go it exits 0 and the agent answers; a host write that failed stops it with exit 1 and no answer.
cln02 has no HOLD. cli10 answers HOLD cli10 of cli/edge: the session of CLI-10 from this machine, the token only in
OPENVICLOUD_TOKEN; last line L_CLI10=PASS (exit 0, go) | FAIL <what> (exit 1, go) | NOT_COVERED <why> (exit 4,
skip-cli10: the token or the key could not be copied out of the pod).

bak20 answers HOLD bak20 of backup/command-wait (BAK-20, titan-ops features/provider/design.md#tenant-lane): it reads the
held VM's rows of core.provider_commands (psql SELECT in the titan-db primary pod, read only), creates a Job from CronJob
control-plane-job-backup-schedule when today's vm.backup row of the VM is not there yet, answers go-bak20 once that row is
Leased, then reads the rows every <every> seconds (logged when they change) until the backup and the snapshot's
vm-snapshot.create row have ended or 600 s after the backup ended, and deletes the Job it created. Last line
L_BAK20=PASS (exit 0: the snapshot's row read Pending with attempts 0 every time the backup was Leased, then both Done) | FAIL <what> (exit 1) | NOT_COVERED <why>
(exit 4; skip-bak20 when it comes before the answer: core.provider_commands could not be read, today's backup of the
VM already ended, the Job could not be created, the backup was not seen Leased in time; after go: no read had the snapshot's row while the backup was Leased).

bak22 answers HOLD bak22 of backup/config-again (BAK-22 and BAK-23, titan-ops features/backup/design.md#cluster-backup):
it reads the held cluster's backup rows of the UTC day in core.provider_commands (vm.backup, volume.backup,
cluster.backup, restore.drill; psql SELECT in the titan-db primary pod, read only, the database's clock on every line),
creates a first Job from CronJob control-plane-job-backup-schedule (the pass that queues the held VM's backup), waits
for that backup to be Done and for every disk backup and config of the day to have ended, creates a second Job (the
pass that queues the config of that UTC hour) and answers go-bak22 once that config is Done; then it reads the
cluster's rows of core.backups at the first read of the bucket after that (core.backup_observations) and deletes the
Jobs it created. It creates a Job only from minute 3 of an hour, while the CronJob has no Job running, and with
--job-minutes and one more before the next hour (the CronJob's own pass is due at minute 0, may start 120 s late and
retries its pod): it reads on until then (--gate-minutes before the first Job, --settle-minutes before the second).
It creates no Job when the waits after it could outlast the spec's (--hold-minutes after the HOLD line), and a go the
spec does not take is NOT_COVERED. Last lines L_BAK22= then L_BAK23=, each PASS | FAIL <what> | NOT_COVERED <why>;
exit 1 when one is FAIL, else 4 when one is NOT_COVERED, else 0. Before the go every verdict answers skip-bak22 (the
spec then deletes its VM), and L_BAK23 is NOT_COVERED. A Job that failed (its curl got an error from the pass, or
did not reach the control plane) is a FAIL. An error of the command itself after the hold was read deletes the Jobs
and ends NOT_COVERED (exit 4): before the go it answers skip-bak22 and both lines are NOT_COVERED, after it L_BAK22
keeps its PASS; facts out of shape answer skip-bak22 and exit 2.

Exit 2: usage, the pending HOLD is not the step asked for, or no ControlMaster on the socket. wait: exit 3 = the runner finished with no HOLD pending.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phase4_steps  # noqa: E402

POLL = float(os.environ.get("PHASE4_POLL_SECONDS", "10"))
HOLD = re.compile(r"^\S+ HOLD (\S+) (\{.*\})\s*$")
ANSWER = re.compile(r"^\S+ (GO|SKIP) (\S+)\s*$")


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


def wait_for(kube, step, minutes):
    """The facts of the pending HOLD once it is step; None (printed why) when another step or nothing is pending."""
    deadline = time.monotonic() + minutes * 60
    kube.pod(wait_until=deadline)
    while True:
        held = pending_hold(kube.logs())
        if held:
            if held[0] != step:
                print(f"the pending HOLD is {held[0]}, not {step}")
                return None
            return held[1]
        if time.monotonic() >= deadline:
            print(f"no HOLD {step} after {minutes:g} minutes")
            return None
        time.sleep(POLL)


def run_step_command(args, cmd, values, log):
    """One command of a step: rendered, run where it belongs, logged; (exit code, output)."""
    text = phase4_steps.render(cmd.text, values)
    local = args.local or (cmd.outside and args.env == "release")
    command = substitute(text, args.keys)
    where = types.SimpleNamespace(local=local, control=args.control, target=args.target)
    deadline = time.monotonic() + (cmd.timeout or 0)
    while True:
        code, output = run_command(where, command, timeout=args.read_timeout)
        done = cmd.until is None or cmd.until(code, output, values) or time.monotonic() >= deadline
        if done:
            break
        time.sleep(POLL)
    log.entry(("(this machine) " if local else "") + text, output, code)
    sys.stdout.write(output)
    return code, output


def cmd_step(args):
    """The host commands of one HOLD step of phase4/ (phase4_steps.py), then go-<step> unless --no-go."""
    if args.step not in phase4_steps.STEPS:
        print(f"no step {args.step} in phase4_steps.py")
        return 2
    state_path = args.state
    state = phase4_steps.load_state(state_path)
    kube = None
    if args.step == "cln02":
        facts = dict(state.get("setup", {}))
    else:
        if not (args.kubeconfig and args.job):
            print(f"step {args.step} wants --kubeconfig and --job")
            return 2
        kube = Kube(args.kubeconfig, args.job)
        held = wait_for(kube, args.step, args.timeout_minutes)
        if held is None:
            return 2
        if args.step == "setup":
            state["setup"], state["recorded"] = held, {}
            phase4_steps.save_state(state_path, state)
        facts = {**state.get("setup", {}), **held}
    if args.project:
        facts["project"] = args.project
    options = {"env": args.env, "api": args.api, "keys": args.keys, "guestKnownHosts": args.guest_known_hosts}
    where = "this machine" if args.local else args.target
    log = Log(args.log, f"phase4.py step {args.step} ({args.env}) · {where}")
    recorded = state.setdefault("recorded", {})
    commands = phase4_steps.STEPS[args.step](facts, options)
    known = {**facts, **{k: v for k, v in options.items() if v is not None}, **{k: "" for k in phase4_steps.RECORDED}}
    for cmd in commands:
        try:
            phase4_steps.render(cmd.text, known)
        except KeyError as missing:
            print(f"step {args.step} needs {missing.args[0]} (a fact of its HOLD or setup's, or an option): nothing run")
            return 2
        if not args.keys and any("{" + k + "}" in cmd.text for k in phase4_steps.KEY_TOKENS):
            print(f"step {args.step} needs --keys (its commands read the keys V, U, X): nothing run")
            return 2
    for cmd in commands:
        values = {**facts, **{k: v for k, v in options.items() if v is not None}, **recorded}
        why = cmd.when(recorded) if cmd.when else None
        if why:
            log.entry(cmd.text, f"skipped: {why}", 0)
            print(f"skipped: {why}")
            continue
        code, output = run_step_command(args, cmd, values, log)
        if cmd.record:
            recorded.update(cmd.record(code, output))
            phase4_steps.save_state(state_path, state)
        if cmd.write and code != 0:
            print(f"a write of step {args.step} failed (exit {code}): no answer; go, or skip when it did not happen")
            return 1
    if kube is None or args.no_go:
        return 0
    return answer(kube, args.step, "go", log)


def cmd_cli10(args):
    """CLI-10 at HOLD cli10 of cli/edge: a `vm ssh` session from this machine, the token never in argv or a log."""
    kube = Kube(args.kubeconfig, args.job)
    facts = wait_for(kube, "cli10", args.timeout_minutes)
    if facts is None:
        return 2
    log = Log(args.log, f"phase4.py cli10 · job {args.job} · {args.api}")
    work = tempfile.mkdtemp(prefix="cli10-")
    try:
        files = {}
        for name in ("token", "key"):
            files[name] = os.path.join(work, name)
            out = kube.run("-n", kube.ns, "cp", f"{kube.pod()}:{facts[name]}", files[name])
            size = os.path.getsize(files[name]) if os.path.exists(files[name]) else 0
            log.entry(f"kubectl cp {kube.pod()}:{facts[name]} {files[name]}", f"{name} bytes={size}\n{out.stderr}",
                      out.returncode)
            if out.returncode != 0 or size == 0:
                verdict = f"L_CLI10=NOT_COVERED could not copy {facts[name]} out of the pod"
                answered = answer(kube, "cli10", "skip", log)
                with open(args.log, "a", encoding="utf-8") as fh:
                    fh.write(verdict + "\n")
                print(verdict)
                return answered or 4
            os.chmod(files[name], 0o600)
        with open(files["token"], encoding="utf-8") as fh:
            token = fh.read().strip()
        os.makedirs(os.path.join(work, "config"), mode=0o700)
        env = {**os.environ, "OPENVICLOUD_TOKEN": token, "OPENVICLOUD_API_URL": args.api,
               "XDG_CONFIG_HOME": os.path.join(work, "config")}
        remote = f"sleep {args.seconds}; echo alive"
        argv = [args.cli, "vm", "ssh", facts["vmName"], "--", "-i", files["key"], "-o", "IdentitiesOnly=yes", "-o",
                "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o",
                f"UserKnownHostsFile={os.path.join(work, 'known_hosts')}", remote]
        started = time.monotonic()
        try:
            run = subprocess.run(argv, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                                 timeout=args.seconds + 90)
            code, output = run.returncode, run.stdout + run.stderr
        except subprocess.TimeoutExpired:
            code, output = 124, f"no end in {args.seconds + 90} s"
        seconds = time.monotonic() - started
        shown = " ".join(argv[:-1]) + f" '{remote}'"
        log.entry(f"OPENVICLOUD_TOKEN=<the token file> OPENVICLOUD_API_URL={args.api} XDG_CONFIG_HOME=<empty> {shown}",
                  output.replace(token, "<token>") + f"seconds={seconds:.0f}", code)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if code == 0 and "alive" in output and seconds >= args.seconds:
        verdict = "L_CLI10=PASS"
    else:
        verdict = f"L_CLI10=FAIL exit={code} alive={'alive' in output} seconds={seconds:.0f}"
    answered = answer(kube, "cli10", "go", log)
    with open(args.log, "a", encoding="utf-8") as fh:
        fh.write(verdict + "\n")
    print(verdict)
    if answered != 0:
        return answered
    return 0 if verdict.endswith("PASS") else 1


BACKUP_CRONJOB = "control-plane-job-backup-schedule"
SNAPSHOT_CREATE = "vm-snapshot.create"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PG_PRIMARY = "cnpg.io/cluster=titan-db,cnpg.io/instanceRole=primary"
ENDED = ("Done", "Failed")


def command_rows(text):
    """[(kind, key, status, attempts)] of `psql -At -F '|'` output of COMMANDS_OF."""
    rows = []
    for line in text.splitlines():
        parts = line.split("|")
        if len(parts) == 4 and parts[3].strip().isdigit():
            rows.append((parts[0], parts[1], parts[2], int(parts[3])))
    return rows


def commands_of(vm_id):
    """The SELECT of the VM's command rows; the id is checked against UUID before it reaches SQL."""
    return ("SELECT kind, key, status, attempts FROM core.provider_commands "
            f"WHERE resource_id = '{vm_id}' ORDER BY created_at, key")


def backup_of(rows, key):
    return next((r for r in rows if r[1] == key), None)


def snapshots_of(rows):
    return [r for r in rows if r[0] == SNAPSHOT_CREATE]


def bak20_verdict(readings, key):
    """(word, why) of BAK-20's SQL part from the readings taken after go-bak20 (each a list of command_rows)."""
    leased = [r for r in readings if (backup_of(r, key) or (None, None, None))[2] == "Leased" and snapshots_of(r)]
    for rows in leased:
        for _, snap_key, status, attempts in snapshots_of(rows):
            if status != "Pending" or attempts != 0:
                return "FAIL", f"{snap_key} {status} attempts={attempts} while the backup was Leased"
    last = readings[-1] if readings else []
    backup = backup_of(last, key)
    if backup is None or backup[2] != "Done":
        return "FAIL", f"the backup ended {backup[2] if backup else 'without a row'}, not Done"
    snaps = snapshots_of(last)
    if not snaps:
        return "FAIL", "no vm-snapshot.create row of the VM: the spec's POST did not land"
    if snaps[-1][2] != "Done":
        return "FAIL", f"{snaps[-1][1]} ended {snaps[-1][2]}, not Done"
    if not leased:
        return "NOT_COVERED", "no read had the snapshot's row while the backup was Leased (the backup ended first)"
    return "PASS", f"readings={len(leased)} with the snapshot's row Pending attempts=0 while the backup was Leased"


def cmd_bak20(args):
    """BAK-20 at HOLD bak20 of backup/command-wait: the backup made Leased, then the snapshot's row read while it is."""
    kube = Kube(args.kubeconfig, args.job)
    facts = wait_for(kube, "bak20", args.timeout_minutes)
    if facts is None:
        return 2
    vm_id, key = facts.get("vmId", ""), facts.get("backupKey", "")
    if not UUID.match(vm_id) or not re.match(rf"^vm-backup-{re.escape(vm_id)}-\d{{8}}$", key):
        print(f"HOLD bak20 facts out of shape: vmId={vm_id!r} backupKey={key!r}")
        return 2
    log = Log(args.log, f"phase4.py bak20 · job {args.job}")
    cp_ns = kube.namespace_of("cronjob", BACKUP_CRONJOB)
    primaries = kube.json("get", "pods", "-A", "-l", PG_PRIMARY)["items"]
    if len(primaries) != 1:
        print(f"not exactly one pod {PG_PRIMARY} on this cluster")
        return 2
    pg_ns, pg_pod = primaries[0]["metadata"]["namespace"], primaries[0]["metadata"]["name"]
    sql = commands_of(vm_id)
    shown = f"kubectl exec -n {pg_ns} {pg_pod} -c postgres -- psql -U postgres -d titan -At -F '|' -c \"{sql}\""
    last = {"text": None}

    def read():
        out = kube.run("exec", "-n", pg_ns, pg_pod, "-c", "postgres", "--", "psql", "-U", "postgres", "-d", "titan",
                       "-At", "-F", "|", "-c", sql)
        text = out.stdout + out.stderr
        if text != last["text"] or out.returncode != 0:
            log.entry(shown, text, out.returncode)
            sys.stdout.write(text)
            last["text"] = text
        return command_rows(out.stdout) if out.returncode == 0 else None

    job = None

    def finish(word, why, answer_skip=False):
        if answer_skip:
            answer(kube, "bak20", "skip", log)
        if job:
            out = kube.run("delete", "job", job, "-n", cp_ns, "--ignore-not-found")
            log.entry(f"kubectl delete job {job} -n {cp_ns}", out.stdout + out.stderr, out.returncode)
        verdict = f"L_BAK20={word}" + (f" {why}" if why else "")
        with open(args.log, "a", encoding="utf-8") as fh:
            fh.write(verdict + "\n")
        print(verdict)
        return {"PASS": 0, "FAIL": 1}.get(word, 4)

    rows = read()
    if rows is None:
        return finish("NOT_COVERED", "could not read core.provider_commands", answer_skip=True)
    backup = backup_of(rows, key)
    if backup and backup[2] in ENDED:
        return finish("NOT_COVERED", f"today's backup of the VM is already {backup[2]}", answer_skip=True)
    if backup is None:
        job = f"rg-bak20-{int(time.time())}"
        out = kube.run("create", "job", job, f"--from=cronjob/{BACKUP_CRONJOB}", "-n", cp_ns)
        log.entry(f"kubectl create job {job} --from=cronjob/{BACKUP_CRONJOB} -n {cp_ns}", out.stdout + out.stderr,
                  out.returncode)
        if out.returncode != 0:
            job = None
            return finish("NOT_COVERED", f"could not create a Job from CronJob {BACKUP_CRONJOB}", answer_skip=True)
    deadline = time.monotonic() + args.leased_minutes * 60
    while True:
        status = (backup_of(rows or [], key) or (None, None, "absent"))[2]
        if status == "Leased":
            break
        if status in ENDED:
            return finish("NOT_COVERED", f"the backup ended {status} before a read saw it Leased", answer_skip=True)
        if time.monotonic() >= deadline:
            return finish("NOT_COVERED", f"the backup was not Leased in {args.leased_minutes:g} minutes ({status})",
                          answer_skip=True)
        time.sleep(args.every)
        rows = read()
    said = answer(kube, "bak20", "go", log)
    if said != 0:
        return finish("FAIL", "the spec did not take go-bak20")
    readings, backup_ended_at = [], None
    deadline = time.monotonic() + args.watch_minutes * 60
    while time.monotonic() < deadline:
        time.sleep(args.every)
        rows = read()
        if rows is None:
            continue
        readings.append(rows)
        backup = backup_of(rows, key)
        snaps = snapshots_of(rows)
        if backup and backup[2] in ENDED:
            backup_ended_at = backup_ended_at or time.monotonic()
            if (snaps and snaps[-1][2] in ENDED) or time.monotonic() - backup_ended_at > 600:
                break
    return finish(*bak20_verdict(readings, key))


CLUSTER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,62}$")
# what `new Date(...).toISOString()` of the spec gives
ISO_MS = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
DISK_BACKUPS = ("vm.backup", "volume.backup")
CONFIG_BACKUP = "cluster.backup"
WAITING = ("Pending", "Leased")
# OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Backup/BackupLayout.cs (ConfigDaysKept)
CONFIG_DAYS_KEPT = 7
# OpenViCloud/titan-local-cluster:base/control-plane/scheduled-jobs.yaml (control-plane-job-backup-schedule): the
# CronJob's own pass is due at minute 0 and may still be created up to startingDeadlineSeconds (120 s) later, and its pod
# is retried (backoffLimit 2) while the Job runs. A Job of the agent beside it could not be told from it in the rows, so
# the agent creates one only from minute 3, while the CronJob has no Job running, and with time for the pass before
# the next hour.
FIRST_JOB_MINUTE = 3


def backup_rows_of(cluster_id, day):
    """The SELECT of the cluster's backup, config and drill rows of the UTC day; both values are checked before SQL.

    One line at least, each led by the database's clock: with no row the join leaves the other fields empty."""
    return ("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'), c.kind, c.key, c.status, c.attempts, "
            "to_char(c.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS.US'), "
            "regexp_replace(left(coalesce(c.last_error, ''), 200), '[[:cntrl:]|]', ' ', 'g') "
            "FROM (SELECT 1) AS one LEFT JOIN core.provider_commands c "
            f"ON c.cluster_id = '{cluster_id}' "
            "AND c.kind IN ('vm.backup', 'volume.backup', 'cluster.backup', 'restore.drill') "
            f"AND c.key ~ '-{day}([0-9][0-9])?$' ORDER BY c.created_at, c.key")


def backup_rows(text):
    """(the database's clock as yyyyMMddHHmmss, [row]) of backup_rows_of's output; (None, []) when no line has the shape."""
    clock, rows = None, []
    for line in text.split("\n"):
        parts = line.split("|")
        if len(parts) != 7 or not re.fullmatch(r"\d{14}", parts[0]):
            continue
        clock = parts[0]
        if parts[2]:
            rows.append(types.SimpleNamespace(kind=parts[1], key=parts[2], status=parts[3],
                                              attempts=int(parts[4] or 0), created=parts[5], error=parts[6]))
    return clock, rows


def config_copies_of(cluster_id):
    """The SELECT of the cluster's config rows of core.backups, each led by the clock and the last read of incus/."""
    return ("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'), o.outcome, "
            "to_char(o.last_read_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'), coalesce(b.backup_key, ''), "
            "coalesce(to_char(b.taken_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'), '') "
            "FROM core.backup_observations o LEFT JOIN core.backups b "
            f"ON b.kind = 'cluster' AND b.resource_name = '{cluster_id}' "
            "WHERE o.kind = 'incus' AND o.resource_name = 'disks' ORDER BY b.taken_at")


def config_copies(text):
    """(clock, outcome, last read, [(taken, backup key)]) of config_copies_of's output; None before the first read of incus/."""
    clock = outcome = read_at = None
    copies = []
    for line in text.split("\n"):
        parts = line.split("|")
        if len(parts) != 5 or not re.fullmatch(r"\d{14}", parts[0]) or not re.fullmatch(r"\d{14}", parts[2]):
            continue
        clock, outcome, read_at = parts[0], parts[1], parts[2]
        if parts[3]:
            copies.append((parts[4], parts[3]))
    return (clock, outcome, read_at, copies) if clock else None


def clear_of_the_hourly_pass(clock, job_minutes):
    """True from minute 3 of the hour while a Job and its pass still end before the next hour (clock: yyyyMMddHHmmss)."""
    seconds = int(clock[10:12]) * 60 + int(clock[12:14])
    return FIRST_JOB_MINUTE * 60 <= seconds <= 3600 - (job_minutes + 1) * 60


def hold_started(text, step):
    """The time of the last `HOLD <step>` line of the spec's log, else None."""
    started = None
    for line in text.splitlines():
        m = HOLD.match(line)
        if m and m.group(1) == step:
            try:
                started = datetime.datetime.strptime(line.split(" ", 1)[0], "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                    tzinfo=datetime.timezone.utc)
            except ValueError:
                started = None
    return started


def bak23_verdict(copies, day, after):
    """(word, why) of BAK-23 from the cluster's config rows after a read of the bucket: [(taken yyyyMMddHHmmss, key)].

    after: the creation time of the held VM's backup row; the config the second Job asked was taken later."""
    by_day = {}
    for taken, key in copies:
        by_day.setdefault(taken[:8], []).append((taken, key))
    today = by_day.get(day, [])
    if len(today) != 1:
        return "FAIL", f"{len(today)} config rows of {day}, not one: {' '.join(key for _, key in sorted(today)) or 'none'}"
    crowded = sorted(d for d, found in by_day.items() if len(found) > 1)
    if crowded:
        return "FAIL", f"more than one config row on {' '.join(crowded)}"
    if len(by_day) > CONFIG_DAYS_KEPT:
        return "FAIL", f"config rows of {len(by_day)} UTC days, more than {CONFIG_DAYS_KEPT}"
    taken, key = today[0]
    if (taken, key) != max(copies):
        return "FAIL", f"today's row {key} is not the newest: {max(copies)[1]}"
    if taken <= after[:14]:
        return "FAIL", f"today's row {key} is not later than the VM's backup row ({after}): the config asked after it is not the one kept"
    return "PASS", f"days={len(by_day)} today={key}"


def cmd_bak22(args):
    """BAK-22 and BAK-23 at HOLD bak22 of backup/config-again: two passes of the backup schedule around the held VM's backup."""
    kube = Kube(args.kubeconfig, args.job)
    facts = wait_for(kube, "bak22", args.timeout_minutes)
    if facts is None:
        return 2
    run = types.SimpleNamespace(jobs=[], answered=False, verdict=None, log=None, cp_ns=None, passed=None)
    try:
        return bak22(args, kube, facts, run)
    except (Exception, SystemExit) as error:
        if run.verdict is not None:
            raise
        why = f"the command stopped: {error}"
        print(why, file=sys.stderr)
        if run.passed:
            return bak22_finish(args, kube, run, "PASS", run.passed, "NOT_COVERED", why)
        return bak22_finish(args, kube, run, "NOT_COVERED", why)
    finally:
        if not run.answered:
            # the spec would otherwise hold its VM for the rest of its wait
            answer(kube, "bak22", "skip", run.log or Log(None, ""))
            run.answered = True
        for name in run.jobs:
            out = kube.run("delete", "job", name, "-n", run.cp_ns, "--ignore-not-found")
            if run.log:
                run.log.entry(f"kubectl delete job {name} -n {run.cp_ns}", out.stdout + out.stderr, out.returncode)
        run.jobs = []


def bak22_finish(args, kube, run, word22, why22, word23="NOT_COVERED", why23="BAK-22 did not pass before it"):
    """Answers skip-bak22 unless go was given, deletes the Jobs, writes and prints L_BAK22= and L_BAK23=; the exit code."""
    if not run.answered:
        answer(kube, "bak22", "skip", run.log or Log(None, ""))
        run.answered = True
    for name in run.jobs:
        out = kube.run("delete", "job", name, "-n", run.cp_ns, "--ignore-not-found")
        if run.log:
            run.log.entry(f"kubectl delete job {name} -n {run.cp_ns}", out.stdout + out.stderr, out.returncode)
    run.jobs = []
    run.verdict = [f"L_BAK22={word22} {why22}", f"L_BAK23={word23} {why23}"]
    if args.log:
        with open(args.log, "a", encoding="utf-8") as fh:
            fh.write("\n".join(run.verdict) + "\n")
    print("\n".join(run.verdict))
    words = (word22, word23)
    return 1 if "FAIL" in words else 4 if "NOT_COVERED" in words else 0


def bak22(args, kube, facts, run):
    vm_id, cluster_id, key, vm_created = (str(facts.get(k, "")) for k in ("vmId", "clusterId", "backupKey", "vmCreatedAt"))
    if (not UUID.match(vm_id) or not CLUSTER_ID.match(cluster_id) or not ISO_MS.match(vm_created)
            or not re.match(rf"^vm-backup-{re.escape(vm_id)}-\d{{8}}$", key)):
        print(f"HOLD bak22 facts out of shape: vmId={vm_id!r} clusterId={cluster_id!r} backupKey={key!r} vmCreatedAt={vm_created!r}")
        answer(kube, "bak22", "skip", Log(None, ""))
        run.answered = True
        return 2
    day = key[-8:]
    # as created_at is read: yyyyMMddHHmmss.ffffff
    vm_made = re.sub(r"[-T:Z]", "", vm_created) + "000"
    # the spec stops waiting HOLD_AGENT_MS after its HOLD line, stamped by the runner pod's clock; now() is this machine's
    held_at = hold_started(kube.logs(), "bak22") or now()
    gives_up_at = held_at + datetime.timedelta(minutes=args.hold_minutes)
    log = run.log = Log(args.log, f"phase4.py bak22 · job {args.job}")
    run.cp_ns = kube.namespace_of("cronjob", BACKUP_CRONJOB)
    primaries = kube.json("get", "pods", "-A", "-l", PG_PRIMARY)["items"]
    if len(primaries) != 1:
        print(f"not exactly one pod {PG_PRIMARY} on this cluster")
        return bak22_finish(args, kube, run, "NOT_COVERED", f"not exactly one pod {PG_PRIMARY} on this cluster")
    pg_ns, pg_pod = primaries[0]["metadata"]["namespace"], primaries[0]["metadata"]["name"]
    rows_sql, copies_sql = backup_rows_of(cluster_id, day), config_copies_of(cluster_id)
    seen = {}

    def finish(*verdict):
        return bak22_finish(args, kube, run, *verdict)

    def skip(why):
        return finish("NOT_COVERED", why)

    def psql(sql):
        out = kube.run("exec", "-n", pg_ns, pg_pod, "-c", "postgres", "--", "psql", "-U", "postgres", "-d", "titan",
                       "-At", "-F", "|", "-c", sql)
        text = out.stdout + out.stderr
        # the first field is the clock: a read is logged when anything after it changed, a failure too
        body = f"exit={out.returncode}\n" + "\n".join(line.partition("|")[2] for line in text.split("\n"))
        if body != seen.get(sql):
            shown = f"kubectl exec -n {pg_ns} {pg_pod} -c postgres -- psql -U postgres -d titan -At -F '|' -c \"{sql}\""
            log.entry(shown, text, out.returncode)
            sys.stdout.write(text if text.endswith("\n") or not text else text + "\n")
            seen[sql] = body
        return out.stdout if out.returncode == 0 else None

    def decided(what, clock):
        """The clock of a read a step was decided on: in the log even when the rows did not change."""
        log.entry(f"# {what}", f"database clock {clock}", 0)

    def read_until(done, minutes, stop_on_failure=False):
        """(clock, rows, True) of the first read done accepts, else the last read and False; rows None when it failed.

        With stop_on_failure the call's first read failing ends it at once; any other failed read is read again."""
        deadline = time.monotonic() + minutes * 60
        first = True
        while True:
            text = psql(rows_sql)
            clock, rows = backup_rows(text) if text is not None else (None, [])
            if clock and done(clock, rows):
                return clock, rows, True
            if time.monotonic() >= deadline or (stop_on_failure and first and not clock):
                return clock, (rows if clock else None), False
            first = False
            time.sleep(args.every)

    def cronjob_idle():
        out = kube.run("get", "cronjob", BACKUP_CRONJOB, "-n", run.cp_ns, "-o", "json")
        try:
            active = json.loads(out.stdout).get("status", {}).get("active") if out.returncode == 0 else ["unknown"]
        except ValueError:
            active = ["unknown"]
        if active:
            log.entry(f"kubectl get cronjob {BACKUP_CRONJOB} -n {run.cp_ns} -o json  # .status.active",
                      json.dumps(active), out.returncode)
        return not active

    def gate(clock, rows):
        return clear_of_the_hourly_pass(clock, args.job_minutes) and cronjob_idle()

    def time_left(minutes):
        return now() + datetime.timedelta(minutes=minutes) < gives_up_at

    def run_pass(suffix):
        """(None, None) once a Job from the CronJob has run one pass of the schedule, else (why, the verdict word)."""
        name = f"rg-bak22{suffix}-{int(time.time())}"
        out = kube.run("create", "job", name, f"--from=cronjob/{BACKUP_CRONJOB}", "-n", run.cp_ns)
        log.entry(f"kubectl create job {name} --from=cronjob/{BACKUP_CRONJOB} -n {run.cp_ns}", out.stdout + out.stderr,
                  out.returncode)
        if out.returncode != 0:
            return f"could not create a Job from CronJob {BACKUP_CRONJOB}", "NOT_COVERED"
        run.jobs.append(name)
        deadline = time.monotonic() + args.job_minutes * 60
        while True:
            out = kube.run("get", "job", name, "-n", run.cp_ns, "-o", "json")
            try:
                status = json.loads(out.stdout).get("status", {}) if out.returncode == 0 else {}
            except ValueError:
                status = {}
            failed = any(c.get("type") == "Failed" and c.get("status") == "True" for c in status.get("conditions", []))
            if status.get("succeeded") or failed or time.monotonic() >= deadline:
                log.entry(f"kubectl get job {name} -n {run.cp_ns} -o json  # .status", json.dumps(status), out.returncode)
                if status.get("succeeded"):
                    return None, None
                if failed:
                    logs = kube.run("logs", f"job/{name}", "-n", run.cp_ns, "--tail", "5")
                    log.entry(f"kubectl logs job/{name} -n {run.cp_ns} --tail 5", logs.stdout + logs.stderr, logs.returncode)
                    return (f"Job {name} failed ({status.get('failed', 0)} pods): its curl got an error from the pass of the schedule, "
                            "or did not reach the control plane"), "FAIL"
                return f"Job {name} did not complete in {args.job_minutes:g} minutes", "NOT_COVERED"
            time.sleep(args.every)

    def of_kind(rows, *kinds):
        return [r for r in rows if r.kind in kinds]

    def named(rows):
        return " ".join(f"{r.key}={r.status}" for r in rows) or "none"

    def waiting_disks(rows):
        return [r for r in of_kind(rows, *DISK_BACKUPS) if r.status in WAITING and r.key != key]

    # --- before the first Job: the day has a config that is Done, made before the VM, and nothing knows the VM yet
    clock, rows, clear = read_until(gate, args.gate_minutes, stop_on_failure=True)
    if rows is None:
        return skip("could not read core.provider_commands")
    if not clear:
        return skip(f"no moment in {args.gate_minutes:g} minutes from minute {FIRST_JOB_MINUTE} of an hour, with time for a pass "
                    f"before the next one, while CronJob {BACKUP_CRONJOB} had no Job running")
    decided("the read before the first Job", clock)
    if clock[:8] != day:
        return skip(f"the run crossed 00:00Z: the hold's day is {day}, the database's {clock[:8]}")
    configs = of_kind(rows, CONFIG_BACKUP)
    late = [c for c in configs if c.created >= vm_made]
    if late:
        return skip(f"a config of the day was asked after the VM was created ({named(late)}): the newest config is not older than the VM")
    if not any(c.status == "Done" for c in configs):
        return skip(f"no cluster config of {day} is Done yet (configs: {named(configs)}): disk backup is not set up here, or the day's first config has not ended")
    if any(r.key == key for r in rows):
        return skip(f"the CronJob's own pass queued the VM's backup before the agent's Job ({named([r for r in rows if r.key == key])})")
    if not time_left(4 * args.job_minutes + args.backup_minutes + args.settle_minutes + args.config_minutes):
        return skip(f"the spec stops waiting at {gives_up_at:%H:%M:%SZ}: too little time left for the two passes")
    before_a = clock

    # --- the first Job queues the VM's backup; no config, the VM's disk has no row that ended
    why, word = run_pass("a")
    if why:
        return finish(word, why)
    clock, rows, there = read_until(lambda _, found: any(r.key == key for r in found), args.job_minutes)
    if rows is None:
        return skip("could not read core.provider_commands after the first Job")
    decided("the read after the first Job", clock)
    if clock[:10] != before_a[:10]:
        return skip(f"the first Job's pass may have run in the next hour ({clock[:10]}, the read before it {before_a[:10]})")
    if not there:
        return finish("FAIL", f"the pass of the first Job queued no row {key}")
    clock, rows, ended = read_until(lambda _, found: any(r.key == key and r.status in ENDED for r in found), args.backup_minutes)
    backup = next((r for r in rows or [] if r.key == key), None)
    if not ended or backup is None:
        ahead = waiting_disks(rows or [])
        return skip(f"the VM's backup did not end in {args.backup_minutes:g} minutes ({backup.status if backup else 'not read'})"
                    + (f"; other disk backups of the cluster waiting: {named(ahead)}" if ahead else ""))
    if backup.status != "Done":
        return skip(f"the VM's backup ended {backup.status} attempts={backup.attempts} last_error={backup.error!r}")

    # --- the read right before the second Job: every disk backup and config of the day ended
    def settled(c, found):
        return (not any(r.status in WAITING for r in of_kind(found, *DISK_BACKUPS, CONFIG_BACKUP))) and gate(c, found)

    clock, rows, quiet = read_until(settled, args.settle_minutes)
    if rows is None:
        return skip("could not read core.provider_commands before the second Job")
    if not quiet:
        waiting = [r for r in of_kind(rows, *DISK_BACKUPS, CONFIG_BACKUP) if r.status in WAITING]
        return skip(f"after {args.settle_minutes:g} minutes a backup or a config of the day still waits ({named(waiting)}), "
                    f"or no moment clear of the CronJob's own pass came")
    decided("the read before the second Job", clock)
    if clock[:8] != day:
        return skip(f"the run crossed 00:00Z: the hold's day is {day}, the database's {clock[:8]}")
    backup = next((r for r in rows if r.key == key), None)
    if backup is None or backup.status != "Done":
        return skip(f"the VM's backup is no longer Done before the second Job ({named([backup] if backup else [])})")
    since = [c for c in of_kind(rows, CONFIG_BACKUP) if c.created > backup.created]
    if since:
        return skip(f"a pass other than the agent's queued a config after the VM's backup row, before the second Job ({named(since)})")
    others = [r for r in of_kind(rows, *DISK_BACKUPS) if r.key != key and r.created > backup.created]
    if others:
        return skip(f"another disk was created in between: its backup row is newer than the VM's ({named(others)})")
    hour_key = f"cluster-backup-{cluster_id}-{clock[:10]}"
    if any(r.key == hour_key for r in rows):
        return skip(f"this UTC hour's config key {hour_key} is there already: the pass would queue none; run in another hour")
    if not time_left(2 * args.job_minutes + args.config_minutes):
        return skip(f"the spec stops waiting at {gives_up_at:%H:%M:%SZ}: too little time left for the second pass")
    known = {r.key for r in rows}

    # --- the second Job queues another config of the cluster, under this hour's key
    why, word = run_pass("b")
    if why:
        return finish(word, why)
    again = re.compile(rf"^cluster-backup-{re.escape(cluster_id)}-{day}\d\d$")

    def asked(found):
        return [r for r in of_kind(found, CONFIG_BACKUP) if r.key not in known and again.match(r.key)]

    clock, rows, there = read_until(lambda _, found: bool(asked(found)), args.job_minutes)
    if rows is None:
        return skip("could not read core.provider_commands after the second Job")
    decided("the read after the second Job", clock)
    if clock[:10] != hour_key[-10:]:
        return skip(f"the second Job's pass may have run in the next hour ({clock[:10]}, the read before it {hour_key[-10:]})")
    if not there:
        disks = [r for r in of_kind(rows, *DISK_BACKUPS) if r.key not in known]
        if disks:
            return skip(f"another disk was created in between: the second Job queued its backup, not a config ({named(disks)})")
        return finish("FAIL", f"the pass of the second Job queued no config {hour_key} "
                              f"(configs of the day: {named(of_kind(rows, CONFIG_BACKUP))})")
    config_key = asked(rows)[0].key
    if config_key != hour_key:
        return finish("FAIL", f"the pass of the second Job queued {config_key}, not {hour_key} (the UTC hour of its pass)")
    clock, rows, ended = read_until(lambda _, found: any(r.key == config_key and r.status in ENDED for r in found), args.config_minutes)
    config = next((r for r in rows or [] if r.key == config_key), None)
    if not ended or config is None:
        ahead = waiting_disks(rows or [])
        return skip(f"{config_key} did not end in {args.config_minutes:g} minutes ({config.status if config else 'not read'})"
                    + (f"; disk backups of the cluster ahead of it: {named(ahead)}" if ahead else ""))
    if config.status != "Done":
        return finish("FAIL", f"{config_key} ended {config.status} attempts={config.attempts} last_error={config.error!r}")
    done_at = clock
    decided(f"the read that saw {config_key} Done", done_at)
    if done_at[:8] != day:
        return skip(f"the run crossed 00:00Z: {config_key} was read Done on {done_at[:8]}")
    drills = [r for r in of_kind(rows, "restore.drill") if r.key not in known]
    why22 = (f"{key} Done (row created {backup.created}), then {config_key} Done (row created {config.created}), read at {done_at}"
             + (f"; the second Job also queued {named(drills)}" if drills else ""))
    said = answer(kube, "bak22", "go", log)
    run.answered = True
    if said != 0:
        return skip(f"the spec did not take go-bak22 (it stops waiting at {gives_up_at:%H:%M:%SZ}): {why22}")
    run.passed = why22

    # --- BAK-23: the cluster's config rows at the first read of the bucket later than that
    deadline = time.monotonic() + args.read_minutes * 60
    while True:
        text = psql(copies_sql)
        read = config_copies(text) if text is not None else None
        if read and read[2] > done_at:
            break
        if time.monotonic() >= deadline:
            last = f"outcome={read[1]} last_read_at={read[2]}" if read else "no row of incus/ in core.backup_observations, or no read"
            return finish("PASS", why22, "NOT_COVERED", f"no read of the bucket after {done_at} in {args.read_minutes:g} minutes ({last})")
        time.sleep(args.every)
    decided("the first read of the bucket after it", read[0])
    if read[1] != "Read":
        return finish("PASS", why22, "NOT_COVERED", f"the read of the bucket at {read[2]} could not list it (outcome={read[1]})")
    if read[2][:8] != day:
        return finish("PASS", why22, "NOT_COVERED", f"the run crossed 00:00Z before the bucket was read ({read[2][:8]})")
    return finish("PASS", why22, *bak23_verdict(read[3], day, backup.created))


def seconds(text):
    value = float(text)
    if value < 0:
        raise argparse.ArgumentTypeError(f"{text}: not a number of seconds")
    return value


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
    p = sub.add_parser("step")
    p.add_argument("step")
    p.add_argument("--kubeconfig")
    p.add_argument("--job")
    ssh_opts(p, required=False)
    p.add_argument("--local", action="store_true")
    p.add_argument("--log", required=True)
    p.add_argument("--state", required=True, help="file of setup's facts and recorded values, outside the evidence")
    p.add_argument("--env", choices=("release", "dev"), default="release")
    p.add_argument("--keys")
    p.add_argument("--guest-known-hosts")
    p.add_argument("--api", help="the environment's API, for setup's curl")
    p.add_argument("--project", help="cln02 with no setup state, or to override setup's")
    p.add_argument("--no-go", action="store_true", help="run the commands, leave the answer to `go`")
    p.add_argument("--timeout-minutes", type=float, default=80)
    p.add_argument("--read-timeout", type=float, default=300)
    p.set_defaults(func=cmd_step)
    p = sub.add_parser("cli10")
    kube_args(p)
    p.add_argument("--cli", required=True, help="the openvicloud binary the release ships, for this machine")
    p.add_argument("--api", required=True)
    p.add_argument("--log", required=True)
    p.add_argument("--seconds", type=int, default=330, help="the session's silence (CLI-10: 330)")
    p.add_argument("--timeout-minutes", type=float, default=80)
    p.set_defaults(func=cmd_cli10)
    p = sub.add_parser("bak20")
    kube_args(p)
    p.add_argument("--log", required=True)
    p.add_argument("--every", type=float, default=3, help="seconds between two reads of the VM's command rows")
    p.add_argument("--leased-minutes", type=float, default=30, help="until today's backup of the VM is Leased")
    p.add_argument("--watch-minutes", type=float, default=45, help="after go, until the backup and the snapshot end (or 600 s after the backup ended)")
    p.add_argument("--timeout-minutes", type=float, default=80, help="until HOLD bak20")
    p.set_defaults(func=cmd_bak20)
    p = sub.add_parser("bak22")
    kube_args(p)
    p.add_argument("--log", required=True)
    p.add_argument("--every", type=seconds, default=5, help="seconds between two reads")
    p.add_argument("--gate-minutes", type=float, default=8,
                   help="before the first Job, until it is minute 3 or later, the CronJob has no Job running and a pass fits before the next hour")
    p.add_argument("--backup-minutes", type=float, default=15, help="after the first Job, until the VM's backup ended")
    p.add_argument("--settle-minutes", type=float, default=6, help="before the second Job, until no backup or config of the day is Pending or Leased, at a moment like the first Job's")
    p.add_argument("--config-minutes", type=float, default=4, help="after the second Job, until the config it queued ended")
    p.add_argument("--read-minutes", type=float, default=12, help="after go, until the bucket was read (CronJob */5)")
    p.add_argument("--job-minutes", type=float, default=2,
                   help="until a Job the agent created has run its pass, then until the rows show what the pass queued")
    p.add_argument("--hold-minutes", type=float, default=40, help="how long the spec waits after HOLD bak22 (HOLD_AGENT_MS)")
    p.add_argument("--timeout-minutes", type=float, default=80, help="until HOLD bak22")
    p.set_defaults(func=cmd_bak22)
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
    if args.func is cmd_step and not args.local and not (args.control and args.target):
        parser.error("step wants --control and --target (or --local)")
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
