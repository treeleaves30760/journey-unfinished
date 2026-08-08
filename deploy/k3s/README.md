# 部署到 k3s

單節點 k3s + host nginx 的部署資產：manifest、建置匯入腳本與 runbook。

> **環境專屬值不在這個 repo。** 主機位址、對外網域、同一台機器上的其他站台、
> 防火牆規則——那些是基礎設施資訊，屬於獨立的（且應為 private 的）repo。
> 這裡的檔案一律用 placeholder，實際值填在 `deploy.env`（已被 `.gitignore`）。

## 這份部署假設的環境

| 項目 | 假設 |
|---|---|
| k3s | 單節點 control-plane |
| Ingress controller | **無**（見下節） |
| StorageClass | 有一個可用的預設 StorageClass（例如 `local-path`） |
| 對外入口 | host 上的 nginx + certbot，獨佔 80/443 |
| Registry | **無**。映像在目標主機上建好後直接匯入 containerd |

## 為什麼沒有 Ingress 物件

k3s 內建的 ServiceLB（`svclb` DaemonSet）會讓 Traefik 以 hostPort 綁 80/443，
而那組 CNI portmap 的 DNAT 規則在 PREROUTING 就攔截封包 —— host nginx 雖然還在
listen，但收不到任何外部流量，同一台機器上既有的站台會全部變成 Traefik 的 404。

解法是在 k3s 層直接停用兩者（`/etc/rancher/k3s/config.yaml` 的
`disable: [traefik, servicelb]`），讓 nginx 維持唯一入口。代價是叢集裡沒有
ingress controller，所以這裡用 **NodePort Service + nginx `proxy_pass`**：

```
瀏覽器 ──443──▶ [CDN／WAF，選用]
                 └──443──▶ nginx (host, certbot 憑證, limit_req 邊界限流)
                            └─▶ 127.0.0.1:${APP_NODEPORT} (NodePort)
                                 └─▶ Service journey-unfinished:3000
                                      └─▶ Pod (Nitro, uid 1001, 唯讀根檔案系統)
                                           └─▶ PVC /app/data
```

比起「再裝一個 ingress controller」，這樣少一層轉發、少一組要維護的 CRD，
而且 TLS 與憑證續期沿用主機上既有的 certbot 流程。

### 若 origin 在 CDN 之後

必須先在 host nginx 設定 real_ip（`set_real_ip_from` + `real_ip_header`），
否則 nginx 看到的 `$remote_addr` 是 CDN 邊緣節點而不是訪客：

- nginx 的 `limit_req`（key 是 `$binary_remote_addr`）會以邊緣節點為單位，
  全站幾乎共用一個桶
- 傳給應用的 `X-Forwarded-For` 會是邊緣位址，應用層限流一樣失準
- access log 記錄不到真實訪客

那份設定影響該主機上的**所有**站台，屬於主機層設定，不在這個 repo 裡。

另外要留意：CDN 通常也負責隱藏 origin IP。如果 origin 可以被直接連線，那類請求會
繞過 CDN 的 WAF／DDoS 防護（應用層與 nginx 的限流仍然有效，因為直連請求的來源不在
CDN 網段，real_ip 不會套用）。要真正擋掉，得在路由器或防火牆限制來源。

---

## 部署步驟

### 0. 前置

- Discord Developer Portal 的 OAuth2 Redirect URI 加入 `https://<APP_HOST>/auth/discord`
  （程式會把 `APP_HOST` 原樣送給 Discord，兩邊必須完全一致；IDN 網域必須用 punycode）
- DNS 已指向 origin，路由器 80/443 已轉發到節點
- 目標主機上 `sudo apt install -y gettext-base`（需要 `envsubst`）

### 1. 把程式碼放到目標主機

映像必須在目標主機上建 —— 開發機常是 arm64、部署主機常是 amd64，而
`better-sqlite3` 與 `sharp` 都是原生模組，跨架構要走 buildx + QEMU，編譯很慢。

```bash
ssh <部署主機>
git clone https://github.com/treeleaves30760/journey-unfinished.git
cd journey-unfinished
```

