# 部署到 treeleaves30760nas（k3s）

目標主機盤點（2026-07-31 重新確認）：

| 項目 | 現況 |
|---|---|
| 主機 | `treeleaves30760nas` / 192.168.0.10，Ubuntu 22.04.5，amd64，44 核 / 94 GiB / 741 GiB 可用 |
| k3s | v1.36.2+k3s1，單節點 control-plane，containerd 2.3.2 |
| Ingress controller | **無**。`/etc/rancher/k3s/config.yaml` 已 `disable: [traefik, servicelb]` |
| Storage | `local-path`（預設且唯一的 StorageClass） |
| 對外入口 | host nginx 1.18 + certbot，獨佔 80/443 |
| 既有站台 | `maygong.nthudsa.com`→:3000、`maygong-cms.nthudsa.com`→:1337、`nas.xn--essy41b.com`→:12001，皆正常（301 + Let's Encrypt） |
| 對外 | 公網 IP 114.34.222.201，NAS 在 NAT 後面 |
| CDN／WAF | **Cloudflare 代理**（orange cloud）。`nas.xn--essy41b.com` 等站台皆解析到 CF anycast IP |
| 佔用中的埠 | 80/443（nginx）、3000（`nthu-maychu-frontend`）、1337、12001、6443（k3s API） |

## 為什麼沒有 Ingress 物件

k3s 內建的 ServiceLB（`svclb` DaemonSet）會讓 Traefik 以 hostPort 綁 80/443，
而那組 CNI portmap 的 DNAT 規則在 PREROUTING 就攔截封包 —— nginx 雖然還在
listen，但收不到任何外部流量，既有三個站台會全部變成 Traefik 的 404。

現在的解法是在 k3s 層直接停用兩者，讓 nginx 維持唯一入口。代價是叢集裡沒有
ingress controller，所以這裡用 **NodePort Service + nginx `proxy_pass`**：

```
瀏覽器 ──443──▶ Cloudflare 邊緣（TLS 終止 + WAF）
                 └──443──▶ nginx (host, certbot 憑證, limit_req 邊界限流)
                            └─▶ 127.0.0.1:30300 (NodePort)
                                 └─▶ Service journey-unfinished:3000
                                      └─▶ Pod (Nitro, uid 1001, 唯讀根檔案系統)
                                           └─▶ PVC local-path /app/data
```

### Cloudflare 這一層必須先處理

nginx 目前**沒有任何 `set_real_ip_from` 設定**，所以它看到的 `$remote_addr` 是
Cloudflare 邊緣節點而不是訪客。在這個前提下部署的話：

- nginx 的 `limit_req`（key 是 `$binary_remote_addr`）會以 CF 邊緣為單位，全站
  幾乎共用一個桶
- 傳給應用的 `X-Forwarded-For` 會是 CF 邊緣位址，應用層限流一樣失準
- access log 記錄不到真實訪客

`scripts/fix-existing-nginx.sh` 會安裝 `conf.d/cloudflare-realip.conf`
（`real_ip_header CF-Connecting-IP` + CF 官方網段），修好之後 `$remote_addr`
才是真實客戶端，本文件其餘設定的前提才成立。

> Origin（114.34.222.201）目前可被直接連線，繞過 Cloudflare。那類請求的來源不在
> CF 網段，`real_ip` 不會套用，限流仍然正確 —— 但會繞過 Cloudflare 的 WAF／DDoS
> 防護。若在意，可在路由器或防火牆只放行 CF 網段連入 80/443。

比起「再裝一個 ingress controller」，這樣少一層轉發、少一組要維護的 CRD，
而且 TLS 與憑證續期沿用你既有的 certbot 流程。

---

## 部署步驟

### 0. 前置

- Discord Developer Portal 的 OAuth2 Redirect URI 加入
  `https://journey-unfinished.xn--essy41b.com/auth/discord`
  （**必須用 punycode 且完全一致**，程式會把它原樣送給 Discord）
- DNS 已就緒：`journey-unfinished.xn--essy41b.com` 已解析到 Cloudflare，
  Cloudflare 的 origin 需指向 114.34.222.201，路由器 80/443 轉發到 192.168.0.10
- NAS 上 `sudo apt install -y gettext-base`（需要 `envsubst`）
- 先跑 `sudo ./deploy/k3s/scripts/fix-existing-nginx.sh`（修 X-Forwarded-Proto +
  安裝 Cloudflare real_ip；會自動備份並 `nginx -t`）

### 1. 把程式碼放到 NAS

映像必須在 NAS 上建。Mac 是 arm64、NAS 是 amd64，而 `better-sqlite3` 與
`sharp` 都是原生模組 —— 跨架構要走 buildx + QEMU，編譯很慢；NAS 44 核直接建
更快也更可靠。

```bash
ssh treeleaves30760nas
git clone https://github.com/treeleaves30760/journey-unfinished.git
cd journey-unfinished
```

### 2. 填設定

```bash
cp .env.example .env
vi .env          # NUXT_DISCORD_CLIENT_ID / _SECRET / NUXT_ADMIN_DISCORD_IDS

cp deploy/k3s/deploy.env.example deploy/k3s/deploy.env
vi deploy/k3s/deploy.env    # APP_HOST、IMAGE_TAG、APP_NODEPORT
```

`.env` 只被 `deploy.sh` 讀來建 Secret，不會進映像（`.dockerignore` 已排除），
也不會進 git（`.gitignore` 已排除）。`deploy.env` 同樣已加入 `.gitignore`。

