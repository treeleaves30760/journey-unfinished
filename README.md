# 未完旅箋（Journey, Unfinished）

> 小小的你，世界很大。

一個讓使用者分享「帶著 Gal-Game／原創收藏娃娃去旅行」照片與故事的互動紀錄網站。地圖涵蓋全球，會依旅箋分佈自動框出視野；使用者可搜尋景點或在地圖上點選標記地點、上傳照片、以 Markdown 寫下心得、選擇預設頭像或從照片裁切頭像，並在旅箋下留言。出門在外可以用手機先拍照存成草稿，回家再用電腦把故事寫完。

> 專案內只使用通用、原創的娃娃示意設計，不包含任何未授權遊戲角色素材。

## 功能

- Nuxt 4 + Vue 3 SSR 響應式介面
- 首頁滿版分頁、原生 scroll snap 與段落進出場動畫
- **全球地圖**：OpenStreetMap／Leaflet 真實圖資、互動頭像標記，依旅箋分佈自動框出視野，並可依國家與地區篩選
- **景點搜尋**：輸入店名或地標就能標好座標；點地圖、拖曳圖釘或按「目前位置」都會自動補上國家與行政區（由伺服器代打上游，可用公用 Nominatim 或自架 Photon，見下方說明）
- Discord OAuth2 登入、SQLite 工作階段與 Discord ID 管理員白名單
- 寫下旅箋：照片、國家／地區、景點、座標、娃娃名稱、日期與心得
- **旅途留言支援 Markdown**，編輯器附工具列、即時預覽與桌機並排模式
- **草稿**：手機上拍完照、標好地點就先存著，換到電腦登入同一個帳號接著寫完再發佈
- **手機快速記錄**（`/checkins/quick`）：拍照 → 標位置 → 存草稿，三步收工；長表單另有黏底操作列
- 6 種通用預設頭像，或在瀏覽器以 Canvas 裁切照片區塊作為頭像
- 旅箋詳情與訪客留言（匿名，含內容衛生檢查與分層限流）
- 作者可自行刪除自己的旅箋，照片一併移除
- 管理中心：會員列表、旅箋檢視與管理員刪除、國家／地區分布統計
- Nitro API + SQLite 持久化
- 具總量／欄位／檔案上限的串流 multipart 圖片上傳，上傳圖片一律重新編碼並剝除 EXIF/GPS
- Docker 多階段 production image、非 root 執行、健康檢查與 Compose volume
- k3s 部署資產：manifest、建置匯入腳本與 runbook（見 [`deploy/k3s/`](deploy/k3s/README.md)）

## 技術版本與安全基線

建立時已採 npm registry 的穩定最新版：

- Nuxt `4.5.2`（Vue `3.5.x`、Nitro `2.13.x`）
- Leaflet `1.9.4` + OpenStreetMap Standard tiles
- @fastify/busboy `3.2.0`（有界限的串流 multipart parser）
- better-sqlite3 `13.0.1`
- sharp `0.35.3`（圖片重新編碼與 metadata 剝除）
- Vitest `4.1.10`
- Node.js `24.18.0` 容器映像（Node 24 LTS 線）

`package-lock.json` 固定完整依賴樹。由於 Nitro 目前的封裝工具仍宣告舊版 `glob` / `readdir-glob`，本專案使用 npm `overrides` 將它們鎖定至相容且已修補的版本。驗證結果：`npm audit` 為 **0 vulnerabilities**。

安全措施包括：

