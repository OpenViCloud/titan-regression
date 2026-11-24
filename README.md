# titan-regression — OpenViCloud's regression suite

The durable regression suite of [OpenViCloud](https://github.com/OpenViCloud). Every behaviour that must still
hold at the next release has a case in [`plan.md`](plan.md) and, once written, a Playwright spec here. A release pins
the commit of this repository it ran.

The specs drive the public API, the portals and the CLI of a running OpenViCloud environment. They do not run on a
laptop: each module runs as a job of the `titan-regression` runner inside the cluster (its manifests are in
[titan-local-cluster's `base/regression-runner/`](https://github.com/OpenViCloud/titan-local-cluster/tree/main/base/regression-runner)),
which signs in with the test accounts there, so no credential passes through the machine that starts the run.

## Layout

| Path | What it is |
|---|---|
| [`plan.md`](plan.md) | Every case: stable ID, expectation, source |
| `<module>/*.spec.ts` | Specs of one module; the test name carries the case ID |
| `lib/` | Helpers loaded with every module (sign-in, API calls with polling, cleanup, fixtures, the portal's `config.json`) |
| `run-module.sh` | Runs one module in the cluster and copies its results and logs back |
| `count-cases.py` | Counts `plan.md`'s IDs against the runner logs, for the report's first line |
| `check-screenshots.py` | Fails when a browser case passed without its `<ID>-*.png` screenshot |
| `trim-cp-log.py` | Drops the control plane's routine info lines from a saved log |
| `check-removed-fields.py` | Fails when a spec or a helper under `lib/` still reads a field that left the control plane's `/v1` contract and the Spec column below does not mark a case of its test; run it with the two control plane commits a contract change lies between |
| `run-lanes.py`, `lanes.json`, `lanes-dev.json`, `lanes-dev-sequential.json` | Runs the modules as lanes, one lane per test tenant, lanes side by side (below); the two dev plans cover the Dev column |
| `patch-job.py` | Points a job's `specs` volume at a ConfigMap of its own, so jobs started together never read each other's specs; `--env NAME=VALUE` adds a variable to the job |
| `phase4.py` | The agent's commands for the Phase 4 module, and for the holds of `cli/edge`, `backup/command-wait` and `backup/config-again` (§Phase 4) |
| `phase4_steps.py` | The host commands of each HOLD of `phase4/`, run by `phase4.py step` (§Phase 4) |
| `selftest/`, `test_*.py` | Tests of the helpers and scripts above |
| [`CLAUDE.md`](CLAUDE.md) | How specs are written and the assumptions a run on the release environment makes |

## Run one module

```sh
bash run-module.sh <kubeconfig> <source tree> <module> <label> <work dir> <log dir> [binary]
python3 count-cases.py <work dir of each module>/runner.log ...
```

The source tree is `git archive <sha>` of this repository, extracted, with any new or supplemented specs copied in; run the
script from a checkout so its first line names the commit. What the script does inside the cluster, and what some
modules need around it, is the next section. The full procedure of a release (order, verdict, evidence) is
`release:regression-dev` and `release:regression-prd` (skills of titan-ops, private).

## Inside a module run

`run-module.sh` does these five steps; they are written out so a run that stopped half-way can be finished or cleaned
up by hand.

1. **Load the specs** into a ConfigMap of the job's own, `titan-regression-specs-<job>` (`<job>` is
   `regression-<module>-<label>`; a nested module gives its last folder: `cli/edge` runs as `regression-edge-<label>`): `kubectl create configmap titan-regression-specs-<job> --from-file=lib --from-file=<module> --dry-run=client -o yaml | kubectl apply -f -`
   in the source tree (a one-off spec: `--from-file=<its directory>`). The runner loads `/specs/*.ts` flat, so a file
   name shared by `lib/` and the module makes `create configmap` refuse: rename it, never overwrite.
2. **Start the job** from the lane's CronJob (`titan-regression`; lane b `titan-regression-b`):
   `kubectl create job <job> --from=cronjob/<cronjob> --dry-run=client -o json | python3 patch-job.py titan-regression-specs-<job> | kubectl create -f -`
   (`patch-job.py` points the job's `specs` volume at that ConfigMap; for `phase4/` add
   `--env "PHASE4_KEY_V=$(cat <keys dir>/v.pub)" --env "PHASE4_KEY_U=$(cat <keys dir>/u.pub)"`, which `run-module.sh` does).
3. **Wait** for the job's own pod to be `Running` (`--field-selector=status.phase=Running`: a recreated job leaves its
   old pod behind), then poll `kubectl exec <pod> -- test -f /work/results/.done`; stop as soon as the pod is `Failed` or
   `Succeeded` (the runner exits early, for example `NO_SPECS`, without writing `.done`). A phase read that fails
   (kubectl prints nothing) is read again every 15 s, up to 20 times in a row. Then read `REGRESSION_EXIT=`
   from `kubectl logs <pod>` (not `-f`).
4. **Copy the results** (`kubectl cp <pod>:/work/results …` into an emptied `<work dir>/results`) while the pod is still held (30 minutes by default), in
   the same step as 3, and compare the sha256 of every file with `sha256sum` in the pod; a file that differs is copied
   once more on its own (`SHA256_DIFFERS <file>`), and one that still differs is named (a file only on the agent's side
   is not: it shows in `sha-local.txt`) and copied by hand in chunks
   (`dd bs=16384 skip=N count=1 | base64`) until it matches.
5. **Delete the job and its ConfigMap** once every file matched. A mismatch (or `NO_POD`, `POD_NOT_STARTED`,
   `BINARY_SHA_MISMATCH`, a phase unreadable 21 times in a row) exits 1 and keeps both for a look: delete both by hand when done.

The script also leaves in `<log dir>`: `control-plane.log` and `incus-worker.log` (and `incus-worker-inventory.log`
where the worker runs an inventory pod, which logs the reconciler's reports) since the job was created, of the
pods alive when the module ended (a pod replaced mid-run has none) — for diagnosis; the verdict comes from the specs —
and the UI cases' screenshots (`results/*.png`, first level only), followed by the `SCREENSHOT_RESULT=` line of
`check-screenshots.py`. Its stdout line `runner: … blob=<id>` names the version of the script that ran
(`git log --all --find-object=<id>`); `head=` is the checkout's HEAD and `dirty` means `run-module.sh` in the checkout
differs from it.

Around the job, some modules need more:

- `billing` and `concurrency`: before `billing`, run `billing/seed-invoices.sql` with
  `kubectl exec -i <postgres pod> -- psql -U postgres -d titan -v ON_ERROR_STOP=1 < billing/seed-invoices.sql`; after
  `concurrency`, run `billing/check-wallets.sql` (read only): every row it prints is a finding (BIL-14). `billing` waits for
  meter ticks: about 35 minutes where the meter ticks every 10 minutes (prd), longer than one command of an agent
  lasts: start it in the background and wait for `.done` as in step 3.
- `billing`, BIL-25 and BIL-26 (the sequential run on dev; `lanes-dev-sequential.json`): its `module_env` gives
  `billing` `REGRESSION_CP_ROLL_SECONDS=180`, three meter cycles of dev. When the spec logs `CP_ROLL_WAIT`, the script
  touches `/work/bil-25/rolling`, runs `rollout restart` + `rollout status` of `deployment/control-plane` back to back for
  that long, writes every Job of CronJob `control-plane-job-meter` it saw to `<log dir>/meter-jobs.log`, prints the
  window (`BIL-25 roll window start/end` in `run.log`) and touches `/work/bil-25/rolled`; without the variable nobody
  answers and the spec skips as N/A after 10 minutes. After the module, two external steps: `meter-buckets` runs
  `billing/meter-buckets.sql` with the VM of the `BIL-25 vm` line and the window (every bucket reads `rows = 1`), and
  `sweep-credit` runs `billing/sweep-credit.sql` (a write: a Credit of 1 on admin-test nobody announced), waits one
  schedule of CronJob `control-plane-job-wallet-sweep` (2 minutes) and 30 s, then `billing/sweep-credit-check.sql` with
  the ref it printed: `Applied`, the wallet one more than before, one `TopUp` line.
- `cli`: build `openvicloud` for the node's architecture (`kubectl get nodes -o json` → `status.nodeInfo.architecture`)
  from the CLI commit the release pinned: in a clone of `OpenViCloud/titan-cli` at that commit,
  `GOOS=linux GOARCH=<arch> CGO_ENABLED=0 go build -o <out> ./cmd/openvicloud`, and pass `<out>` as `[binary]`. When
  the pod logs `BINARY_WAIT`, the script creates `/work/bin`, copies the file to `/work/bin/openvicloud`, compares the
  sha256 on both ends and touches `/work/bin/openvicloud.ready`.
- `terraform-provider`: runs after `cleanup` (`beta-user`'s network cap may leave no room beyond the run network). The binary is
  `GOOS=linux GOARCH=<arch> CGO_ENABLED=0 go test -c -o <out> .` in a clone of the provider repo at the pinned commit,
  copied like `cli`. The spec makes an API token from `beta-user`'s JWT, passes it to `-test.run TestAcc` as
  `OPENVICLOUD_TOKEN` and deletes it in `afterAll`: the secret never leaves the pod. A red run, repeated or not, is
  followed by one more `cleanup` job: `terraform-provider` is the last runner module, so nothing after it sweeps the
  `tfacc-*` resources and `rg-tok-tfp-*` tokens a red run leaves. TFP-04 and TFP-08 (by hand) are NOT COVERED when
  there is no manual path.

Specs read their URLs from `PORTAL_BASE_URL`, `ADMIN_BASE_URL` and `API_BASE_URL`, credentials from `BETA_USER_*` and
`ADMIN_TEST_*`, the control plane's meter tick from `METER_INTERVAL_MINUTES` (unset: 10, the control plane's default;
dev's overlay sets it with the control plane's `BillingMeter__IntervalMinutes`, `lib/meter.ts`), and write screenshots
to `RESULTS_DIR` as `<ID>-<what>.png`; they never print or write a credential or a bearer token. An access token lives about 10 minutes, so every call goes through `headersOf()` of `lib/auth.ts`
(it signs in again with under 2 minutes left, and on `401`), the cleanup in `finally` included. A new Playwright
version of the runner changes the image tag in `cronjob.yaml` and `cronjob-lane-b.yaml` of titan-local-cluster's
`base/regression-runner/` together with `@playwright/test@x.y.z` in `run.sh`.

## Run the lanes

A test tenant's network cap may leave no room beyond the run network, and it has one quota, so one tenant runs one module at a time. The run is split in two lanes, each
with a tenant of its own (`beta-user`, `beta-user-2`) and a CronJob of its own (`titan-regression`, `titan-regression-b`).
`lanes.json` says which module runs in which lane and where a lane waits for the other (`barrier`, `signal`/`wait`,
`external` for what the agent does outside the runner). It refuses a plan in which two modules that share a wallet or a
shared list (`exclusive`) may run together, or in which the modules that take an IPv6 /64 from the cluster
(`same_lane`) are spread over lanes. Every run (`--check` stops after this) also checks `lanes.json` against the table
below: every module the runner runs on the release environment (the Release column) is in exactly one lane, except
`smoke` and `cleanup`, which each lane runs for its own tenant (and `cleanup` runs once more after a red
`terraform-provider`). At most `max_pods` jobs run at once: the release environment is a single node. The second lane needs the test tenant `beta-user-2` and the CronJob
`titan-regression-b` in the cluster; prd's realm has no `beta-user-2` yet, so on prd the modules run one at a time
with `run-module.sh`, in the order below. What each module changes and shares is the table in `CLAUDE.md`.

The dev cluster runs fewer modules (the Dev column of the table below), so it has plans of its own, checked with `python3 run-lanes.py --check --column dev --lanes lanes-dev.json` (two lanes) or `--lanes lanes-dev-sequential.json` (one lane), and run with the same flags as below plus `--column dev --lanes <plan>`. Dev holds one pod at a time (`max_pods` 1), so those runs show that the two tenants do not disturb each other, not what load does; `test_run_lanes.py` keeps both plans covering the Dev column.

```sh
python3 run-lanes.py --kubeconfig <kubeconfig> --src <source tree> --out <work dir> --logs <evidence dir> --label <run> [--binary cli=<path>] [--binary terraform-provider=<path>] [--max-pods N]
```

A red module (or an `external` step that times out) skips the rest of its lane except steps marked `always` or
`only_if_failed` (`cleanup`); signals, waits and barriers still run, so the other lane never hangs. A red `smoke` stops
both lanes before any later step, `cleanup` included.

The `external` steps are done by the agent, who creates `<external dir>/<step>.done` when finished (`--external-dir`,
default `<work dir>/external`; `--external-timeout-minutes`, default 90): `seed-invoices` (`billing/seed-invoices.sql`
before `billing`), `check-wallets` (`billing/check-wallets.sql` after `concurrency`), `phase4` (the
Incus-host observation spec of Phase 4, `phase4/`, which the runner cannot drive: the agent runs it in lane b's tenant and does the host commands, §Phase 4; the public site, the `worker` and `control-plane-image` reads are measured once, in the sequential run).

Output: `<work dir>/<lane>/<module>[-<step label>]/` holds `run.log` and the module's `runner.log` (give those to `count-cases.py`);
`<evidence dir>/<module>/` holds the system logs and screenshots; `smoke` and `cleanup` run in every lane, so theirs are
`<module>-<lane>/` (`smoke-a`, `cleanup-b`), and a second run of a module with a step label adds it last (`cleanup-a-after-tf`).
`run-lanes.py` tells `run-module.sh` the lane (`REGRESSION_LANE`), and the first line of each system log carries it: `(lane a)`, `(lane b)`, or `(lane sequential)` for a module run by hand. The pods' logs since the job started also hold the other lane's requests. `count-cases.py` takes every lane's `runner.log` in one call and counts an ID once, by its worst mark.

## Test the tooling

Needs Node 22.18 or later (it strips the TypeScript types without a flag; CI pins 22.23.3) and Python 3. CI runs the same:

```sh
node --test 'selftest/*.test.ts'
python3 test_count_cases.py
python3 test_check_screenshots.py
python3 test_trim_cp_log.py
python3 test_check_removed_fields.py
python3 test_patch_job.py
python3 test_run_module.py
python3 test_phase4.py
python3 test_run_lanes.py
python3 run-lanes.py --check
```

## Modules and order

Rows the runner runs go in this order within a lane (`lanes.json` says which module is in which lane), one job each: a later module may use what an earlier one left in the run (the run's network); the
module that changes the tenant's state and the one that deletes the run's network come after every module that uses them,
`cleanup` after every module that leaves `rg-*` resources, and `terraform-provider` after `cleanup`, because its tests
create a network and beta-user's network cap may leave no room for it.

| # | Module | Measures | Dev | Release | Spec |
|---|---|---|---|---|---|
| 1 | `smoke` | health, clusters, anonymous catalog, clean test account, no metrics on the API host | yes | yes | yes |
| 2 | `catalog` | offerings and prices, templates per cluster, live clusters/OS images, template sync | yes | yes | yes, except CAT-14 (host, not covered), CAT-16 (host) |
| 3 | `network` | the run's network on Incus: create, Idempotency-Key, quota, overlapping CIDR, rename; public IPv6 (two networks, a /64 given back, the IPv6 quota) | yes | yes | yes, except NET-14 to NET-19 (not covered: measured by tests of the control plane), NET-20, NET-21, NET-27 (host, not covered), NET-25 (host); NET-29, NET-31 (plan only); NET-30 (host, plan only); NET-32 (not covered: measured by tests of the control plane) |
| 4 | `firewall` | rules in the network's ACL: create, delete, quota | yes | yes | yes, except FW-08 (host), FW-14 (host, not covered) |
| 5 | `vm` | VMs: create per tier (cluster named or taken from the network), stop/start, repeats and conflicts, IPv6, rename, delete; SSH keys and SSH sessions; console password, console tickets and console sessions; stop timeout | yes | yes | yes, except VM-28 (host, `L-x`), VM-30 (not covered), VM-35 (host); SSH-08 and CSL-06 (inside SSH-08) also a job of its own at the release environment's run, `vm/ssh-sessions` |
| 6 | `vm-snapshot` | VM snapshots: create, cap, revert, delete, deleted with their VM | yes | yes | yes, except VMS-14, VMS-15, VMS-20 (host, not covered), VMS-17 (host) |
| 7 | `volume` | volumes and volume snapshots: create, attach/detach, restore, delete | yes | yes | yes, except VOL-18 (host, not covered), VOL-21, VOL-22 (not covered) |
| 8 | `load-balancer` | L4 load balancer on an IPv6 network: create, VIP, reconfigure, backend VM delete refused, delete (cluster without an IPv6 block: only the negative cases that need no IPv6 network) | yes | yes | yes, except LB-12 and LB-16 (host, not covered), LB-18 (host) |
| 9 | `tenant` | tenant, quota, terms consent, approval on sign-in, the admin status route's error order | yes | yes | yes |
| 10 | `api-token` | API tokens: create, call the API with one, duplicate name/secret, delete ⇒ `401`, unknown token | yes | yes | yes |
| 11 | `cli` | `openvicloud`: version, web sign-in, `OPENVICLOUD_TOKEN`, `tenant get` matches the API, `vm ssh` + `scp` into a real VM, sign-out | yes | yes | yes, except CLI-21's power-off line read by the agent in the worker log; CLI-06..11 also a job of its own at the release environment's run, `cli/edge` |
| 12 | `billing` | metering, costs, invoices, paying from the wallet, top-ups, promo credit, `/healthz/wallet` | yes | yes | yes, except BIL-18 (not covered); BIL-14 and BIL-26 are agent SQL steps (`billing/check-wallets.sql`, `billing/sweep-credit.sql`); BIL-25 rolls the control plane only with `REGRESSION_CP_ROLL_SECONDS` (a step of the sequential run); BIL-24's invoice part skips where no invoice is older than 90 days; BIL-16's per-record part, BIL-24's and BIL-25's row counts read by the agent in SQL |
| 13 | `contract` | HTTP contract: status codes, Idempotency-Key, error envelope, auth, CORS, TLS; the metrics host behind Cloudflare Access | no: CON-09 reads the TLS certificates; dev serves plain HTTP | yes | yes, except CON-15, CON-17 (not covered) |
| 14 | `concurrency` | double clicks, invoice paid twice at once, two public IPv6 creates at once, one tenant's two creates never run at once | yes | yes | yes, except CC-14 (not covered); CC-04's command count read by the agent in SQL, CC-13's command order by the agent in the worker log |
| 15 | `admin` | admin API: networks/VMs of every tenant, VM deleted on a tenant's behalf + audit, clusters, prices; the operator metrics tier (targets, alert rules, alert delivery) and the admin portal's Metrics link | yes | yes | yes (API), except ADM-15 (`L-x`, a job of its own measured at the release environment's run: `run-module.sh` on `admin/stuck-requests`, with `REGRESSION_WORKER_APPS`), ADM-19 (not covered); ADM-17 reads services inside the cluster, so it runs only in the runner pod |
| 16 | `backup` | backup target and status API: the configured target without a secret and equal to CNPG's, 401/403, no PUT route, Test, `GET /v1/admin/backups` health of the Postgres backup and one item per VM and volume on Incus and per cluster, no wallet row; a VM snapshot waits behind its VM's backup; admin portal Backups page; daily VM and volume backups in the bucket (host, `L-x`), another cluster config the same day once a new disk's backup ended, and one config kept per UTC day (both after two `L-x` Jobs), a disk restore (host, `L-x`), and the day's restore drill into a temporary project (the schedule's own row, the host left clean, the admin portal's block); titan-db on the cluster: the `Database` objects `keycloak` (Keycloak) and `chat` (the landing assistant), ArgoCD's health checks, schema `public` for its owner only, the name CNPG archives under and `ContinuousArchiving` (`kubectl` reads) | yes | yes | yes (API and admin portal screens), except BAK-20 (`L-x`, a job of its own: `run-module.sh` on `backup/command-wait`, answered by `phase4.py bak20`), BAK-21 (host, no `L-x`, not covered: a whole-cluster restore of the release environment runs in an `ops:incident` record of titan-ops, real or drill, never in a release, `titan-ops infra/oci/runbook.md#restore-cluster-prd`), BAK-22 and BAK-23 (new spec) (`L-x`, a job of its own: `run-module.sh` on `backup/config-again`, answered by `phase4.py bak22`), BAK-24, BAK-25, BAK-26 (plan only), BAK-27 (not covered: a pool without room, a failing step and a backup that starts during a drill need a fault or a race on the real host); `(host)`, `L-x` and `kubectl` cases in Phase 4 of the release |
| 17 | `portal-ui` | customer portal end to end, signed in | no: UI-28 needs a portal without `topUpEnabled`, as the release environment's; dev's sets it (UI-07 and UI-18, which need it set, are N/A at the release environment's run) | yes | yes, except UI-02, UI-35, UI-37, UI-39 (extended); UI-42, UI-43 (new spec); UI-44 (plan only) |
| 18 | `tenant-suspend` | suspended ⇒ writes refused, reads allowed; reactivated | yes | yes | yes |
| 19 | `network-lifecycle` | deletes the run's network (with its rules), recreates the same name | yes | yes | yes |
| 20 | `login-page` | Keycloak sign-in page: layout, colours, font, brand, sign-up form, language, redirect URIs per client (no sign-in) | yes | yes | yes |
| 21 | `cleanup` | sweeps `rg-*` (and the `tfacc-*` a red `terraform-provider` run left) through the API, asserts 0 (on Incus: CLN-02, host) | yes | yes | yes |
| 22 | `terraform-provider` | the public provider: catalog, network + firewall rule, SSH key + VM + volume + attachment, load balancer (create, import, update in place, delete), plan-time validation — `go test -c` of the provider repo, run in the pod with an API token the spec makes there; after `cleanup`, because the tests create networks | no | yes | yes — `terraform-provider.spec.ts` runs `acceptance_*test.go` of the provider repo (TFP-04, TFP-08, TFP-12 by hand; TFP-11 not covered) |
| 23 | `worker` | the worker image the release environment runs comes from `OpenViCloud/titan-incus-worker`, pulls anonymously; the worker's command kinds match the control plane's, and its commands without a requestId fail for good (`go test` at the worker sha); one process reads the clusters (pod log); the Deployments by role — `gh`/`curl`/`kubectl` reads on the agent's machine | no | yes | no |
| 24 | `control-plane-image` | the control plane image the release environment runs comes from `OpenViCloud/titan-control-plane`, pulls anonymously, digest matches every pod; two to four pods with their autoscaler and disruption budget; the pod priorities of the cluster; the nine background job CronJobs and the IPv6 route seed hook — `gh`/`curl`/`kubectl` reads on the agent's machine | no | yes | no |

Steps outside the runner: before `billing` the agent runs `billing/seed-invoices.sql` (psql on the environment's
database; on the release environment an approved `L-x`), after `concurrency` it runs `billing/check-wallets.sql` (read only, BIL-14);
modules `cli` and `terraform-provider` need the agent to copy a binary into the pod when the spec logs `BINARY_WAIT`
(`cli`: the CLI built for the node's architecture; `terraform-provider`: `GOOS=linux GOARCH=<node> CGO_ENABLED=0 go test -c`
of the provider repo — `run-module.sh` copies either to `/work/bin/openvicloud`; job `cli/edge` the same as `cli`);
`cli/edge` (job `regression-edge-<label>`; CLI-06..11 through the edge of the release environment, the CLI on an API token) logs `HOLD cli10 {…}` and
waits for the agent (45 minutes at most), who answers with `phase4.py cli10` (§Phase 4): it copies `/work/cli-10/token`
and `/work/cli-10/key` out of the pod into files only it can read, runs `vm ssh <vmName> -- … 'sleep 330; echo alive'`
on its own machine with the token in `OPENVICLOUD_TOKEN` (never on the command line), `OPENVICLOUD_API_URL` set to the
environment's API and `XDG_CONFIG_HOME` pointing at an empty directory, deletes both files, then touches
`/work/results/go-cli10` (or `skip-cli10`: N/A); its `L_CLI10=` line is CLI-10's verdict; `cli/edge` and `vm/ssh-sessions` (SSH-08, CSL-06) count beta-user's SSH
and console sessions, so on the release environment they run in the sequential run, one at a time, beside no module that opens
one (`vm` and `portal-ui` open console sessions too: CSL-03…CSL-05, UI-36); `admin/stuck-requests` (ADM-15) needs the
`incus-worker` stopped and started when the spec logs `WORKER_STOP_WAIT` and `WORKER_START_WAIT` (and `incus-worker-inventory`,
where the worker runs one, since it reports the reconciler polls): `run-module.sh` does it
when `REGRESSION_WORKER_APPS` lists the ArgoCD Applications that would bring the worker back, root first (dev
`root-local,incus-worker-local`, release environment `incus-worker-prd`), and puts their auto-sync and the replicas back;
every tenant of the cluster feels it, so on the release environment it runs only under an approved `L-x` (never by
hand: without it the spec skips as N/A after 10 minutes), and only in the sequential run, never beside another module.
`backup/command-wait` (BAK-20; job `regression-command-wait-<label>`, a job of its own so the sequential run never waits
on the agent) makes a VM `rg-bak20-*`, logs `HOLD bak20 {vmId, vmName, backupKey, …}` and waits for the agent (35 minutes
at most; no answer is N/A), who answers with `phase4.py bak20` (§Phase 4): when the VM has no backup row of the day yet it creates a Job from CronJob
`control-plane-job-backup-schedule` (one pass of the hourly backup schedule: today's backup of every VM and volume of
every tenant that has none yet or whose backup of the day failed, and the cluster config once the disks of the day ended, and another config the same day when every disk's backup has ended, no config of the day is Pending or Leased,
and a disk's backup row was created after the newest config that is Done, so on the release environment only under an approved `L-x`, and only until the first
real customer; run it beside no other module, whose VMs' commands would wait behind those backups), reads the VM's rows of `core.provider_commands` in the `titan-db` primary with `psql` (`SELECT` only),
answers `go-bak20` once the VM's `vm.backup` row is `Leased`, then reads them until the backup and the snapshot's
`vm-snapshot.create` row end (or 600 s after the backup ended); its `L_BAK20=` line is the verdict of the row's SQL part.
`backup/config-again` (BAK-22 and BAK-23; job `regression-config-again-<label>`, a job of its own for the same reason)
finds the run network, waits for minute 2 of the hour unless it is between minute 2 and minute 49 (the CronJob's own
pass is due at minute 0; a wait that would cross 00:00Z is NOT COVERED), makes a VM `rg-bak22-*`, logs
`HOLD bak22 {vmId, vmName, clusterId, backupKey, vmCreatedAt, …}` and waits for the agent (40 minutes at most; no
answer is N/A), who answers with `phase4.py bak22` (§Phase 4): it creates two Jobs from the same CronJob, each one pass
of the schedule as above, the first for the VM's backup, the second, once that backup is `Done`, for the config of that
UTC hour (same `L-x` rule, same end at the first real customer, beside no other module), reads the cluster's backup rows
of the day in `core.provider_commands`, answers `go-bak22` once that config's row is `Done`, and then reads the
cluster's config rows of `core.backups`; its `L_BAK22=` line is the verdict of BAK-22's SQL part and its `L_BAK23=` line
that of BAK-23's. After the go the spec waits for `readAt` of `GET /v1/admin/backups` to pass it (11 minutes at most;
else NOT COVERED) and reads the VM's item and the cluster's config item (the API part of both rows). The second pass
may also queue the day's restore drill (an environment with `RestoreDrill:Enabled` and no drill of the day yet), which
prefers a disk never drilled (volumes first, then the lowest id), so it may name the held VM: the spec deletes that VM
at its end, so that day's BAK-25 cannot find it, and a drill leased after the delete fails reading it (BAK-24 NOT
COVERED); the schedule never asks again that day.

Not run by the runner (Phase 4 of `release:regression-prd`): `observation` — state changed on the Incus host outside
OpenViCloud, needs an approved `L-x` command (OBS-13 only reads the host's trust list), run by the agent with the
spec of `phase4/`; `site` — the public site through Playwright MCP on the agent's machine;
`worker`, `control-plane-image` — read-only `gh`/`curl`/`kubectl` and `go test` of a worker clone on the agent's machine.

Five things change state every tenant of the environment shares: ADM-06 (a global price), ADM-15 (the cluster's
`incus-worker` stopped, and `incus-worker-inventory` where it runs), `billing/seed-invoices.sql` (written straight into the database), the `L-x` writes on the
Incus host, and the Jobs of BAK-20 and BAK-22 from CronJob `control-plane-job-backup-schedule` (each a pass of every tenant's backups of the day, early). On prd they run only until the first real customer is approved
(`titan-ops status/known-state.md#first-real-customer`).
Until the specs are split or skip themselves, that stops the whole `admin` module (ADM-03 shares the serial
`admin/admin.spec.ts` with ADM-06, and `run-module.sh` runs the whole directory, ADM-08 and ADM-09 included) and CC-03
with CC-04 (CC-03 pays the invoice the seed leaves; the serial spec then skips CC-04).

**Spec** is `yes` when every case of the module in `plan.md` has a spec that ran green at a release, in the run that measures the module (dev for a module whose Dev column is `yes`, the release environment otherwise), except `(host)` cases (Phase 4
of the release), **NOT COVERED** cases (the reason is in `plan.md`) and cases not applicable to the measured
environment (the spec calls `test.skip` with the reason, e.g. VM-12 with a single cluster). A part of a row that `plan.md` gives to the agent as a read-only SQL query after the module (the cell says so: BIL-16, BIL-24, BIL-25, CC-04; BAK-20's, BAK-22's and BAK-23's are read by `phase4.py bak20` and `phase4.py bak22` during their job) is measured by that query in the run that measures the module, logged in that run's evidence, not by the spec. `ACT-*` cases are measured
in the module that owns the resource. A case with no spec yet gets one at the next release, and the cell names it as `yes, except <ID> (plan only)` until then; a case whose spec was written outside a release and has not yet run green at a release is named `<ID> (new spec)` until a release's run of its module does; a case whose row changed (more checks, or an expectation changed) in a way its spec does not check yet, or whose spec does not yet check its whole row (other than a part the agent reads in SQL, above), is named `<ID> (extended)` until the spec catches up; a case no spec can be
written for and that Phase 4 does not measure by hand is **NOT COVERED**, with the reason in its row of `plan.md`. Specs pick the first cluster with a listed template (`lib/fixtures.ts`,
`envOf()`); prd's cluster is `singapore01`.

## Phase 4

One module of this repository is run by the agent, not by `run-lanes.py`: `phase4/` (`phase4-host.spec.ts`, the
`(host)` and `observation` cases of `release:regression-prd` Phase 4: the `external` step `phase4` of `lanes.json`).
Each spec logs `HOLD <step> <facts JSON>` (`lib/host-hold.ts`) and waits for
`go-<step>` or `skip-<step>` in `/work/results/` of its pod; the agent does the host commands of the step in between.
`phase4.py` is every command the agent runs for that, so nobody writes a shell loop by hand; each `host` command and
each answer given `--log` goes to that evidence log as `[HH:MM:SSZ]` / `$ <command>` / output / `exit=<n>` (`vm35`
logs its reads, not its polls). `host` refuses (exit 2)
when the ControlMaster is not there, rather than open a connection of its own:

```bash
python3 phase4.py keys <keys dir>          # pairs v, u, x once per release, outside the repo; private halves stay there
REGRESSION_PHASE4_KEYS=<keys dir> bash run-module.sh <kubeconfig> <src tree> phase4 <label> <work dir> <log dir> &
python3 phase4.py connect --control <socket> --target <user@host> --known-hosts <pinned known_hosts>
python3 phase4.py sample --control <socket> --target <user@host> --project <t-…> --stop <file> --log <sampler log> &
# read-only, beside the run: a line per host object when it changes, ERROR lines, sample objects=<n>; ends after <file>
python3 phase4.py wait --kubeconfig <kubeconfig> --job regression-phase4-<label>     # prints the pending HOLD
python3 phase4.py host --control <socket> --target <user@host> --log <evidence log> [--keys <keys dir>] -- '<command>'
python3 phase4.py go <step> --kubeconfig <kubeconfig> --job regression-phase4-<label> --log <evidence log>
python3 phase4.py vm35 --kubeconfig <kubeconfig> --job regression-phase4-<label> --control <socket> --target <user@host> --log <evidence log>   # at HOLD vm35
python3 phase4.py step <step> --kubeconfig <kubeconfig> --job regression-phase4-<label> --control <socket> --target <user@host> --log <evidence log> --state <file outside the evidence> [--keys <keys dir>] [--guest-known-hosts <file>] [--api <API>] [--env dev]
# … step for each other HOLD (or skip), until wait prints NO_HOLD; then step cln02 (no HOLD) after the run
python3 phase4.py disconnect --control <socket> --target <user@host>
```

`run-module.sh` passes `<keys dir>/v.pub` and `u.pub` to the job as `PHASE4_KEY_V` and `PHASE4_KEY_U` (one public key
line each, or it stops before the job); `phase4/` stores V as the tenant's SSH key and puts U in a VM's cloud-init, and a
run of it without them is red at its first step. In a host command `{V}`, `{U}`, `{X}` become the base64 body of that key.
`host --local` runs a command on the agent's machine (the checks over the Internet) with the same log entry.

`step <step>` waits for that HOLD, runs the step's commands of `phase4_steps.py` (one function per HOLD of
`phase4/phase4-host.spec.ts` but `vm35`, and `cln02`), logs each like `host`, then answers `go-<step>` (`--no-go`: the
agent reads the log first and answers with `go` or `skip`; a host write that fails stops the step, exit 1, no
answer). A command marked outside runs from outside the cluster:
this machine on the release environment, the host with `--env dev` (the spec's `FROM_OUTSIDE`). The facts of
`HOLD setup` (the project, the names later holds lack) and the values a step records for a later one (the image
`obs05` found behind the template alias, which `obs05-after-sync` deletes only once the alias points elsewhere) are kept
in the `--state` file, a working file outside the evidence, one per run. Whether an output matches the plan row stays the agent's
call; 18 steps write on the host (`WRITES` of `phase4_steps.py`), so they run only under the release's approved `L-x`.
A step runs nothing (exit 2) when a value it needs is missing: `setup` wants `--api`, `ssh06` `--keys` and
`--guest-known-hosts` (the known_hosts file for the guests), `vm24-restart` `--keys`. `setup` clears the values recorded
by an earlier run, and a failed read records none.

At `HOLD cli10` of `cli/edge` (job `regression-edge-<label>`), `phase4.py cli10 --kubeconfig <kubeconfig> --job
regression-edge-<label> --cli <openvicloud for this machine> --api <API> --log <evidence log>` copies the token and the
key out of the pod into a directory only it reads, runs `vm ssh <vmName> -- … 'sleep 330; echo alive'` with the token
in `OPENVICLOUD_TOKEN` (never in an argument or the log) and an empty `XDG_CONFIG_HOME`, deletes the directory, answers
`go-cli10`, and ends the log with `L_CLI10=PASS` (exit 0) or `L_CLI10=FAIL <what>` (exit 1); when the token or the
key cannot be copied out it answers `skip-cli10` and ends with `L_CLI10=NOT_COVERED <why>` (exit 4).

At `HOLD bak20` of `backup/command-wait` (job `regression-command-wait-<label>`), `phase4.py bak20 --kubeconfig
<kubeconfig> --job regression-command-wait-<label> --log <evidence log>` reads, in the pod of
`-l cnpg.io/cluster=titan-db,cnpg.io/instanceRole=primary` (any namespace),
`psql -U postgres -d titan -At -F '|' -c "SELECT kind, key, status, attempts FROM core.provider_commands WHERE resource_id = '<vmId>' ORDER BY created_at, key"`
(every `--every` seconds, default 3; logged when the rows change). The first read failing ⇒ `skip-bak20`, `L_BAK20=NOT_COVERED`
(exit 4). Today's `vm.backup` row (`backupKey` of the hold)
already `Done` or `Failed` ⇒ `skip-bak20`, `L_BAK20=NOT_COVERED` (exit 4); no row yet ⇒ `kubectl create job
rg-bak20-<epoch> --from=cronjob/control-plane-job-backup-schedule` in the control plane's namespace (a row the hourly
pass queued already needs none; the Job not created ⇒ skip, NOT_COVERED). Once the row is `Leased` it answers `go-bak20` (not `Leased` within
`--leased-minutes`, default 30, or ended first ⇒ skip, NOT_COVERED), the spec posts the VM snapshot, and the reads go on
until the backup and the snapshot's row have ended, or 600 s after the backup ended (`--watch-minutes`, default 45); then it deletes the Job it created.
Last line `L_BAK20=PASS` (exit 0: every read with the backup `Leased` had the snapshot's row `Pending` with `attempts` 0,
both rows ended `Done`), `FAIL <what>` (exit 1), or `NOT_COVERED <why>` (exit 4; after go: no read had the snapshot's
row while the backup was `Leased`).

At `HOLD bak22` of `backup/config-again` (job `regression-config-again-<label>`), `phase4.py bak22 --kubeconfig
<kubeconfig> --job regression-config-again-<label> --log <evidence log>` reads, in the same pod,
`psql -U postgres -d titan -At -F '|' -c "SELECT …"` on `core.provider_commands`: the rows of the held cluster
(`cluster_id`) of kind `vm.backup`, `volume.backup`, `cluster.backup` and `restore.drill` whose key ends in the hold's
UTC day (or that day and an hour), each line led by the database's clock, which gives every time of day below (its own
waits run on this machine's clock, and the spec's wait from the HOLD line's stamp, the runner pod's clock, against it) (every `--every` seconds, default 5; logged when the rows
change, and the clock of the reads before and after each Job, of the read that saw the config `Done` and of the first
bucket read after it always). It creates a Job only from minute 3 of an hour, while `kubectl get cronjob
control-plane-job-backup-schedule` shows no Job running, and with `--job-minutes` (default 2) and one more before the
next hour (the CronJob's own pass is due at minute 0, may start 120 s late and retries its pod): it reads on until then
(before the first Job `--gate-minutes`, default 8, before the second the settle wait below; else NOT COVERED). It
creates no Job when the budgets of the waits after it would end after the spec stops waiting (`--hold-minutes`,
default 40, from the HOLD line). In order, each ⇒ `skip-bak22` and `L_BAK22=NOT_COVERED <why>`: the first read fails (a later failed read is
read again); the database's day is not the hold's; a config of the day was created at or after the VM (`vmCreatedAt`); no
config of the day is `Done`; the VM's `vm.backup` row (`backupKey`) is there already (the CronJob's own pass queued it).
It then runs a first pass, `kubectl create job rg-bak22a-<epoch> --from=cronjob/control-plane-job-backup-schedule` in
the control plane's namespace, and reads the Job until a pod succeeded (`--job-minutes`; not created, or not completed
in time ⇒ skip, NOT_COVERED; the Job `Failed` ⇒ skip, `L_BAK22=FAIL`, the last 5 lines of the Job's log in the
evidence log: its `curl --fail-with-body` got an error from the pass, or did not reach the control plane). A read after it in the next hour ⇒ skip, NOT_COVERED; the pass queued no row for the VM ⇒ skip, FAIL; the VM's
backup not ended within `--backup-minutes` (default 15), with the cluster's other disk backups that wait named, or
ended `Failed` ⇒ skip, NOT_COVERED with `attempts` and `last_error`; a wait whose last read fails ⇒ skip,
NOT_COVERED. It waits until no `vm.backup`, `volume.backup` or
`cluster.backup` row of the day is `Pending` or `Leased` (`--settle-minutes`, default 6; the first pass reopened the
day's `Failed` ones), and that read is the one right before the second pass: another day than the hold's, the VM's backup no
longer `Done`, a config, or another disk's backup, created after the VM's backup row, or the key `cluster-backup-<clusterId>-<yyyyMMddHH>` of the hour there already ⇒ skip,
NOT_COVERED. The second pass is `rg-bak22b-<epoch>`, read the same way: a read after it in the next hour ⇒ skip,
NOT_COVERED; no new key `cluster-backup-<clusterId>-<yyyyMMdd><HH>` ⇒ skip, NOT_COVERED when a disk's backup row is new
instead (another disk was created in between), else `L_BAK22=FAIL`; a key of another hour than the read before it ⇒
FAIL; that config `Failed` ⇒ skip, FAIL; not ended within `--config-minutes` (default 4) ⇒ skip, NOT_COVERED; read
`Done` on another day ⇒ skip, NOT_COVERED. Once it is `Done` the command answers `go-bak22` (`L_BAK22=PASS`; the spec
no longer waiting ⇒ NOT_COVERED). A `restore.drill` row the second pass queued is named on the `L_BAK22=` line.
For BAK-23 it then reads `core.backup_observations` (kind `incus`) joined to the cluster's rows of `core.backups`
(kind `cluster`) until that observation's `last_read_at` is a later second than the read that saw the config `Done`
(one pass of CronJob `control-plane-job-backup-status` stamps it and `readAt` with the same instant; `--read-minutes`,
default 12, else `L_BAK23=NOT_COVERED`), and judges that first later read: outcome not `Read`, or another day ⇒
NOT_COVERED; else one row of the hold's day, taken later than the VM's backup row was created and the newest of all,
at most one for any other UTC day, at most 7 days (`L_BAK23=PASS days=<n> today=<backup key>` or `FAIL <what>`). It
deletes the Jobs it created, on every way out. Last two lines `L_BAK22=` and `L_BAK23=` (exit 2 prints neither); exit 1 when one is `FAIL`,
else 4 when one is `NOT_COVERED`, else 0; an error of the command itself after the hold was read ends `NOT_COVERED`
(exit 4: before the go it answers `skip-bak22`, after it `L_BAK22=` keeps its `PASS`), facts out of shape answer
`skip-bak22` (exit 2). BAK-23 is measured only when the spec
took the go. The spec's three tests are the API part: the
VM's item and the cluster's config item read after the go, that config item `Ok` (`BAK-22 and BAK-23 …`), and taken
after the VM's (`BAK-22 the VM's backup …`); they skip as NOT COVERED after `skip-bak22`, whatever the `L_BAK22=` line says.

At `HOLD vm35` of `phase4/`, `phase4.py vm35` waits for a `status:` line from `cloud-init status --wait` in the held VM,
reads `getent shadow ubuntu`, `passwd -S ubuntu` and `cloud-init.vendor-data` of it and of the held VM without a console
password, then hashes in the pod the password file the spec left there (`openssl passwd -6` with the salt read from the
shadow) and greps the vendor-data for it, so the password is in no log. Last line `VM35_HOST=PASS` (exit 0), `FAIL <what>`
(exit 1, `go-vm35` still created) or `NOT_COVERED <why>` (exit 4, `skip-vm35`). The VM-35 test has no check of its own
after the hold: its ✓ in the runner log says the hold was answered, and the case's verdict is the `VM35_HOST=` line.

## License

[Mozilla Public License 2.0](LICENSE).