### 3. 建置並匯入映像

叢集裡沒有 registry，dockerd 與 k3s 的 containerd 不共用映像庫，必須明確匯入：

```bash
chmod +x deploy/k3s/scripts/*.sh
./deploy/k3s/scripts/build-image.sh 1.0.0
```

### 4. 套用 k8s 資源

```bash
./deploy/k3s/scripts/deploy.sh
```

會建立 Namespace（`restricted` Pod Security Standard）、PVC、ConfigMap、
Secret、Deployment、NodePort Service、NetworkPolicy，等 rollout 完成，
然後從 pod 內與 host NodePort 各打一次 `/api/health`。

### 5. nginx vhost + 憑證

```bash
sudo cp deploy/k3s/nginx-journey.conf.example /etc/nginx/conf.d/journey.conf
sudo vi /etc/nginx/conf.d/journey.conf     # 改 server_name 與 NodePort
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d journey-unfinished.xn--essy41b.com
```

### 6. 驗收

```bash
curl -si https://journey-unfinished.xn--essy41b.com/api/health

# 應用層安全標頭（由 nuxt.config.ts 的 routeRules 送出）
curl -sS -D - -o /dev/null https://journey-unfinished.xn--essy41b.com/ \
  | grep -iE 'content-security-policy|strict-transport|x-frame|x-content-type|permissions-policy'

# 既有三個站台不可受影響
for h in maygong.nthudsa.com maygong-cms.nthudsa.com nas.xn--essy41b.com; do
  curl -s -o /dev/null -w "$h %{http_code}\n" -H "Host: $h" http://127.0.0.1/
done

# 走一次 Discord 登入，確認導回 /auth/discord 後有拿到 session
# 上傳一張含 GPS 的照片，下載回來確認 EXIF 已被剝除：
#   exiftool <下載的檔案> | grep -i gps    # 應該沒有輸出
```

---

## 更新版本

`imagePullPolicy: IfNotPresent` + 沒有 registry，所以**同一個 tag 不會重新載入**。
每次改版一定要遞增 tag：

```bash
git pull
./deploy/k3s/scripts/build-image.sh 1.0.1
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=1.0.1/' deploy/k3s/deploy.env
./deploy/k3s/scripts/deploy.sh
```

`strategy: Recreate` 會先關舊 pod 再起新的（SQLite 不能兩個 writer），
更新期間有數秒中斷，屬預期。

---

## 備份

SQLite 開了 WAL，**直接 `cp` 檔案會拿到不一致的快照**。要用 SQLite 自己的
線上備份：

```bash
NS=journey-unfinished
POD=$(kubectl -n $NS get pod -l app.kubernetes.io/name=journey-unfinished -o name)

kubectl -n $NS exec $POD -- node -e "
  const D=require('better-sqlite3');
  const db=new D('/app/data/journey-unfinished.sqlite',{readonly:true});
  db.exec(\"VACUUM INTO '/tmp/backup.sqlite'\");
"
kubectl -n $NS cp "${POD#pod/}:/tmp/backup.sqlite" ./journey-$(date +%F).sqlite

# 上傳圖片（PVC 在 host 上的實體路徑）
sudo tar czf uploads-$(date +%F).tgz \
  -C /var/lib/rancher/k3s/storage/*journey-data*/uploads .
```

資料庫與 `uploads/` 必須一起備份 —— 兩者分開還原會出現有紀錄沒圖片的孤兒列。

---

## 這份 manifest 針對本專案做的取捨

| 設定 | 原因 |
|---|---|
| `replicas: 1` + `strategy: Recreate` | SQLite 單寫者。多 replica 或滾動更新會讓兩個 pod 同時掛同一顆 PVC，資料庫會壞。應用內建的記憶體限流桶也只有在單 replica 下語意正確 |
| `NUXT_TRUSTED_PROXY_HOPS: "1"` | 只有 nginx 一跳。應用取 X-Forwarded-For 由右往左數第 1 筆 —— **這只有在 nginx 用 `$remote_addr` 覆寫該 header 時才安全**。若改回 `$proxy_add_x_forwarded_for`（附加語意），最左值由用戶端提供，必須把這個值設回 `0` |
| NodePort 而非 Ingress | 叢集沒有 ingress controller（見上）。少一層轉發，TLS 沿用既有 certbot |
| nginx `limit_req` 兩個 zone | 應用的限流桶在 process 記憶體裡，重啟歸零、且要等請求進到 Node 才判斷。寫入端點（`/api/checkins`、`/auth/`）用更緊的 zone |
| `livenessProbe` 用 tcpSocket | `/api/health` 會打 SQLite；資料庫暫時鎖住時拿它當 liveness 會造成無止境重啟。DB 檢查放在 readiness |
| `readOnlyRootFilesystem: true` + `/tmp` tmpfs | 應用只需要寫 `/app/data`。tmpfs 給 sharp 解碼大圖時的暫存空間 |
| memory limit 1Gi | sharp 重新編碼（剝除 EXIF）比純 SSR 吃記憶體，比原本的 768Mi 多留餘裕 |
| `automountServiceAccountToken: false` | 應用不呼叫 k8s API，掛 token 只是白送一組憑證給 RCE |
| NetworkPolicy 出向排除 RFC1918 | 避免這個 pod 被拿來當跳板打 NAS 上其他服務（另外兩個站台、rustdesk、k3s API 6443） |