- 圖片僅接受 JPEG、PNG、WebP，並同時檢查 MIME 與 magic bytes
- **上傳圖片一律以 sharp 重新解碼並重新編碼，藉此剝除全部 EXIF/XMP/IPTC metadata**（含 GPS 座標、拍攝時間、相機序號）。EXIF orientation 會先套用再丟棄，避免直向照片被轉倒。同時限制輸入像素數與輸出最長邊 4096px，防止 decompression bomb
- 單檔預設限制 5 MiB（可用環境變數調整），multipart 以 Busboy 串流解析並限制總檔案數、欄位數與 request 大小，避免先把無界限請求載入記憶體
- 上傳檔名由密碼學亂數產生，讀取路由會防止路徑穿越
- API 對長度、國家代碼、座標、日期、頭像選項做伺服器端驗證；留言 JSON 亦以串流方式限制為 8 KiB
- **Markdown 全程不產生 HTML 字串**：`utils/markdown.ts` 把留言解析成資料樹，`MarkdownView.vue` 用 Vue 的 `h()` 渲染成節點，整條路徑沒有任何 `v-html`。使用者寫的 `<script>` 只會顯示成文字，也因此不依賴任何 sanitizer 是否正確接上；連結只放行 `http`／`https`／`mailto` 與站內相對路徑，外部連結一律補 `noopener noreferrer nofollow`
- 草稿是使用者尚未公開的內容，**連管理員都讀不到**；非擁有者一律回 404 而不是 403（403 等於洩漏「這個編號存在」），並限制每人最多 20 份，避免變成無上限的空間消耗路徑
- 景點搜尋由伺服器代打上游，前端 CSP 的 `connect-src` 維持 `'self'`；端點要求登入並限流，關鍵字走與旅箋自由文字相同的衛生規則
- **旅箋與留言的自由文字套用同一套內容衛生規則**：先 NFC 正規化再量長度（避免用組合字元繞過上限）、拒絕控制字元與零寬／雙向覆寫字元（但不誤殺 ZWJ emoji 組合）、限制連結數量。兩條路徑一致處理 —— 旅箋雖需登入，但 Discord 帳號誰都能註冊
- 匿名留言另有分層限流（每分鐘爆量閘、每小時總量、單篇上限）與內容指紋，擋短時間內的重複洗版
- SQLite 使用 prepared statements
- **全站送出真正的安全 response headers**（Nitro `routeRules`）：CSP、`X-Frame-Options: DENY`、HSTS、`Referrer-Policy`、`Permissions-Policy`、`nosniff`。使用者上傳的圖片另以 `default-src 'none'; sandbox` 的最小權限 CSP 提供，即使是 polyglot 檔案也無法在本站 origin 下執行
- 寫下旅箋需 Discord 登入。**限流以「可信代理層數」（`NUXT_TRUSTED_PROXY_HOPS`）解析真實來源 IP**，預設 0 表示完全忽略可偽造的 `X-Forwarded-For`；設為 N 時取該 header 由右往左數第 N 筆。反向代理必須「覆寫」而非「附加」該 header，否則最左值由用戶端提供
- CSRF：state-changing 請求驗 `Origin`，缺席時退驗 `Referer`，兩者皆無一律拒絕
- Docker runtime 使用 UID/GID 1001 非 root 使用者、drop capabilities、`no-new-privileges`

> 沒有任何專案可以永久保證零漏洞。部署後仍應定期執行 `npm outdated`、`npm audit`、重建映像，並訂閱 Nuxt、Node 與 better-sqlite3 的安全公告。

## 專案結構

```text
app.vue                    Nuxt 應用外框
pages/                     首頁、探索地圖、登入、建立旅箋、手機快速記錄、草稿、旅箋詳情、管理中心
middleware/                會員與管理員頁面守衛
components/                RegionMap、LocationPicker、MarkdownEditor／MarkdownView、卡片、頭像裁切等元件
composables/               useAuth、useCheckins 等前端共用邏輯
utils/                     前後端共用工具（安全回跳路徑、國家代碼對照、Markdown 解析）
assets/css/main.css        全站視覺與響應式樣式
server/api/                Nitro JSON / multipart API（旅箋、留言、草稿、地理編碼、管理）
server/routes/uploads/     上傳圖片讀取路由
server/utils/              SQLite、驗證、上傳、草稿、地理編碼、請求安全與 Discord 工具
data/                      SQLite 與上傳圖片（執行時產生）
test/                      Vitest 單元與安全測試
e2e/                       Playwright 多尺寸頁面與權限檢查
deploy/k3s/                k3s manifest、建置匯入腳本與部署 runbook
tsconfig.json              Nuxt 前端、伺服器與共用程式的型別檢查入口
```

## 本機開發

### 需求

- Node.js `^22.19.0`、`^24.11.0` 或 `>=26.0.0`
- npm 11+

目前建議使用 Node 24 LTS。

```bash
git clone https://github.com/treeleaves30760/journey-unfinished.git
cd journey-unfinished
cp .env.example .env
npm ci
npm run dev
```

開啟 <http://localhost:3000>。使用 Discord OAuth 時請固定使用 `localhost`，不要在 `localhost` 與 `0.0.0.0` 之間切換，否則瀏覽器 Cookie 會被視為不同網站。