### 2. 填設定

```bash
cp .env.example .env
vi .env          # NUXT_DISCORD_CLIENT_ID / _SECRET / NUXT_ADMIN_DISCORD_IDS

cp deploy/k3s/deploy.env.example deploy/k3s/deploy.env
vi deploy/k3s/deploy.env    # APP_HOST、IMAGE_TAG、APP_NODEPORT、NODE_CIDR
```

`NODE_CIDR` 是節點自己的內網位址，`app.yaml` 的 NetworkPolicy 要放行它（NodePort
流量經 kube-proxy SNAT 後來源是節點 IP）。沒填的話 `deploy.sh` 會直接停下來 ——
猜錯的症狀是「部署成功但 nginx 502」，很難一眼看出原因。查法：

```bash
kubectl get node -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}'
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
sudo certbot --nginx -d <APP_HOST>
```

### 6. 驗收

```bash
curl -si https://<APP_HOST>/api/health

# 應用層安全標頭（由 nuxt.config.ts 的 routeRules 送出）
curl -sS -D - -o /dev/null https://<APP_HOST>/ \
  | grep -iE 'content-security-policy|strict-transport|x-frame|x-content-type|permissions-policy'

# 同一台主機上的其他站台不可受影響（它們共用這台 nginx）。
# 把網域列在 deploy.env 的 NEIGHBOR_HOSTS，update.sh 每次部署後會自動跑這項。
for h in $NEIGHBOR_HOSTS; do
  curl -s -o /dev/null -w "$h %{http_code}\n" -H "Host: $h" http://127.0.0.1/
done

# 走一次 Discord 登入，確認導回 /auth/discord 後有拿到 session
# 上傳一張含 GPS 的照片，下載回來確認 EXIF 已被剝除：
#   exiftool <下載的檔案> | grep -i gps    # 應該沒有輸出
```

---

## 更新版本

平常改版跑這一支就好，它會把下面整串包起來（拉程式碼 → 備份 → 建映像 → 遞增 tag →
部署 → 驗收），任何一步失敗都會停下來並印出回滾指令：

```bash
ssh -t <部署主機>                   # 需要 tty：匯入映像要 sudo 密碼
cd ~/journey-unfinished
./deploy/k3s/scripts/update.sh     # tag 自動 +1；要指定就 update.sh 1.2.0
```

手動做的話：`imagePullPolicy: IfNotPresent` + 沒有 registry，所以**同一個 tag 不會
重新載入**，每次改版一定要遞增 tag：

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

`update.sh` 每次部署前都會自己備份一份到 `~/journey-backups/`。要單獨備份時：

SQLite 開了 WAL，**直接 `cp` 檔案會拿到不一致的快照**（多數新資料還在 `-wal` 裡）。
要用 SQLite 自己的線上備份：

```bash
NS=journey-unfinished
POD=$(kubectl -n $NS get pod -l app.kubernetes.io/name=journey-unfinished -o name)
POD=${POD#pod/}

# 相依套件被 nitro 收在 .output/server/node_modules —— Dockerfile 只複製 .output，
# /app/node_modules 不存在，裸寫 require('better-sqlite3') 會 MODULE_NOT_FOUND。
kubectl -n $NS exec $POD -- node -e "
  const D=require('/app/.output/server/node_modules/better-sqlite3');
  const db=new D('/app/data/journey-unfinished.sqlite',{readonly:true});
  db.exec(\"VACUUM INTO '/tmp/backup.sqlite'\");
  db.close();
"
kubectl -n $NS cp "$POD:/tmp/backup.sqlite" ./journey-$(date +%F).sqlite
kubectl -n $NS exec $POD -- rm -f /tmp/backup.sqlite

# 上傳圖片。直接從容器取，不需要 sudo，也不必知道 PVC 在 host 上的實體路徑。
kubectl -n $NS exec $POD -- tar czf - -C /app/data uploads > uploads-$(date +%F).tgz
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
| NetworkPolicy 出向排除 RFC1918 | 避免這個 pod 被拿來當跳板打同一台主機或區網上的其他服務（含 k3s API） |
