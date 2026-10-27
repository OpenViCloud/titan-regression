# CLAUDE.md

Bộ spec regression **bền** của OpenViCloud: mọi hành vi còn đúng ở release sau có một case trong [`plan.md`](plan.md) và một spec ở đây. Quy trình (ai thêm case, ai viết spec, chạy thế nào) sống ở repo [`OpenViCloud/titan-ops`](https://github.com/OpenViCloud/titan-ops): `iteration:enhance-regression-plan` thêm case của story vào `plan.md` sau mỗi lần deploy dev; [`release:regression`](https://github.com/OpenViCloud/titan-ops/blob/main/.claude/commands/release/regression.md) viết spec cho case chưa có spec rồi chạy **hết** repo này trên staging, ở sha `release-plan.md` ghim. Bảng module và thứ tự: [README](README.md).

Repo này không có hệ thống nào để chạy: spec chạy bằng runner `titan-regression` (lane B: `titan-regression-b`) trong cụm (manifest ở `OpenViCloud/titan-local-cluster:base/regression-runner/`), không trên máy agent. CI chỉ chạy test của tooling (`selftest/`, `test_*.py`).

## Cây thư mục

```
├── README.md        # tiếng Anh: là gì, chạy thế nào, bảng module (cột Spec)
├── CLAUDE.md        # file này: luật viết spec, giả định khi chạy trên staging
├── plan.md          # mọi case: ID, kỳ vọng, nguồn
├── run-module.sh    # một module = một job runner: nạp spec, chờ .done, chép kết quả + so sha256, xoá job và ConfigMap của nó;
│                   #   kubeconfig là tham số đầu (staging hay dev), $REGRESSION_CRONJOB chọn CronJob của lane (mặc định
│                   #   titan-regression), $REGRESSION_LANE (a, b; mặc định sequential) là nhãn ở dòng đầu log pod, ConfigMap spec riêng mỗi job (titan-regression-specs-<job>),
│                   #   cli và terraform-provider: chép binary khi BINARY_WAIT;
│                   #   output runner vào thư mục làm việc (không commit), log control-plane + incus-worker
│                   #   vào thư mục log, in `runner: … blob=<id>`; chép ảnh UI case (results/*.png) vào thư mục log
│                   #   rồi chạy check-screenshots.py
├── check-screenshots.py  # UI case (test lái trình duyệt) phải gọi screenshot vào ${RESULTS}/<ID>-; với runner.log:
│                   #   UI case ✓ phải có <ID>-*.png — python3 check-screenshots.py <module>
├── count-cases.py   # đếm ID của plan.md với dòng ✓/✘/- của các runner.log (mở rộng dải X-01..03)
├── trim-cp-log.py   # run-module.sh lọc control-plane.log: bỏ dòng info của hosting, routing, SQL command (warn/fail và log Titan giữ)
├── run-lanes.py     # xếp lịch hai lane (mỗi lane một tenant test, chạy song song): đọc lanes.json, barrier/signal/wait/external,
│                   #   từ chối lịch để hai module cùng nhóm đụng chung (ví, danh sách topup Pending) chạy chồng hoặc để ba module lấy /64 IPv6 tách lane; --check đối chiếu lanes.json với README
│                   #   (--column dev --lanes lanes-dev*.json: kế hoạch cho cụm dev, đối chiếu cột Dev)
├── lanes.json       # module nào chạy ở lane nào, lane chờ nhau ở đâu
├── lanes-dev.json, lanes-dev-sequential.json  # cùng thứ cho cụm dev: hai lane / một lane, chỉ module có Dev = yes, max_pods 1
├── patch-job.py     # trỏ volume `specs` của một job vào ConfigMap riêng của nó (run-module.sh dùng)
├── test_*.py        # test của các script trên — python3 test_count_cases.py …
├── selftest/        # test của lib không cần Playwright; ngoài lib/ vì runner chép mọi file của lib/ vào e2e/ và `testMatch`
│                   #   mặc định của Playwright chạy cả *.test.ts — node --test 'selftest/*.test.ts' (Node ≥ 22.18 tự bỏ phần
│                   #   type của TypeScript, không cài gì; dạng thư mục `node --test selftest/` không chạy)
├── lib/             # helper dùng chung, nạp cùng MỌI module
│   ├── auth.ts      #   headersOf('tenant' | 'admin'): đăng nhập trong pod, lại khi token còn < 2 phút hoặc gặp 401
│   ├── api.ts       #   gọi API, Idempotency-Key, poll tới khi current đạt đích
│   ├── edge-retry.ts  # gửi lại một lần: connect timeout (mọi method, request chưa rời runner); GET gặp socket hỏng hoặc trang HTML của edge. Ghi gặp lỗi khác thì không gửi lại
│   ├── clean-up.ts  #   cleanUp(steps) cho afterAll: chạy hết mọi bước dọn, gom lỗi, ném một lần ở cuối — một lỗi mạng không để lại quota nâng
│   ├── fixtures.ts  #   tên rg-<loại>-<lượt>, chọn cluster/template/tier theo env, tìm-hoặc-tạo network của lượt
│   ├── token.ts     #   newSecret(): bí mật token API ovc_…; callWithToken(): gọi API bằng token thay JWT
│   └── local-proxy.ts  # tự bật khi URL là *.localhost (local-mac: issuer Keycloak mang cổng 8080)
└── <module>/*.spec.ts
```

## Viết spec

- Spec của case nằm ở `<module>/`, **ID trong tên test** (`test('VM-03 stop từ Running', …)`), nguồn của kỳ vọng ở comment đầu test — đọc lại code ở chỗ cột **Nguồn** của `plan.md` trỏ tới. Luật ghi nguồn ở đầu `plan.md` (nguồn duy nhất của luật này): file trong repo này ghi `file:line`; repo khác ghi `<repo>:<path>` kèm tên hàm/type/method/test, **không** số dòng (trừ ref ghim một commit), mỗi ref tự mang repo (và sha nếu ghim; không khai repo một lần cho cả mục hay cả file, không viết tắt `:<line>` nối vào ref trước); doc của titan-ops trong `plan.md` là link đầy đủ kèm `#anchor`, trong comment spec `OpenViCloud/titan-ops:docs/…#anchor`. Ref cũ còn số dòng là rủi ro chấp nhận, sửa khi chạm. Kỳ vọng không có nguồn là đoán.
- Mọi case của module có spec chạy xanh ⇒ cột **Spec** của README = `yes`. Spec mới và dòng README vào cùng PR.
- Runner nạp **phẳng** (`/specs/*.ts`): spec import helper bằng `./auth`, không `../lib/auth`. Tên file không trùng giữa `lib/` và module.
- Mọi tài nguyên test mang tên `rg-<loại>-<lượt>` (`<lượt>` = thời điểm job bắt đầu, base36); network của lượt là `rg-net-<lượt>`, module sau tìm nó theo tiền tố. Module nào tạo thì `finally` của module đó xoá — trừ network của lượt, do `network-lifecycle` xoá; module `cleanup` quét lại.
- Mỗi tenant test (`beta-user`, `beta-user-2`) có `MaxNetworks = 1` ⇒ mọi module của một lane cần network dùng chung **một** network của lượt (`fixtures.ts`); network sống từ trước của tài khoản test làm `NETWORK_QUOTA_EXCEEDED` ⇒ `smoke` báo đỏ ngay, không để module sau đỏ lan.
- Mỗi test lái trình duyệt (UI case) chụp ≥ 1 ảnh `${RESULTS}/<ID>-<gì>.png` ở điểm an toàn (form đăng nhập rỗng hoặc đã qua, không token trên màn); release commit ảnh làm evidence — §Evidence (hàng **Ảnh UI**) của `release:regression`.
- Tiền chỉ đụng `admin-test` hoặc hoá đơn seed của chính lượt đó. Ví `beta-user` và `beta-user-2` là dữ liệu sống lâu — đọc, không ghi (trừ ADM-08: cộng 1 ₫ có chủ ý, xem bảng dưới).
- Comment trong spec theo [code-comments](https://github.com/OpenViCloud/titan-ops/blob/main/docs/architecture/code-comments.md#what-a-comment-holds): không mã iteration/story, không trỏ `docs/iterations/` của titan-ops.
- Commit và PR chỉ nêu người làm: không `Co-Authored-By: Claude …`, không dòng nói code viết bằng AI (`.claude/settings.json` tắt attribution).

## Dữ liệu dùng chung giữa các lane

Hai lane (`lanes.json`) chạy cùng lúc, mỗi lane một tenant test; `admin-test` và mọi thứ toàn cluster là chung. Bảng dưới là phép đọc từng spec: module nào đổi quota, trạng thái hay dữ liệu lâu dài của tenant lane (tài nguyên `rg-*` tạo rồi xoá không kể), và cái gì nó đụng mà lane kia cũng đụng. `test_run_lanes.py` đối chiếu cột lane với `lanes.json` (đúng một hàng mỗi module, đúng lane). Module mới hay đổi lane ⇒ sửa hàng ở đây cùng PR.

| Module | Lane | Đổi ở tenant của lane (trả lại nếu có ghi) | Chung giữa các lane |
|---|---|---|---|
| `smoke` | a, b | không | không |
| `catalog` | a | không | `POST /v1/admin/templates/sync` đổi alias template của cluster (chấp nhận: lane kia tạo VM từ template cùng lúc, rủi ro thấp) |
| `network` | a | tạo network của lane (một slot) | không |
| `firewall` | a | không | không (cap 20 rule mặc định) |
| `vm` | a | VM-15 đặt `maxVms` = số VM đang đếm + 1, trả lại | không |
| `vm-snapshot` | a | không | không (cap 3 mặc định) |
| `volume` | a | không | không (cap 10 mặc định) |
| `load-balancer` | a | nâng `maxNetworks`, trả lại | lấy một /64 IPv6 từ khối của cluster |
| `tenant` | a | TEN-02 nâng `maxVms` thêm 1 (trả lại `maxVms` và `maxNetworks`); TEN-08 cũng vậy, đọc và trả lại cả 9 cap | đọc `/v1/tenants` (mọi tenant), chọn hàng theo id |
| `api-token` | a | không | không |
| `cli` | a | đồng ý điều khoản (bản ghi lâu dài) | không |
| `contract` | a | đổi tên network của lane, trả lại | không (không đụng ví) |
| `billing` | b | đo usage trên tenant của lane | ví `admin-test` (ghi, assert đúng số); danh sách topup Pending (BIL-10 tạo một cái tạm); audit log (BIL-07 ghi một dòng); giá tier và volume offering mà nó so chi phí |
| `concurrency` | a | không | ví `admin-test` (assert đúng số, trả hoá đơn 4444 do `seed-invoices.sql` của lane b) |
| `admin` | a | cộng 1 ₫ vào ví tenant của lane (ADM-08), đổi rồi trả `debtCeiling` | danh sách topup Pending (ADM-08 đòi nút Confirm trên mọi hàng Pending); audit log của mọi tenant; giá một tier +1 rồi trả (ADM-06, tier khác với tier của `billing`) |
| `portal-ui` | a | nâng `maxNetworks` (IPv6), để lại topup Pending | lấy một /64 IPv6 từ khối của cluster |
| `tenant-suspend` | a | treo tenant của lane rồi trả `Active` | không |
| `network-lifecycle` | a | xoá và tạo lại network của lane | không |
| `login-page` | a | không | realm Keycloak (chỉ đọc) |
| `cleanup` | a, b | xoá mọi `rg-*`/`tfacc-*` của tenant lane | không |
| `terraform-provider` | a | tạo network, firewall rule, SSH key, VM, volume, LB bằng token của lane (token tạo rồi xoá) | lấy một /64 IPv6 từ khối của cluster |

Luật rút ra, ghi ở `lanes.json`: `billing`↔`concurrency` (cùng ví `admin-test`) và `billing`↔`admin` (cùng danh sách topup Pending: topup tạm của BIL-10 làm ADM-08 gặp một hàng Pending lạ; cùng audit log và giá tier) không chồng nhau (`exclusive`); ba module lấy /64 IPv6 (`load-balancer`, `portal-ui`, `terraform-provider`) ở chung một lane (`same_lane`), vì hai lane cùng chọn một /64 thì tranh nhau chỉ mục unique. `contract` không đụng ví nên không bị khoá. Locator tìm hàng theo tên tenant bằng khớp chuỗi con (`hasText: 'beta-user'`) khớp cả hàng `beta-user-2`: tìm theo id, hoặc khớp có chặn đuôi `-<chữ>` như `tenantRowOf()` của `admin/admin-portal.spec.ts`.

## Giả định khi chạy trên staging (dữ liệu sống lâu)

- Cap per-resource đọc từ hằng mặc định của `TenantQuota` (20 rule/network, 3 snapshot/VM, 3 snapshot/volume) vì không API nào đọc được. Cap volume (10) nay `GET /v1/tenant` trả ở `maxVolumes`, nhưng spec VOL-05 vẫn dùng hằng. Tenant test có cap khác ⇒ FW-04, VMS-03, VOL-05, VOL-10 đỏ có chủ ý — đọc cap bằng SQL (`L-x` của release) trước khi chạy.
- Mọi module có ghi quota trong bảng ở mục trên (VM-15, TEN-02, TEN-08, `load-balancer`, `portal-ui`) đổi quota của tenant lane rồi trả lại: VM-15, TEN-02 và TEN-08 trả lại ngay và trong `afterAll`; `load-balancer` và `portal-ui` chỉ trong `afterAll`. Pod bị giết giữa chừng ⇒ quota lệch: SMOKE-04 log quota đầu mỗi lượt để so.
- FW-02, VMS-04, VMS-05 đọc trạng thái ngay sau request: cửa sổ là tới khi worker lease lệnh (poll 2 s) cộng thời gian provider làm — đỏ ở đây phải đối chiếu log trước khi ghi FINDING.
- CAT-05 đọc `/v1/os-images` trước khi CAT-06 sync, nên cần image đã có sẵn trên cluster.
- `billing/seed-invoices.sql` mỗi lượt để lại trên `admin-test` một hoá đơn `New` 900.000.000 ₫ (BIL-06) — quá hạn sau 6 ngày, cộng dồn vào công nợ của `admin-test` trong receivables.
- `admin` đổi giá một tier vài giây (ADM-06) mỗi lần chạy: trên staging cả module cần `L-x`.
- `cli` đồng ý điều khoản thay `beta-user` nếu chưa đồng ý (`POST /v1/legal/acceptance` — bản ghi lâu dài).
- NET-05 chỉ đo khi tenant đã hết chỗ network (`test.skip` kèm lý do khi còn chỗ).