### Discord 登入設定

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 建立 Application。
2. 在 OAuth2 的 Redirects 加入 `http://localhost:3000/auth/discord`。
3. 將 Client ID 與 Client Secret 填入 `.env`。
4. 在 Discord 開啟開發者模式，複製管理員的 User ID，填入 `NUXT_ADMIN_DISCORD_IDS`；多位管理員用半形逗號分隔。

```dotenv
NUXT_PUBLIC_APP_URL=http://localhost:3000
NUXT_DISCORD_CLIENT_ID=你的 Client ID
NUXT_DISCORD_CLIENT_SECRET=你的 Client Secret
NUXT_DISCORD_REDIRECT_URI=http://localhost:3000/auth/discord
NUXT_ADMIN_DISCORD_IDS=123456789012345678
```

一般 Discord 會員登入後可以寫下旅箋；白名單內帳號會額外看到 `/admin` 管理中心。Client Secret 不可提交到 Git。

#### 為什麼一般網站仍使用 OAuth2

Discord Embedded App SDK 是 Discord Activity 與 Discord Client 之間的 RPC 工具，不是外部網站的免授權登入 API。SDK 的 `commands.authorize()` 仍會取得 OAuth authorization code，`commands.authenticate()` 也必須先提供 access token，因此無法取代使用者授權與伺服器端 code exchange。

本專案是一般網站，因此採官方 Authorization Code Grant 與 `identify` scope。若未來整個產品改成只能在 Discord Activity iframe 內執行，才適合加入 `@discord/embedded-app-sdk`，但後端仍需交換 authorization code。Bot token 只能代表 Bot，不能安全識別目前瀏覽網站的使用者，也不可放入瀏覽器端。

