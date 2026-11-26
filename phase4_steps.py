"""The host commands of each HOLD step of phase4/ (phase4/phase4-host.spec.ts), for `phase4.py step <step>`.

Each step is a function of the HOLD's facts (merged over the facts of HOLD setup, which carry `project` and the names
later steps lack) and of the run's options, and returns its commands in order. A command runs on the Incus host
through the ControlMaster, or, when `outside`, from outside the cluster: this machine on the release environment,
the host on dev (the spec's FROM_OUTSIDE). `{name}` in a command is a fact, an option or a value an earlier command
recorded; `{V}`, `{U}`, `{X}` are left to phase4.py's key substitution. The commands only read or act; whether the
output matches the plan row is the agent's call, from the log.
"""
import json
import re
from collections import namedtuple

# record(code, output) -> {name: value} kept for later commands and steps (None: the read failed); until(code, output,
# values) ends a command run again every few seconds (timeout in seconds; values: facts, options and recorded);
# when(recorded) -> None to run it, else why it is skipped; write: the command changes the host (a failed one means the
# step did not happen, so phase4.py step leaves the answer to the agent).
Cmd = namedtuple("Cmd", "text outside record until timeout when write",
                 defaults=(False, None, None, None, None, False))

P = "--project {project}"
AUTHORIZED_KEYS = "sudo incus exec " + P + " {vm} -- sh -c 'wc -l < /home/ubuntu/.ssh/authorized_keys; uptime -s'"
IMAGES = ("sudo incus query /1.0/images?recursion=1 | python3 -c 'import json,sys; im=json.load(sys.stdin); "
          "print(\"images\", len(im), \"without alias\", sum(1 for i in im if not i[\"aliases\"]), "
          "[i[\"fingerprint\"] for i in im if not i[\"aliases\"]])'")
ALIAS_TARGET = ("sudo incus query /1.0/images/aliases/{alias} | python3 -c "
                "'import json,sys; print(json.load(sys.stdin)[\"target\"])'")
NAME = re.compile(r"\{(\w+)\}")
KEY_TOKENS = {"V", "U", "X"}


def render(text, values):
    """text with every {name} replaced by values[name]; {V}, {U}, {X} stay; an unknown name is an error."""
    def one(match):
        name = match.group(1)
        if name in KEY_TOKENS:
            return match.group(0)
        if name not in values or values[name] is None:
            raise KeyError(name)
        return str(values[name])
    return NAME.sub(one, text)


# Values a step records for a later command or step, not known before it runs.
RECORDED = {"vm24Boot", "obs05Target", "obs05Now"}


def last_line(output):
    lines = [line for line in output.splitlines() if line.strip()]
    return lines[-1].strip() if lines else ""


def setup(f, o):
    return [
        Cmd("sudo incus list " + P + " -c n,s,config:limits.cpu,config:limits.memory,config:user.titan-name -f csv"),
        Cmd("sudo incus storage volume list default " + P + " -c n,t,U -f csv"),
        Cmd("sudo incus storage volume snapshot list default {volume} " + P + " -f csv"),
        Cmd("sudo incus storage volume show default {volume} " + P + " | grep -A3 used_by"),
        Cmd("sudo incus snapshot list " + P + " {vmA} -f csv -c n"),
        Cmd("sudo incus network show {net6} " + P),
        Cmd("sudo incus network show {netEmpty} " + P + " | grep -E 'default|acls|description|^  network:'"),
        Cmd("sudo incus network acl show {acl} " + P),
        Cmd("sudo incus image alias list -f csv"),
        Cmd("sudo incus info | grep -A3 architectures"),
        Cmd("sudo incus image list --project default --format json | python3 -c 'import json,sys,math; "
            "[print({\"fingerprint\":i[\"fingerprint\"],\"type\":i[\"type\"],"
            "\"description\":i[\"properties\"].get(\"description\"),\"size\":i[\"size\"],"
            "\"gib\":math.ceil(i[\"size\"]/2**30)}) for i in json.load(sys.stdin)]'"),
        Cmd("sudo incus exec " + P + " {vmA} -- sh -c 'cat /var/lib/rg-marker; systemctl is-active ssh; cloud-init status'"),
        Cmd("sudo incus exec " + P + " {vmB} -- sh -c 'ls /var/lib/rg-marker 2>&1; systemctl is-active ssh'"),
        Cmd(AUTHORIZED_KEYS.replace("{vm}", "{vmA}")),
        Cmd("echo ADM-11; sudo incus info | grep certificate_fingerprint"),
        Cmd("sudo incus config trust list --format csv --columns nt"),
        Cmd("curl -s {api}/v1/os-images", outside=True),
    ]


