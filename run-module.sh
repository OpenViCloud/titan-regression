#!/usr/bin/env bash
# One regression module in the cluster, steps 1-5 of README.md §Inside a module run:
# load lib + module into ConfigMap titan-regression-specs-<job>, create the job from CronJob $REGRESSION_CRONJOB
# (default titan-regression), wait for /work/results/.done (or the pod ending), copy the results, compare sha256 file
# by file, delete the job and its ConfigMap. A job kept for a look (the exit 1 paths below) keeps its ConfigMap: after
# `kubectl delete job <job>` by hand, `kubectl delete configmap titan-regression-specs-<job>` too.
# The runner's output (runner.log, results/, sha lists) goes to <work dir>, which is not committed: the
# regression report holds the result. control-plane.log and incus-worker.log (and incus-worker-inventory.log where the
# worker runs an inventory pod) since the job was created go to
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
#   <log dir>     control-plane.log + incus-worker.log [+ incus-worker-inventory.log] + <ID>-*.png: release evidence/<module>[-<lane>][-<step label>]/
#                 (run-lanes.py adds the lane for a module both lanes run); its *.png are deleted first
# Exit 0 = REGRESSION_EXIT=0 and every result file copied with a matching sha256. A file whose sha256 differs is copied
# once more on its own; one that still differs keeps the job for a chunked copy.
# REGRESSION_WORKER_APPS (ADM-15 only): the ArgoCD Applications that would bring incus-worker back, root first; the runner
# then stops and starts the worker when the spec asks (below). It is a write every tenant of the cluster feels: on prd an
# approved L-x.
# REGRESSION_CP_ROLL_SECONDS (BIL-25 only, set by lanes-dev-sequential.json): how long the runner rolls the control plane
# when the spec asks (below).
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

