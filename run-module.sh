#!/usr/bin/env bash
# One regression module in the cluster, steps 1-5 of §Runner in OpenViCloud/titan-ops:.claude/commands/release/regression.md:
# load lib + module into ConfigMap titan-regression-specs-<job>, create the job from CronJob $REGRESSION_CRONJOB
# (default titan-regression), wait for /work/results/.done (or the pod ending), copy the results, compare sha256 file
# by file, delete the job and its ConfigMap. A job kept for a look (the exit 1 paths below) keeps its ConfigMap: after
# `kubectl delete job <job>` by hand, `kubectl delete configmap titan-regression-specs-<job>` too.
# The runner's output (runner.log, results/, sha lists) goes to <work dir>, which is not committed: the
# regression report holds the result. control-plane.log and incus-worker.log since the job was created go to
# <log dir> (system logs, for diagnosis; the verdict comes from the specs), and so do the UI cases' screenshots
# (results/*.png): they are the evidence of those cases. check-screenshots.py then names every UI case that passed
# with no <ID>-*.png. The first line of each system log names its lane (REGRESSION_LANE: a, b, or sequential for a module
# run by hand): those pods' logs also hold the other lane's requests. The first line names the runner's git blob, so evidence/ never needs a copy of this script.
# For modules cli and terraform-provider, pass the binary built for the node's architecture (the openvicloud CLI, or
# `go test -c` of the provider): it is copied into the pod as /work/bin/openvicloud when the runner logs BINARY_WAIT.
#
# Usage:  bash run-module.sh <kubeconfig> <src tree> <module> <label> <work dir> <log dir> [binary]
#   <kubeconfig>  ~/.kube/titan-prd.yaml (prd) or ~/.lima/titan-k3s/copied-from-guest/kubeconfig.yaml (dev)
#   <src tree>    `git archive <sha>` of this repository at the sha the release pins, extracted (with the
#                 release's new specs copied in at their repo path); run this script from a checkout
#   <module>      a module of this repository (vm), or a spec directory relative to <src tree>
#   <label>       suffix of the job name: regression-<module>-<label>
#   <work dir>    runner output, outside the repo (scratchpad)
#   <log dir>     control-plane.log + incus-worker.log + <ID>-*.png: release evidence/<module>[-<lane>][-<step label>]/
#                 (run-lanes.py adds the lane for a module both lanes run); its *.png are deleted first
# Exit 0 = REGRESSION_EXIT=0 and every result file copied with a matching sha256. A sha256 mismatch keeps the job
# for a chunked copy.
set -uo pipefail

if [ "$#" -lt 6 ] || [ "$#" -gt 7 ]; then
  echo "Usage: $0 <kubeconfig> <src tree> <module> <label> <work dir> <log dir> [binary]" >&2
  exit 2
fi
kc="$1"; src="$2"; module="$3"; label="$4"; out="$5"; logs_dir="$6"; bin="${7:-}"
lane="${REGRESSION_LANE:-sequential}"   # run-lanes.py sets a/b; a module run by hand is the sequential run
k() { kubectl --kubeconfig "$kc" "$@"; }
# Each environment names its namespaces its own way: the runner's is where CronJob titan-regression is, the apps' where
# Deployment control-plane runs. Exactly one of each, or the run stops before it creates anything.
namespace_of() {
  k get "$1" -A -o json | python3 -c '
import json, sys
found = [i["metadata"]["namespace"] for i in json.load(sys.stdin)["items"] if i["metadata"]["name"] == sys.argv[1]]
print(found[0] if len(found) == 1 else "")' "$2"
}
ns="$(namespace_of cronjob titan-regression)"
app_ns="$(namespace_of deployment control-plane)"
if [ -z "$ns" ] || [ -z "$app_ns" ]; then
  echo "not exactly one CronJob titan-regression and one Deployment control-plane on this cluster" >&2
  exit 2