def vm24_restart(f, o):
    def boot(code, output):
        return {"vm24Boot": last_line(output)}

    def back(code, output, recorded):
        return code == 0 and last_line(output) not in ("", recorded.get("vm24Boot"))

    keys = "sudo incus exec " + P + " {vm} -- grep -c '{K}' /home/ubuntu/.ssh/authorized_keys"
    return [
        Cmd(AUTHORIZED_KEYS, record=boot),
        Cmd("sudo incus restart " + P + " {vm}", write=True),
        # the guest agent answers again some time after the restart; uptime -s then names the new boot
        Cmd(AUTHORIZED_KEYS, until=back, timeout=o.get("restartTimeout", 600)),
        *[Cmd("echo key " + k.lower() + "; " + keys.replace("{K}", "{" + k + "}")) for k in ("V", "U", "X")],
        Cmd("sudo incus exec " + P + " {vm} -- sh -c 'wc -l < /etc/ssh/openvicloud/ubuntu; "
            "grep -c {V} /etc/ssh/openvicloud/ubuntu'"),
    ]


def obs05(f, o):
    return [
        Cmd("echo OBS-05 before; " + IMAGES),
        Cmd(ALIAS_TARGET, record=lambda code, out: {"obs05Target": last_line(out) if code == 0 else None}),
        Cmd("sudo incus image alias delete {alias}", write=True),
    ]


def obs05_after_sync(f, o):
    def changed(recorded):
        before, now = recorded.get("obs05Target"), recorded.get("obs05Now")
        if not before or not now:
            return "no target recorded at obs05 or read now"
        if before == now:
            return "the alias still points at the image recorded at obs05"
        return None

    return [
        Cmd("echo OBS-05 after sync; " + ALIAS_TARGET,
            record=lambda code, out: {"obs05Now": last_line(out) if code == 0 else None}),
        Cmd(IMAGES),
        Cmd("sudo incus image delete --project default {obs05Target}", when=changed, write=True),
        Cmd("echo OBS-05 after the delete step; " + IMAGES),
    ]


def facts_commands(f, o):
    """fw08-*, lb18-*, net30: the spec lists its commands in the facts (outside[] and host[], without sudo)."""
    cmds = []
    if f.get("uplink"):
        cmds.append(Cmd("sudo incus network get {uplink} ipv6.gateway"))
    if f.get("devPrecondition") and o.get("env") == "dev":
        cmds.append(Cmd("ip -6 addr show ovnbr"))
    cmds += [Cmd(c, outside=True) for c in f.get("outside", [])]
    cmds += [Cmd("sudo " + c) for c in f.get("host", [])]
    return cmds


def ssh06(f, o):
    ssh = ("ssh -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "
           "-o UserKnownHostsFile={guestKnownHosts} -i {keys}/{key} ubuntu@{ipv6A} whoami")
    return [Cmd("ping -6 -c 3 -W 3 {ipv6A}", outside=True),
            *[Cmd(ssh.replace("{key}", k), outside=True) for k in ("v", "x")]]