# Every pod of an app (control-plane, incus-worker, incus-worker-inventory) from $since on; a restarted pod adds its previous container.
save_app_logs() {
  local app="$1" file="$logs_dir/$1.log" note=""
  if [ "$app" = "control-plane" ]; then note=" | python3 trim-cp-log.py"; fi
  # Header line of an evidence log: `# <command> (lane <lane>) · <cluster> · <UTC>` (OpenViCloud/titan-ops:scripts/check-evidence.py HEADER and LANE).
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

# ADM-15 (admin/stuck-requests) asks for the cluster's incus-worker stopped, then started again, by two log lines. With
# REGRESSION_WORKER_APPS, the ArgoCD Applications whose auto-sync would bring the worker back, root first (dev:
# root-local,incus-worker-local · prd: incus-worker-prd), the runner answers both; unset, the agent may answer by hand
# on dev only (on the release environment nobody does: the spec skips as N/A after 10 minutes).
# Auto-sync and replicas go back as they were: on WORKER_START_WAIT or ADM15_GAVE_UP, on a stop that fails, and on any
# exit while the worker is down. Where the worker runs as command pods and one inventory pod (Deployment
# incus-worker-inventory, titan-ops architecture/worker-structure.md#worker-roles), both stop: the inventory pod is the
# one that reports reconciler polls.
worker_apps="${REGRESSION_WORKER_APPS:-}"
worker="up"; worker_replicas=""; inventory_replicas=""
stop_worker() {
  local app
  worker="stopping"
  rm -f "${out:?}"/worker-autosync-*.json
  worker_replicas="$(k -n "$app_ns" get deploy incus-worker -o 'jsonpath={.spec.replicas}')" || return 1
  inventory_replicas="$(k -n "$app_ns" get deploy incus-worker-inventory --ignore-not-found -o 'jsonpath={.spec.replicas}')" || return 1
  for app in ${worker_apps//,/ }; do
    k -n argocd get application "$app" -o json \
      | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["spec"].get("syncPolicy", {}).get("automated")))' \
      > "$out/worker-autosync-$app.json" || return 1
    k -n argocd patch application "$app" --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}' >/dev/null || return 1
  done
  k -n "$app_ns" scale deploy/incus-worker --replicas=0 >/dev/null || return 1
  if [ -n "$inventory_replicas" ]; then
    k -n "$app_ns" scale deploy/incus-worker-inventory --replicas=0 >/dev/null || return 1
  fi
  k -n "$app_ns" wait --for=delete pod -l app=incus-worker --timeout=5m >/dev/null || return 1
  if [ -n "$inventory_replicas" ]; then
    k -n "$app_ns" wait --for=delete pod -l app=incus-worker-inventory --timeout=5m >/dev/null || return 1
  fi
  worker="stopped"
}
start_worker() {
  local app apps=""
  for app in ${worker_apps//,/ }; do apps="$app $apps"; done
  if [ -n "$worker_replicas" ]; then k -n "$app_ns" scale deploy/incus-worker --replicas="$worker_replicas" >/dev/null; fi
  if [ -n "$inventory_replicas" ]; then
    k -n "$app_ns" scale deploy/incus-worker-inventory --replicas="$inventory_replicas" >/dev/null
  fi
  for app in $apps; do
    if [ -s "$out/worker-autosync-$app.json" ]; then
      k -n argocd patch application "$app" --type merge \
        -p "{\"spec\":{\"syncPolicy\":{\"automated\":$(cat "$out/worker-autosync-$app.json")}}}" >/dev/null
    fi
  done
  k -n "$app_ns" rollout status deploy/incus-worker --timeout=10m >/dev/null || return 1
  if [ -n "$inventory_replicas" ]; then
    k -n "$app_ns" rollout status deploy/incus-worker-inventory --timeout=10m >/dev/null || return 1
  fi
  worker="up"
}
trap 'if [ "$worker" != up ]; then echo "worker still stopped at exit — putting it back"; start_worker; fi' EXIT

# BIL-25 (billing) asks for the control plane rolled while its VM runs, by the log line CP_ROLL_WAIT. With
# REGRESSION_CP_ROLL_SECONDS (only lanes-dev-sequential.json sets it: a roll while other modules run would turn them red)
# the runner touches /work/bil-25/rolling, runs `rollout restart` + `rollout status` of deployment/control-plane back to back
# until that many seconds passed (at least once), and touches /work/bil-25/rolled. Each Job of CronJob
# control-plane-job-meter seen meanwhile goes to <log dir>/meter-jobs.log (the CronJob keeps one finished Job, so a read
# after the module would miss them). Unset ⇒ nobody answers, and the spec skips as N/A after 10 minutes.
cp_roll_seconds="${REGRESSION_CP_ROLL_SECONDS:-}"
if [ -n "$cp_roll_seconds" ] && ! [[ "$cp_roll_seconds" =~ ^[0-9]+$ && "$cp_roll_seconds" -le 1800 ]]; then
  echo "REGRESSION_CP_ROLL_SECONDS must be whole seconds, 0 to 1800: $cp_roll_seconds" >&2
  exit 2
fi
meter_jobs() {
  k -n "$app_ns" get jobs -o json | python3 -c '
import json, sys
for j in json.load(sys.stdin)["items"]:
    if j["metadata"]["name"].startswith("control-plane-job-meter-"):
        s = j.get("status", {})
        done = [c["type"] for c in s.get("conditions", []) if c.get("status") == "True"]
        print(j["metadata"]["name"], s.get("startTime", "-"), s.get("completionTime", "-"), ",".join(done) or "Running")'
}
roll_control_plane() {
  local start end rolls=0 file="$logs_dir/meter-jobs.log"
  echo "# kubectl get jobs -n $app_ns (control-plane-job-meter-*: name startTime completionTime conditions) after each roll (lane $lane) · $(k config view --minify -o 'jsonpath={.clusters[0].cluster.server}') · $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$file"
  start="$(date -u +%s)"; end=$((start + cp_roll_seconds))
  k -n "$ns" exec "$pod" -- sh -c 'mkdir -p /work/bil-25 && touch /work/bil-25/rolling' || return 1
  echo "BIL-25 roll window start $(date -u -d "@$start" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$start" +%Y-%m-%dT%H:%M:%SZ)"
  while true; do
    k -n "$app_ns" rollout restart deployment/control-plane >/dev/null || return 1
    k -n "$app_ns" rollout status deployment/control-plane --timeout=10m >/dev/null || return 1
    rolls=$((rolls + 1))
    meter_jobs >> "$file"
    if [ "$(date -u +%s)" -ge "$end" ]; then break; fi
  done
  k -n "$ns" exec "$pod" -- touch /work/bil-25/rolled || return 1
  echo "BIL-25 roll window end $(date -u +%Y-%m-%dT%H:%M:%SZ): $rolls roll(s) of deployment/control-plane; meter Jobs seen: $(awk '!/^#/{print $1}' "$file" | sort -u | wc -l | tr -d ' ')"
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

copied=0; unreadable=0; answered=""; rolled=""
while true; do
  # A failing kubectl prints nothing: an empty phase is a read that failed, not a pod that ended.
  phase="$(phase_of "$pod" 2>/dev/null)"
  if [ -z "$phase" ]; then
    unreadable=$((unreadable + 1))
    if [ "$unreadable" -gt 20 ]; then echo "pod phase unreadable 21 times in a row — job kept for a look"; exit 1; fi
    echo "pod phase unreadable (#$unreadable), reading again in 15 s"; sleep 15; continue
  fi
  unreadable=0
  if [ "$phase" != "Running" ]; then echo "pod ended: $phase (no .done)"; break; fi
  if k -n "$ns" exec "$pod" -- test -f /work/results/.done 2>/dev/null; then break; fi
  if { [ -n "$bin" ] && [ "$copied" = 0 ]; } || { [ -n "$worker_apps" ] && [ "$answered" != start ]; } \
    || { [ -n "$cp_roll_seconds" ] && [ -z "$rolled" ]; }; then
    # Logs into a variable first: `kubectl logs | grep -q` under pipefail turns false when grep exits early.
    logs="$(k -n "$ns" logs "$pod" 2>/dev/null)"
  fi
  if [ -n "$cp_roll_seconds" ] && [ -z "$rolled" ] && grep -q CP_ROLL_WAIT <<< "$logs"; then
    rolled=yes
    if ! roll_control_plane; then
      echo "CP_ROLL_FAILED — a rollout of deployment/control-plane did not finish, or a marker was not written; the spec gives up after 10 minutes, or 30 once rolling"
    fi
  fi
  if [ -n "$worker_apps" ]; then
    if [ -z "$answered" ] && grep -q WORKER_STOP_WAIT <<< "$logs"; then
      answered=stop
      if stop_worker; then
        if k -n "$ns" exec "$pod" -- touch /work/adm-15/worker-stopped; then
          echo "ADM-15 worker stopped: auto-sync off ($worker_apps), replicas $worker_replicas → 0${inventory_replicas:+, inventory $inventory_replicas → 0}"
        else
          echo "WORKER_STOPPED_UNANSWERED — the marker was not written; the spec gives up after 10 minutes"
        fi
      else
        echo "WORKER_STOP_FAILED — putting the worker back; the spec gives up after 10 minutes"
        start_worker
      fi
    elif [ "$answered" = stop ] && grep -q -e WORKER_START_WAIT -e ADM15_GAVE_UP <<< "$logs"; then
      answered=start
      if start_worker; then
        k -n "$ns" exec "$pod" -- touch /work/adm-15/worker-started
        echo "ADM-15 worker started: replicas $worker_replicas${inventory_replicas:+, inventory $inventory_replicas}, auto-sync back"
      else
        echo "WORKER_START_FAILED — the worker (incus-worker, or incus-worker-inventory) not rolled out in 10 minutes"
      fi
    fi
  fi
  if [ -n "$bin" ] && [ "$copied" = 0 ]; then
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
# The inventory pod logs the reconciler's reports; only where the worker runs one (a failed read counts as none).
inventory_pods="$(k -n "$app_ns" get pods -l app=incus-worker-inventory -o json 2>/dev/null \
  | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["items"]))' 2>/dev/null)"
if [ -n "$inventory_pods" ] && [ "$inventory_pods" != "0" ]; then
  save_app_logs incus-worker-inventory
fi
k -n "$ns" logs "$pod" > "$out/runner.log" 2>&1
grep -E 'REGRESSION_EXIT=|passed|failed|skipped|flaky|NO_SPECS' "$out/runner.log" | tail -8
status=1
if grep -q '^REGRESSION_EXIT=0$' "$out/runner.log"; then status=0; fi

if [ "$phase" = "Running" ]; then
  # A rerun into the same work dir (by hand, or run-lanes.py with the same --out) must not compare the earlier run's files.
  rm -rf "${out:?}/results"
  k -n "$ns" cp "$pod:/work/results" "$out/results" >/dev/null
  k -n "$ns" exec "$pod" -- sh -c 'cd /work/results && find . -type f ! -name .done -exec sha256sum {} +' | sort -k2 > "$out/sha-pod.txt"
  sha_local() { (cd "$out/results" && find . -type f ! -name .done -exec shasum -a 256 {} + | sort -k2) > "$out/sha-local.txt"; }
  # Pod lines with no equal local line; the path starts after the 64-hex sum and two spaces.
  differing() { grep -vxFf "$out/sha-local.txt" "$out/sha-pod.txt" | cut -c67-; }
  sha_local
  # A file that differs is copied once more on its own before the job is kept: the run then says what it measured, and
  # a file that still differs is named for the chunked copy.
  if [ -s "$out/sha-pod.txt" ] && ! diff -q "$out/sha-pod.txt" "$out/sha-local.txt" >/dev/null; then
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      echo "SHA256_DIFFERS $file — copying it again"
      mkdir -p "$out/results/$(dirname "$file")"
      k -n "$ns" cp "$pod:/work/results/${file#./}" "$out/results/${file#./}" >/dev/null
    done <<< "$(differing)"
    sha_local
  fi
  if [ -s "$out/sha-pod.txt" ] && diff -q "$out/sha-pod.txt" "$out/sha-local.txt" >/dev/null; then
    echo "SHA256_MATCH $(wc -l < "$out/sha-pod.txt" | tr -d ' ') file(s)"
  else
    echo "SHA256_MISMATCH $(differing | tr '\n' ' ')— job $job kept for a chunked copy"
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
