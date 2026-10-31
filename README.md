# titan-regression — OpenViCloud's regression suite

The durable regression suite of [OpenViCloud](https://github.com/OpenViCloud). Every behaviour that must still
hold at the next release has a case in [`plan.md`](plan.md) and, once written, a Playwright spec here. Before each
release the whole suite runs against the release environment (production, `prd`); a release pins the commit of this
repository it ran.

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
| `run-lanes.py`, `lanes.json`, `lanes-dev.json`, `lanes-dev-sequential.json` | Runs the modules as lanes, one lane per test tenant, lanes side by side (below); the two dev plans cover the Dev column |
| `patch-job.py` | Points a job's `specs` volume at a ConfigMap of its own, so jobs started together never read each other's specs |
| `selftest/`, `test_*.py` | Tests of the helpers and scripts above |
| [`CLAUDE.md`](CLAUDE.md) | How specs are written and the assumptions a run on the release environment makes |

## Run one module

```sh
bash run-module.sh <kubeconfig> <source tree> <module> <label> <work dir> <log dir> [binary]
python3 count-cases.py <work dir of each module>/runner.log ...
```

The source tree is `git archive <sha>` of this repository, extracted, with any new specs copied in; run the
script from a checkout so its first line names the commit. What the script does inside the cluster, and what some
modules need around it, is the next section. The full procedure of a release (order, verdict, evidence) is
`release:regression` (a skill of titan-ops, private).

## Inside a module run

`run-module.sh` does these five steps; they are written out so a run that stopped half-way can be finished or cleaned
up by hand.

1. **Load the specs** into a ConfigMap of the job's own, `titan-regression-specs-<job>` (`<job>` is
   `regression-<module>-<label>`): `kubectl create configmap titan-regression-specs-<job> --from-file=lib --from-file=<module> --dry-run=client -o yaml | kubectl apply -f -`
   in the source tree (a one-off spec: `--from-file=<its directory>`). The runner loads `/specs/*.ts` flat, so a file
   name shared by `lib/` and the module makes `create configmap` refuse: rename it, never overwrite.
2. **Start the job** from the lane's CronJob (`titan-regression`; lane b `titan-regression-b`):
   `kubectl create job <job> --from=cronjob/<cronjob> --dry-run=client -o json | python3 patch-job.py titan-regression-specs-<job> | kubectl create -f -`
   (`patch-job.py` points the job's `specs` volume at that ConfigMap).
3. **Wait** for the job's own pod to be `Running` (`--field-selector=status.phase=Running`: a recreated job leaves its
   old pod behind), then poll `kubectl exec <pod> -- test -f /work/results/.done`; stop as soon as the pod is `Failed` or
   `Succeeded` (the runner exits early, for example `NO_SPECS`, without writing `.done`). Then read `REGRESSION_EXIT=`
   from `kubectl logs <pod>` (not `-f`).
4. **Copy the results** (`kubectl cp <pod>:/work/results …`) while the pod is still held (30 minutes by default), in
   the same step as 3, and compare the sha256 of every file with `sha256sum` in the pod; a file that differs is copied
   again in chunks (`dd bs=16384 skip=N count=1 | base64`) until it matches.
5. **Delete the job and its ConfigMap** once every file matched. A mismatch (or `NO_POD`, `POD_NOT_STARTED`,
   `BINARY_SHA_MISMATCH`) exits 1 and keeps both for a look: delete both by hand when done.

The script also leaves in `<log dir>`: `control-plane.log` and `incus-worker.log` since the job was created, of the
pods alive when the module ended (a pod replaced mid-run has none) — for diagnosis; the verdict comes from the specs —
and the UI cases' screenshots (`results/*.png`, first level only), followed by the `SCREENSHOT_RESULT=` line of
`check-screenshots.py`. Its stdout line `runner: … blob=<id>` names the version of the script that ran
(`git log --all --find-object=<id>`); `head=` is the checkout's HEAD and `dirty` means `run-module.sh` in the checkout
differs from it.

Around the job, some modules need more:

- `billing` and `concurrency`: before `billing`, run `billing/seed-invoices.sql` with
  `kubectl exec -i <postgres pod> -- psql -U postgres -d titan -v ON_ERROR_STOP=1 < billing/seed-invoices.sql`; after
  `concurrency`, run `billing/check-wallets.sql` (read only): every row it prints is a finding (BIL-14). `billing` takes
  about 35 minutes (it waits for 10-minute meter ticks), longer than one command of an agent lasts: start it in the
  background and wait for `.done` as in step 3.
- `cli`: build `openvicloud` for the node's architecture (`kubectl get nodes -o json` → `status.nodeInfo.architecture`)
  from the CLI commit the release pinned: in a clone of `OpenViCloud/titan-cli` at that commit,
  `GOOS=linux GOARCH=<arch> CGO_ENABLED=0 go build -o <out> ./cmd/openvicloud`, and pass `<out>` as `[binary]`. When
  the pod logs `BINARY_WAIT`, the script creates `/work/bin`, copies the file to `/work/bin/openvicloud`, compares the
  sha256 on both ends and touches `/work/bin/openvicloud.ready`.