STEPS = {
    "setup": setup,
    "vm28-limit": lambda f, o: [Cmd("n=$(sudo incus list " + P + " -f csv -c n | wc -l); echo instances=$n; "
                                    "sudo incus project set {project} limits.instances=$n && "
                                    "sudo incus project get {project} limits.instances", write=True)],
    "vm28-unset": lambda f, o: [Cmd("sudo incus project unset {project} limits.instances && "
                                    "echo unset=[$(sudo incus project get {project} limits.instances)]", write=True)],
    "vm28-gone": lambda f, o: [Cmd("sudo incus list " + P + " -f csv -c n | grep -c {vm}")],
    "vms17-gone": lambda f, o: [Cmd("sudo incus snapshot list " + P + " {vm} -f csv -c n | grep -c {vmSnapshot}")],
    "net25": lambda f, o: [Cmd("sudo incus network show {network} " + P + " | grep -E 'security.acls|description'")],
    "ssh06": ssh06,
    "lb-one-backend": lambda f, o: [Cmd("for i in $(seq 1 16); do curl -6 -s --max-time 10 http://[{vip}]:80/; echo; "
                                        "done", outside=True)],
    "vm24-restart": vm24_restart,
    "obs01": lambda f, o: [Cmd("sudo incus stop " + P + " {vm}", write=True)],
    "obs02": lambda f, o: [Cmd("sudo incus start " + P + " {vm}", write=True)],
    "obs07": lambda f, o: [Cmd("sudo incus pause " + P + " {vm}", write=True)],
    "obs03": lambda f, o: [Cmd("sudo incus list " + P + " {vm} -c n,s,config:user.titan-name -f csv"),
                           Cmd("sudo incus delete --force " + P + " {vm}", write=True)],
    "obs04": lambda f, o: [Cmd("sudo incus create --empty --vm {outside} " + P + " -s default", write=True),
                           Cmd("sudo incus storage volume attach default {volume} {outside} " + P, write=True),
                           Cmd("sudo incus storage volume show default {volume} " + P + " | grep -A2 used_by")],
    "obs04-undo": lambda f, o: [Cmd("sudo incus storage volume detach default {volume} {outside} " + P, write=True),
                                Cmd("sudo incus delete " + P + " {outside}", write=True)],
    "obs06": lambda f, o: [Cmd("sudo incus network show {network} " + P + " | grep -E 'description|used_by'"),
                           Cmd("sudo incus network delete {network} " + P, write=True)],
    "obs05": obs05,
    "obs05-after-sync": obs05_after_sync,
    "obs08-protect": lambda f, o: [Cmd("sudo incus list " + P + " {vm} -c n,s,config:user.titan-name -f csv"),
                                   Cmd("sudo incus config set {vm} security.protection.delete=true " + P, write=True)],
    "obs08-unprotect": lambda f, o: [Cmd("sudo incus list " + P + " {vm} -c n,s -f csv"),
                                     Cmd("sudo incus config unset {vm} security.protection.delete " + P, write=True)],
    "obs09": lambda f, o: [Cmd("sudo incus snapshot list " + P + " {vm} -f csv -c n"),
                           Cmd("sudo incus snapshot delete " + P + " {vm} {snapshot}", write=True)],
    "obs10": lambda f, o: [Cmd("sudo incus storage volume list default " + P + " -c n,t,U -f csv | grep {volume}; "
                               "sudo incus storage volume snapshot list default {volume} " + P + " -f csv"),
                           Cmd("sudo incus storage volume delete default {volume} " + P, write=True)],
    "obs11": lambda f, o: [Cmd("sudo incus network acl rule remove {acl} {direction} description={ruleId} " + P,
                               write=True),
                           Cmd("sudo incus network acl show {acl} " + P + " | grep -c {ruleId}")],
    "obs12": lambda f, o: [Cmd("sudo incus network load-balancer delete {network} {vip} " + P, write=True),
                           Cmd("sudo incus network load-balancer list {network} " + P + " -f csv")],
    "net30": facts_commands,
    "fw08-before": facts_commands,
    "fw08-after-rule": facts_commands,
    "lb18-before": facts_commands,
    "lb18-after-rule": facts_commands,
    # CLN-02: no HOLD, after the run; what Titan made in the project is gone, and no image is left without an alias
    "cln02": lambda f, o: [
        Cmd("for k in instances networks network-acls storage-pools/default/volumes; do echo \"$k: $(sudo incus "
            "query \"/1.0/$k?project={project}\" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)), "
            "\"object(s)\")')\"; done"),
        Cmd("sudo incus image alias list -f csv; " + IMAGES)],
}

# Steps with a command that writes on the host: the agent runs them under an approved L-x only.
def writes():
    probe = {"env": "release"}
    return {step for step, commands in STEPS.items() if any(c.write for c in commands(probe, probe))}


WRITES = writes()


def load_state(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {"setup": {}, "recorded": {}}


def save_state(path, state):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=1, sort_keys=True)