fi
phase_of() { k -n "$ns" get pod "$1" -o json | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"]["phase"])'; }

case "$module" in
  */*) spec_dir="$module"; name="$(basename "$module")" ;;
  *) spec_dir="$module"; name="$module" ;;
esac
job="regression-${name}-${label}"
cronjob="${REGRESSION_CRONJOB:-titan-regression}"
specs_cm="titan-regression-specs-${job}"
mkdir -p "$out" "$logs_dir"
out="$(cd "$out" && pwd)"
logs_dir="$(cd "$logs_dir" && pwd)"
# A rerun into the same log dir must not pass check-screenshots.py on the previous run's pictures.
find "$logs_dir" -maxdepth 1 -type f -name '*.png' -delete
if [ -n "$bin" ]; then bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")"; fi

# The control plane logs every request and SQL command at info; trim-cp-log.py drops the info records
# of the hosting, routing and SQL-command categories (warn/fail and Titan's own lines stay), so a module's log is read.
app_log_filter() {
  if [ "$1" = "control-plane" ]; then
    python3 "$runner_dir/trim-cp-log.py"
  else
    cat
  fi
}

# Every pod of an app (control-plane, incus-worker) from $since on; a restarted pod adds its previous container.
save_app_logs() {
  local app="$1" file="$logs_dir/$1.log" note=""
  if [ "$app" = "control-plane" ]; then note=" | python3 trim-cp-log.py"; fi
  # Header line of §Evidence in OpenViCloud/titan-ops:.claude/commands/release/regression.md (OpenViCloud/titan-ops:scripts/check-evidence.py HEADER).
  echo "# kubectl logs -n $app_ns <each pod of app=$app> --since-time=$since (+ --previous when restarted)$note (lane $lane) · $(k config view --minify -o 'jsonpath={.clusters[0].cluster.server}') · $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$file"
  k -n "$app_ns" get pods -l "app=$app" -o json \
    | python3 -c 'import sys,json
for p in json.load(sys.stdin)["items"]:
    print(p["metadata"]["name"], sum(c.get("restartCount", 0) for c in p["status"].get("containerStatuses", [])))' \
    | while read -r app_pod restarts; do
        if [ "$restarts" != "0" ]; then
          echo "=== $app_pod previous container (restarts=$restarts)" >> "$file"
          k -n "$app_ns" logs "$app_pod" --previous --since-time="$since" 2>&1 | app_log_filter "$app" >> "$file"
        fi
        echo "=== $app_pod since $since" >> "$file"
        k -n "$app_ns" logs "$app_pod" --since-time="$since" 2>&1 | app_log_filter "$app" >> "$file"
      done
  echo "$app.log: $(wc -l < "$file" | tr -d ' ') lines"
}

runner_dir="$(cd "$(dirname "$0")" && pwd)"
runner_state="clean"
if ! git -C "$runner_dir" diff --quiet HEAD -- "$runner_dir/run-module.sh"; then runner_state="dirty"; fi
echo "runner: run-module.sh blob=$(git -C "$runner_dir" hash-object "$runner_dir/run-module.sh") head=$(git -C "$runner_dir" rev-parse --short HEAD) $runner_state"
echo "cluster: $(k config view --minify -o 'jsonpath={.clusters[0].cluster.server}')"
echo "module: $name specs: $spec_dir job: $job cronjob: $cronjob start: $(date -u +%H:%M:%S)"
cd "$src" || exit 2
if [ ! -d "$spec_dir" ]; then echo "no spec directory $src/$spec_dir" >&2; exit 2; fi

k -n "$ns" create configmap "$specs_cm" \
  --from-file=lib --from-file="$spec_dir" --dry-run=client -o yaml | k -n "$ns" apply -f - || exit 2
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# pipefail: a failing kubectl, patch-job.py or create all end in `exit 2`.
k -n "$ns" create job "$job" --from="cronjob/$cronjob" --dry-run=client -o json \
  | python3 "$runner_dir/patch-job.py" "$specs_cm" | k -n "$ns" create -f - || exit 2

pod=""; phase=""
for _ in $(seq 1 120); do
  pod="$(k -n "$ns" get pods -l "job-name=$job" -o json | python3 -c 'import sys,json; i=json.load(sys.stdin)["items"]; print(i[0]["metadata"]["name"] if i else "")')"
  if [ -n "$pod" ]; then
    phase="$(phase_of "$pod")"
    case "$phase" in Running|Failed|Succeeded) break ;; esac
  fi
  sleep 5
done
echo "pod: $pod phase: $phase"
if [ -z "$pod" ]; then echo "NO_POD after 10 minutes — job kept for a look"; exit 1; fi
case "$phase" in Running|Failed|Succeeded) ;; *) echo "POD_NOT_STARTED phase=$phase after 10 minutes — job kept for a look"; exit 1 ;; esac

copied=0
while true; do
  phase="$(phase_of "$pod")"
  if [ "$phase" != "Running" ]; then echo "pod ended: $phase (no .done)"; break; fi
  if k -n "$ns" exec "$pod" -- test -f /work/results/.done 2>/dev/null; then break; fi
  if [ -n "$bin" ] && [ "$copied" = 0 ]; then
    # Logs into a variable first: `kubectl logs | grep -q` under pipefail turns false when grep exits early.
    logs="$(k -n "$ns" logs "$pod" 2>/dev/null)"
    if grep -q BINARY_WAIT <<< "$logs"; then
      k -n "$ns" exec "$pod" -- mkdir -p /work/bin
      k -n "$ns" cp "$bin" "$pod:/work/bin/openvicloud" >/dev/null
      remote="$(k -n "$ns" exec "$pod" -- sha256sum /work/bin/openvicloud | cut -d' ' -f1)"
      local_sum="$(shasum -a 256 "$bin" | cut -d' ' -f1)"
      echo "binary sha256 pod=$remote local=$local_sum"
      if [ "$remote" != "$local_sum" ]; then echo "BINARY_SHA_MISMATCH — job kept"; exit 1; fi
      k -n "$ns" exec "$pod" -- chmod +x /work/bin/openvicloud
      k -n "$ns" exec "$pod" -- touch /work/bin/openvicloud.ready
      copied=1
    fi
  fi
  sleep 15
done

save_app_logs control-plane
save_app_logs incus-worker
k -n "$ns" logs "$pod" > "$out/runner.log" 2>&1
grep -E 'REGRESSION_EXIT=|passed|failed|skipped|flaky|NO_SPECS' "$out/runner.log" | tail -8
status=1
if grep -q '^REGRESSION_EXIT=0$' "$out/runner.log"; then status=0; fi

if [ "$phase" = "Running" ]; then
  k -n "$ns" cp "$pod:/work/results" "$out/results" >/dev/null
  k -n "$ns" exec "$pod" -- sh -c 'cd /work/results && find . -type f ! -name .done -exec sha256sum {} +' | sort -k2 > "$out/sha-pod.txt"
  (cd "$out/results" && find . -type f ! -name .done -exec shasum -a 256 {} + | sort -k2) > "$out/sha-local.txt"
  if [ -s "$out/sha-pod.txt" ] && diff -q "$out/sha-pod.txt" "$out/sha-local.txt" >/dev/null; then
    echo "SHA256_MATCH $(wc -l < "$out/sha-pod.txt" | tr -d ' ') file(s)"
  else
    echo "SHA256_MISMATCH — job $job kept for a chunked copy"
    exit 1
  fi
  # Top level only: results/test-output/ is Playwright's own folder.
  shots="$(find "$out/results" -maxdepth 1 -type f -name '*.png' | wc -l | tr -d ' ')"
  find "$out/results" -maxdepth 1 -type f -name '*.png' -exec cp {} "$logs_dir/" \;
  echo "screenshots: $shots file(s) copied to $logs_dir"
fi
# A missing screenshot does not change the exit status: the report counts that case NOT COVERED. The lines are kept
# in <work dir> too, for a module run in the background.
python3 "$runner_dir/check-screenshots.py" "$spec_dir" "$logs_dir" "$out/runner.log" | tee "$out/screenshots.txt"
k -n "$ns" delete job "$job" --wait=true
k -n "$ns" delete configmap "$specs_cm" --ignore-not-found
echo "end: $(date -u +%H:%M:%S)"
exit "$status"