- `terraform-provider`: runs after `cleanup` (`beta-user` may hold only one network). The binary is
  `GOOS=linux GOARCH=<arch> CGO_ENABLED=0 go test -c -o <out> .` in a clone of the provider repo at the pinned commit,
  copied like `cli`. The spec makes an API token from `beta-user`'s JWT, passes it to `-test.run TestAcc` as
  `OPENVICLOUD_TOKEN` and deletes it in `afterAll`: the secret never leaves the pod. A red run, repeated or not, is
  followed by one more `cleanup` job: `terraform-provider` is the last runner module, so nothing after it sweeps the
  `tfacc-*` resources and `rg-tok-tfp-*` tokens a red run leaves. TFP-04 and TFP-08 (by hand) are NOT COVERED when
  there is no manual path.

Specs read their URLs from `PORTAL_BASE_URL`, `ADMIN_BASE_URL` and `API_BASE_URL`, credentials from `BETA_USER_*` and
`ADMIN_TEST_*`, and write screenshots to `RESULTS_DIR` as `<ID>-<what>.png`; they never print or write a credential or
a bearer token. An access token lives about 10 minutes, so every call goes through `headersOf()` of `lib/auth.ts`
(it signs in again with under 2 minutes left, and on `401`), the cleanup in `finally` included. A new Playwright
version of the runner changes the image tag in `cronjob.yaml` and `cronjob-lane-b.yaml` of titan-local-cluster's
`base/regression-runner/` together with `@playwright/test@x.y.z` in `run.sh`.

## Run the lanes

