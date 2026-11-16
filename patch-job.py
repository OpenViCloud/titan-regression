#!/usr/bin/env python3
"""Points the `specs` volume of a Job at a ConfigMap of its own, so two jobs started together read two spec sets, and
adds the environment variables a run passes (`--env NAME=VALUE`, repeatable) to every container of the Job.

The runner's CronJob mounts one ConfigMap by a fixed name; `run-module.sh` creates the job from the CronJob with
`--dry-run=client -o json`, pipes it through here, and creates the result.

Usage:  kubectl create job <name> --from=cronjob/<c> --dry-run=client -o json \\
          | python3 patch-job.py <configmap> [--env NAME=VALUE ...] | kubectl create -f -
"""
import argparse
import copy
import json
import re
import sys

VOLUME = "specs"
ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")


class PatchError(Exception):
    pass


def patch(job, config_map, env=None):
    out = copy.deepcopy(job)
    pod = out["spec"]["template"]["spec"]
    volumes = pod.get("volumes", [])
    found = [v for v in volumes if v.get("name") == VOLUME]
    if len(found) != 1:
        raise PatchError(f"expected one volume named {VOLUME!r}, found {len(found)}")
    if "configMap" not in found[0]:
        raise PatchError(f"volume {VOLUME!r} is not a ConfigMap volume")
    found[0]["configMap"]["name"] = config_map
    for name, value in (env or {}).items():
        for container in pod.get("containers", []):
            container.setdefault("env", []).append({"name": name, "value": value})
    return out


def env_pair(text):
    name, sep, value = text.partition("=")
    if not sep or not ENV_NAME.match(name):
        raise argparse.ArgumentTypeError(f"--env wants NAME=VALUE with NAME in capitals, got {text!r}")
    return name, value


def main(argv):
    parser = argparse.ArgumentParser(description="Job JSON on stdin, patched Job JSON on stdout")
    parser.add_argument("configmap")
    parser.add_argument("--env", type=env_pair, action="append", default=[])
    args = parser.parse_args(argv[1:])
    try:
        patched = patch(json.load(sys.stdin), args.configmap, dict(args.env))
    except (PatchError, KeyError, json.JSONDecodeError) as error:
        print(f"patch-job.py: {error}", file=sys.stderr)
        return 1
    json.dump(patched, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