- [Discord OAuth2 官方文件](https://discord.com/developers/docs/topics/oauth2)
- [Discord Embedded App SDK 官方文件](https://discord.com/developers/docs/developer-tools/embedded-app-sdk)

開發資料預設存放於：

- SQLite：`./data/journey-unfinished.sqlite`
- 圖片：`./data/uploads/`

首次啟動會自動建立資料表與示範旅箋。
若同一目錄已有舊版 `wa-trip.sqlite` 且新版檔案尚未建立，應用程式會繼續使用舊資料庫，避免改名造成資料遺失。

## 測試、稽核與 production build

```bash
# 單元測試
npm test

# Nuxt / Vue / Nitro 嚴格型別檢查
npm run typecheck

# Chromium 響應式與權限 E2E
npx playwright install chromium
npm run test:e2e

# 型別、單元、SQLite、E2E 與 production build 全部執行
npm run test:all

# 確認套件是否仍為最新版
npm outdated

# 完整與 production 依賴漏洞掃描
npm audit
npm run audit:prod

# 正式建置
npm run build

# 本機執行建置產物
npm run start
```

單元測試目前有 **30 個檔案、524 個案例**，涵蓋：

- OAuth URL／code exchange／state、Session Cookie 與撤銷、管理員白名單、安全回跳路徑
- SQLite fresh schema 與 legacy migration、foreign-key cascade、建立者綁定、檔案刪除
- 上傳圖片的 EXIF/GPS 剝除、EXIF orientation 套用、decompression bomb 拒絕、損毀檔案回 415
- 可信代理層數解析來源 IP（含偽造 `X-Forwarded-For` 無效、清單過短退回 socket 位址）
- CSRF：`Origin`／`Referer` 退階判定與缺兩者時的拒絕
- 內容衛生：NFC 正規化長度、控制字元、零寬／雙向字元（但不誤殺 ZWJ emoji）、連結數量
- 留言分層限流、單篇上限與重複內容指紋
- 旅箋擁有者自刪的權限矩陣（含 `user_id` 為 NULL 的種子資料）
- Markdown 解析器：語法覆蓋、找不到成對符號時不吞掉後文、巢狀深度上限，以及「HTML 與 `javascript:` 連結不會產生可執行節點」的安全回歸
- 國家代碼對照表的唯一性與格式，以及國旗由區域指示符號推導
- 地理編碼上游：Nominatim 與 Photon 兩種回應格式的正規化（含 GeoJSON 經緯度順序）、查詢快取、節流與排隊上限、上游失敗的錯誤對應
- 草稿的擁有權（非擁有者一律 404）、圖片的保留／替換／清空三種語意、發佈時沿用草稿照片與孤兒檔案回收

E2E 另涵蓋頁面權限與 320px 到桌面、矮螢幕的滿版 snap 幾何。Playwright 每次會建立獨立暫存資料庫與 uploads 目錄，結束後自動移除，不會污染開發資料。

可測試健康端點：

```bash
curl http://localhost:3000/api/health
```

## 地圖架構與 OpenStreetMap 使用方式

`components/RegionMap.vue` 是可重用的地圖渲染元件（外層以 `<ClientOnly>` 包住），使用 Leaflet 顯示 OpenStreetMap Standard tiles，並直接以每則旅箋的經緯度建立頭像 Marker。預設視野是**世界**且刻意不設 `maxBounds` —— 把地圖鎖在單一國家，就等於把海外旅箋鎖在畫面外。

傳入 `fit-to-checkins` 時，元件會依目前顯示的旅箋自動框出可視範圍（單一旅箋時以 `maxZoom: 13` 收斂，保留「在世界的哪裡」的脈絡），只有在旅箋集合本身改變（初次載入、切換篩選）時才重新框，不會在使用者拖曳地圖時把鏡頭拉走。仍然可以用 `region` 參數指定固定的 `center`／`zoom`／`bounds`。

座標驗證放寬到整顆地球（緯度 ±90、經度 ±180）；國家以 ISO 3166-1 alpha-2 代碼儲存，顯示名稱一律由 `utils/countries.ts` 推導，同一個國家不會因為來源不同而在篩選器裡分裂成好幾項。

### 景點搜尋與反向地理編碼

瀏覽器只打自家的 `/api/geo/search` 與 `/api/geo/reverse`，由伺服器代打上游的 Nominatim 相容服務。這樣做有三個好處：CSP 的 `connect-src` 維持 `'self'`；使用者的 IP 與搜尋關鍵字不會直接送到第三方；上游的使用條款（可辨識 User-Agent、每秒最多一次請求）能在一個地方集中遵守。

`server/utils/geocoding.ts` 內建 10 分鐘查詢快取、上游間隔節流（排隊超過 3 秒直接回 429）與 6 秒逾時，並要求登入 + 每 IP 限流，避免本站變成別人濫用上游的跳板。`NUXT_GEOCODER_URL` 留空即關閉搜尋，表單會退回「在地圖上點選或手動輸入座標」。

支援兩種上游，由 `NUXT_GEOCODER_PROVIDER` 切換：

| | `nominatim`（預設） | `photon` |
|---|---|---|
| 用途 | 公用的 `nominatim.openstreetmap.org`，零維運 | 自架，擺脫速率上限 |
| 速率 | 條款限制**每秒 1 次**，多人同時搜尋會排隊 | 沒有上限，應用端節流自動關閉 |
| 中文 | `accept-language=zh-TW`，有中文名就回中文 | 只支援 `default/de/en/fr`，這裡用 `default`＝OSM 的當地語言名稱 |
| 成本 | 無 | 約 95 GB 磁碟；不需匯入，下載預建索引即可 |

兩者的回應格式完全不同（Nominatim 是自訂 JSON，Photon 是 GeoJSON，連經緯度順序都相反），各自有一份 parser，最後收斂成同一個 `GeoPlace`。自架的完整步驟、硬體比較與踩雷點見 [`deploy/k3s/README.md`](deploy/k3s/README.md#自架地點搜尋選用)。

地圖依 OpenStreetMap 規範保留可見 attribution。公開正式服務需遵守 [OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)：不可大量預抓、離線抓取或移除 attribution。若流量增加，應改用有 SLA 的圖磚供應商（例如 MapTiler、Stadia Maps）或自行架設 tile server，並只替換 `tileLayer` URL／attribution，不需更動旅箋資料模型。

## API 摘要

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/api/health` | 健康檢查 |
| `GET` | `/auth/discord` | 發起／接收 Discord OAuth2 登入 |
| `GET` | `/api/auth/session` | 目前登入狀態 |
| `POST` | `/api/auth/logout` | 登出並撤銷伺服器 Session |
| `GET` | `/api/checkins` | 旅箋列表 |
| `POST` | `/api/checkins` | 登入後以 multipart 建立旅箋；帶 `draftId` 即為「發佈草稿」，會沿用草稿已上傳的照片並刪除該草稿 |
| `GET` | `/api/checkins/:id` | 旅箋與留言詳情 |
| `DELETE` | `/api/checkins/:id` | 作者刪除自己的旅箋（管理員亦可） |
| `POST` | `/api/checkins/:id/comments` | 建立留言（匿名） |
| `GET` | `/api/drafts` | 自己的草稿列表 |
| `POST` | `/api/drafts` | 建立草稿（multipart，所有欄位皆可留空） |
| `GET` | `/api/drafts/:id` | 讀取自己的草稿（非擁有者一律 404） |
| `PUT` | `/api/drafts/:id` | 更新草稿；未帶新檔案＝保留原圖，`clearPhoto=1`／`clearAvatar=1` 才清空 |
| `DELETE` | `/api/drafts/:id` | 刪除草稿與其圖片 |
| `GET` | `/api/geo/search?q=` | 景點搜尋（登入後可用，伺服器代打 Nominatim） |
| `GET` | `/api/geo/reverse?lat=&lon=` | 座標反查國家與行政區 |
| `GET` | `/api/admin/overview` | 管理員會員與旅箋資料 |
| `DELETE` | `/api/admin/checkins/:id` | 管理員刪除旅箋 |
| `GET` | `/uploads/:file` | 讀取已驗證圖片 |

## Docker Image 建置與執行

### 1. 建置 Image

```bash
docker build --pull -t journey-unfinished:latest .
```

Dockerfile 會：

1. 在 build stage 安裝鎖定依賴並執行 `nuxt build`。
2. 只複製 Nuxt `.output` 到乾淨的 runtime stage。
3. 使用非 root `nuxt` 使用者啟動 Nitro。
4. 以 `/api/health` 進行健康檢查。

### 2. 單一容器執行

先建立具名 volume，避免容器刪除後遺失照片與 SQLite：

```bash
docker volume create journey-unfinished-data

docker run -d \
  --name journey-unfinished \
  --restart unless-stopped \
  --init \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  -p 3000:3000 \
  -v journey-unfinished-data:/app/data \
  journey-unfinished:latest
```

檢查：

```bash
docker ps
docker logs -f journey-unfinished
curl http://localhost:3000/api/health
```

### 3. Docker Compose（推薦）

```bash
# 建置並啟動
docker compose up -d --build

# 查看狀態與日誌
docker compose ps
docker compose logs -f

# 停止；具名 volume 仍會保留
docker compose down
```

若連資料一起永久刪除：

```bash
docker compose down -v
```

### 4. 更新部署

```bash
git pull
npm ci
npm outdated
npm audit
npm test
docker compose build --pull --no-cache
docker compose up -d
```

## 上線部署建議

> **Kubernetes／k3s 部署**：完整的 manifest、建置匯入腳本與 runbook 見 [`deploy/k3s/`](deploy/k3s/README.md)。

Docker Compose 適合單機 VPS。正式公開服務建議在容器前放置 Caddy、Nginx、Traefik 或雲端 Load Balancer：

1. DNS 指向伺服器。
2. 反向代理 HTTPS 網域至 `127.0.0.1:3000`；只有防火牆確認 3000 不對外，**且代理是「覆寫」而非「附加」`X-Forwarded-For`** 時，才把 `NUXT_TRUSTED_PROXY_HOPS` 設為代理層數（單層 nginx 就是 `1`）。附加語意下該 header 的最左值由用戶端提供，設了等於關掉限流。
3. 僅對外開放 80/443，避免直接暴露 3000。
4. 定期備份 Docker volume：SQLite 與 `uploads/` 必須一起備份。
5. 增加 WAF／反向代理 rate limit，尤其是圖片上傳與留言端點。
6. 若流量成長，將圖片遷移至 S3/R2 等 object storage、SQLite 遷移至 PostgreSQL，並加入正式的帳號、審核與內容檢舉機制。

### Caddy 範例

```caddyfile
trip.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

## 環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `NUXT_DATABASE_PATH` | `./data/journey-unfinished.sqlite` | SQLite 檔案路徑 |
| `NUXT_UPLOAD_DIR` | `./data/uploads` | 圖片儲存路徑 |
| `NUXT_MAX_UPLOAD_BYTES` | `5242880` | 單張圖片大小上限 |
| `NUXT_TRUSTED_PROXY_HOPS` | `0` | 應用前方的可信代理層數。`0` = 完全忽略 `X-Forwarded-For`（安全預設）；`N` = 取該 header 由右往左數第 N 筆當來源 IP。**代理必須覆寫而非附加該 header**，否則最左值由用戶端提供、限流可被繞過 |
| `NUXT_TRUST_PROXY` | `false` | 相容路徑，等同 `NUXT_TRUSTED_PROXY_HOPS=1`。新部署請直接用 hops |
| `NUXT_PUBLIC_APP_URL` | `http://localhost:3000` | 公開網站 Origin，正式環境必須是 HTTPS |
| `NUXT_DISCORD_CLIENT_ID` | 無 | Discord Application Client ID |
| `NUXT_DISCORD_CLIENT_SECRET` | 無 | Discord Application Client Secret |
| `NUXT_DISCORD_REDIRECT_URI` | `<APP_URL>/auth/discord` | Discord Portal 中完全相同的 callback URL |
| `NUXT_ADMIN_DISCORD_IDS` | 無 | 逗號分隔的管理員 Discord User ID |
| `NUXT_SESSION_DAYS` | `30` | 登入 Session 天數，程式限制為 1–90 天 |
| `NUXT_GEOCODER_URL` | `https://nominatim.openstreetmap.org` | 景點搜尋的上游服務。留空即關閉搜尋，表單仍可點地圖或手動輸入座標 |
| `NUXT_GEOCODER_PROVIDER` | `nominatim` | `nominatim`（公用服務，每秒 1 次上限）或 `photon`（自架，無上限）。兩者回應格式不同，見上方說明 |
| `NUXT_GEOCODER_EMAIL` | 無 | 附給 Nominatim 的聯絡信箱；被判定濫用時對方會先來信而不是直接封鎖。自架 Photon 時用不到 |
| `NUXT_GEOCODER_MIN_INTERVAL_MS` | 空＝自動 | 兩次上游請求的最小間隔。留空時依 provider 決定（Nominatim 1100、Photon 0）；指到別人架的公用服務時才需要自己填 |
| `HOST` | `0.0.0.0` | Nitro 監聽位址 |
| `PORT` | `3000` | Nitro 連接埠 |

## 上線前仍建議補強

這份交付已要求 Discord 登入才能寫下旅箋、圖片會剝除 EXIF/GPS、作者可自刪旅箋、全站送出 CSP 等安全標頭。正式營運前仍建議加入：

- 擁有者**編輯**權限與帳號封鎖流程（目前只有刪除）
- Redis 或其他跨實例 rate limiting（現行限流桶在 process 記憶體，重啟歸零，只在單 replica 下語意正確）
- nonce-based CSP，以移除 `script-src`／`style-src` 的 `'unsafe-inline'`（目前受限於 Nuxt SSR 的 hydration payload 是 inline script）
- 自動與人工內容審核、檢舉、封鎖與刪除流程
- 上傳失敗的伺服器端記錄：`saveImage` 目前把 sharp 的錯誤轉成 415 回應且不留日誌，正式環境會難以診斷真正損毀的上傳
- 第三方資源自架：Google Fonts 與 OpenStreetMap tiles 會把訪客 IP 送給第三方
- 隱私政策、服務條款、版權申訴與備份還原演練

### 已知取捨與行為

- **動態 WebP 上傳後只保留第一幀**（sharp 未啟用 `animated`，這同時移除了以動畫消耗資源的途徑）。
- **Unicode tag 字元（U+E0000–U+E007F）刻意不擋**。它們完全不可見、是夾帶隱藏文字的手法，但封鎖會連帶殺死 🏴󠁧󠁢󠁥󠁮󠁧󠁿 這類 tag sequence 旗幟 emoji。以本站的使用情境，誤殺正常 emoji 的代價高於防護收益。
- **自刪限流是 per-IP 而非 per-user**，同一 NAT／CGNAT 出口的使用者共用每小時 20 次刪除額度。要改成 per-user，把 bucket key 換成 `user.id` 即可（該處已解析出使用者）。
- **留言的換行數量沒有上限**，理論上可用大量 `\n` 拉長卡片。用 CSS `max-height` 處理比加驗證規則便宜。