`beta-user` may hold one network and one quota, so one tenant runs one module at a time. The run is split in two lanes, each
with a tenant of its own (`beta-user`, `beta-user-2`) and a CronJob of its own (`titan-regression`, `titan-regression-b`).
`lanes.json` says which module runs in which lane and where a lane waits for the other (`barrier`, `signal`/`wait`,
`external` for what the agent does outside the runner). It refuses a plan in which two modules that share a wallet or a
shared list (`exclusive`) may run together, or in which the modules that take an IPv6 block from the cluster
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
Incus-host observation spec of Phase 4, which the runner cannot drive: the agent runs it in lane b's tenant and does the host commands; the public site, the `worker` and `control-plane-image` reads are measured once, in the sequential run).

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
python3 test_patch_job.py
python3 test_run_lanes.py
python3 run-lanes.py --check
```

## Modules and order

Rows the runner runs go in this order within a lane (`lanes.json` says which module is in which lane), one job each: a later module may use what an earlier one left in the run (the run's network); the
module that changes the tenant's state and the one that deletes the run's network come after every module that uses them,
`cleanup` after every module that leaves `rg-*` resources, and `terraform-provider` after `cleanup`, because its tests
create a network and beta-user may hold one.

| # | Module | Measures | Dev | Release | Spec |
|---|---|---|---|---|---|
| 1 | `smoke` | health, clusters, anonymous catalog, clean test account | yes | yes | yes |
| 2 | `catalog` | offerings and prices, templates per cluster, live clusters/OS images, template sync | yes | yes | yes |
| 3 | `network` | the run's network on Incus: create, Idempotency-Key, quota, overlapping CIDR, rename | yes | yes | yes |
| 4 | `firewall` | rules in the network's ACL: create, delete, quota | yes | yes | yes |
| 5 | `vm` | VMs: create per tier, stop/start, repeats and conflicts, IPv6, rename, delete; SSH keys | yes | yes | yes |
| 6 | `vm-snapshot` | VM snapshots: create, cap, revert, delete, deleted with their VM | yes | yes | yes |
| 7 | `volume` | volumes and volume snapshots: create, attach/detach, restore, delete | yes | yes | yes |
| 8 | `load-balancer` | L4 load balancer on an IPv6 network: create, VIP, reconfigure, backend VM delete refused, delete (cluster without an IPv6 block: negative cases only) | yes | yes | yes |
| 9 | `tenant` | tenant, quota, terms consent, approval on sign-in | yes | yes | yes |
| 10 | `api-token` | API tokens: create, call the API with one, duplicate name/secret, delete ⇒ `401`, unknown token | yes | yes | yes |
| 11 | `cli` | `openvicloud`: version, web sign-in, `OPENVICLOUD_TOKEN`, `tenant get` matches the API, `vm ssh` + `scp` into a real VM, sign-out | yes | yes | yes |
| 12 | `billing` | metering, costs, invoices, paying from the wallet, top-ups, promo credit, `/healthz/wallet` | no | yes | yes |
| 13 | `contract` | HTTP contract: status codes, Idempotency-Key, error envelope, auth, CORS, TLS | no | yes | yes |
| 14 | `concurrency` | double clicks, invoice paid twice at once | no | yes | yes |
| 15 | `admin` | admin API: networks/VMs of every tenant, VM deleted on a tenant's behalf + audit, clusters, prices (admin portal screens: deferred) | no | yes | yes (API) |
| 16 | `backup` | backup target and status API: the configured target without a secret and equal to CNPG's, 401/403, no PUT route, Test, `GET /v1/admin/backups` health of the Postgres backup and one item per VM and volume on Incus, no wallet row; admin portal Backups page; daily VM and volume backups in the bucket and a disk restore (host, `L-x`); titan-db on the cluster: Keycloak's database `keycloak` as a `Database` object, ArgoCD's health checks, schema `public` for its owner only, the name CNPG archives under and `ContinuousArchiving` (`kubectl` reads) | no | yes | yes (API and admin portal screens); `(host)`, `L-x` and `kubectl` cases in Phase 4 of the release |
| 17 | `portal-ui` | customer portal end to end, signed in | no | yes | yes |
| 18 | `tenant-suspend` | suspended ⇒ writes refused, reads allowed; reactivated | no | yes | yes |
| 19 | `network-lifecycle` | deletes the run's network (with its rules), recreates the same name | yes | yes | yes |
| 20 | `login-page` | Keycloak sign-in page: layout, colours, font, brand, sign-up form, language, redirect URIs per client (no sign-in) | yes | yes | yes |
| 21 | `cleanup` | sweeps `rg-*` (and the `tfacc-*` a red `terraform-provider` run left) through the API, asserts 0 (on Incus: CLN-02, host) | yes | yes | yes |
| 22 | `terraform-provider` | the public provider: catalog, network + firewall rule, SSH key + VM + volume + attachment, load balancer (create, import, update in place, delete), plan-time validation — `go test -c` of the provider repo, run in the pod with an API token the spec makes there; after `cleanup`, because the tests create networks | no | yes | yes — `terraform-provider.spec.ts` runs `acceptance_*test.go` of the provider repo (TFP-04, TFP-08 by hand) |
| 23 | `worker` | the worker image the release environment runs comes from `OpenViCloud/titan-incus-worker`, pulls anonymously; the worker's command kinds match the control plane's — `gh`/`curl`/`kubectl` reads on the agent's machine | no | yes | no |
| 24 | `control-plane-image` | the control plane image the release environment runs comes from `OpenViCloud/titan-control-plane`, pulls anonymously, digest matches the pod — `gh`/`curl`/`kubectl` reads on the agent's machine | no | yes | no |

Steps outside the runner: before `billing` the agent runs `billing/seed-invoices.sql` (psql on the environment's
database; on the release environment an approved `L-x`), after `concurrency` it runs `billing/check-wallets.sql` (read only, BIL-14);
modules `cli` and `terraform-provider` need the agent to copy a binary into the pod when the spec logs `BINARY_WAIT`
(`cli`: the CLI built for the node's architecture; `terraform-provider`: `GOOS=linux GOARCH=<node> CGO_ENABLED=0 go test -c`
of the provider repo — `run-module.sh` copies either to `/work/bin/openvicloud`).

Not run by the runner (Phase 4 of `release:regression`): `observation` — state changed on the Incus host outside
OpenViCloud, needs an approved `L-x` command; `site` — the public site through Playwright MCP on the agent's machine;
`worker`, `control-plane-image` — read-only `gh`/`curl`/`kubectl` on the agent's machine.

Three things change state every tenant of the environment shares: ADM-06 (a global price), `billing/seed-invoices.sql`
(written straight into the database) and the `L-x` writes on the Incus host. On prd they run only until the first real
customer is approved (`titan-ops status/known-state.md#first-real-customer`).
Until the specs are split or skip themselves, that stops the whole `admin` module (ADM-03 shares the serial
`admin/admin.spec.ts` with ADM-06, and `run-module.sh` runs the whole directory, ADM-08 and ADM-09 included) and CC-03
with CC-04 (CC-03 pays the invoice the seed leaves; the serial spec then skips CC-04).

**Spec** is `yes` when every case of the module in `plan.md` has a spec that ran green on the release environment at a release, except `(host)` cases (Phase 4
of the release), **NOT COVERED** cases (the reason is in `plan.md`) and cases not applicable to the measured
environment (the spec calls `test.skip` with the reason, e.g. VM-12 with a single cluster). `ACT-*` cases are measured
in the module that owns the resource. A case with no spec yet gets one at the next release; a case no spec can be
written for and that Phase 4 does not measure by hand is **NOT COVERED**, with the reason in its row of `plan.md`. Specs pick the first cluster with a listed template (`lib/fixtures.ts`,
`envOf()`); prd's cluster is `singapore01`.

## License

[Mozilla Public License 2.0](LICENSE).
