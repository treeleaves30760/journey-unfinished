# 未完旅箋（Journey, Unfinished）

> 小小的你，世界很大。

一個讓使用者分享「帶著 Gal-Game／原創收藏娃娃去旅行」照片與故事的互動紀錄網站。目前版本以臺灣為預設探索區域，首頁地圖會呈現每則旅箋的位置；使用者可上傳照片、選擇預設頭像或從照片裁切頭像，並在旅箋下留言。

> 專案內只使用通用、原創的娃娃示意設計，不包含任何未授權遊戲角色素材。

## 功能

- Nuxt 4 + Vue 3 SSR 響應式介面
- 首頁滿版分頁、原生 scroll snap 與段落進出場動畫
- 首頁 OpenStreetMap／Leaflet 真實圖資、互動頭像標記與縣市篩選
- Discord OAuth2 登入、SQLite 工作階段與 Discord ID 管理員白名單
- 寫下旅箋：照片、縣市、景點、座標、娃娃名稱、日期與心得
- 6 種通用預設頭像，或在瀏覽器以 Canvas 裁切照片區塊作為頭像
- 旅箋詳情與訪客留言
- 管理中心：會員列表、旅箋檢視與管理員刪除
- Nitro API + SQLite 持久化
- 具總量／欄位／檔案上限的串流 multipart 圖片上傳與圖片讀取路由
- Docker 多階段 production image、非 root 執行、健康檢查與 Compose volume

## 技術版本與安全基線

建立時已採 npm registry 的穩定最新版：

- Nuxt `4.5.0`（Vue `3.5.x`、Nitro `2.13.x`）
- Leaflet `1.9.4` + OpenStreetMap Standard tiles
- @fastify/busboy `3.2.0`（有界限的串流 multipart parser）
- better-sqlite3 `13.0.1`
- Vitest `4.1.10`
- Node.js `24.18.0` 容器映像（Node 24 LTS 線）

`package-lock.json` 固定完整依賴樹。由於 Nitro 目前的封裝工具仍宣告舊版 `glob` / `readdir-glob`，本專案使用 npm `overrides` 將它們鎖定至相容且已修補的版本。驗證結果：`npm audit` 為 **0 vulnerabilities**。

安全措施包括：

- 圖片僅接受 JPEG、PNG、WebP，並同時檢查 MIME 與 magic bytes
- 單檔預設限制 5 MiB（可用環境變數調整），multipart 以 Busboy 串流解析並限制總檔案數、欄位數與 request 大小，避免先把無界限請求載入記憶體
- 上傳檔名由密碼學亂數產生，讀取路由會防止路徑穿越
- API 對長度、縣市、座標、日期、頭像選項做伺服器端驗證；留言 JSON 亦以串流方式限制為 8 KiB
- SQLite 使用 prepared statements
- 上傳內容加上 `nosniff`、明確 Content-Type 與保守快取標頭
- 寫下旅箋需 Discord 登入，建立與匿名留言另含每 IP／程序的基本速率限制；預設不信任可偽造的 `X-Forwarded-For`（多實例正式環境仍建議由反向代理或 Redis 統一限流）
- Docker runtime 使用 UID/GID 1001 非 root 使用者、drop capabilities、`no-new-privileges`

> 沒有任何專案可以永久保證零漏洞。部署後仍應定期執行 `npm outdated`、`npm audit`、重建映像，並訂閱 Nuxt、Node 與 better-sqlite3 的安全公告。

## 專案結構

```text
app.vue                    Nuxt 應用外框
pages/                     首頁、建立旅箋、旅箋詳情
middleware/                會員與管理員頁面守衛
components/                通用 RegionMap、卡片、頭像裁切等元件
assets/css/main.css        全站視覺與響應式樣式
server/api/                Nitro JSON / multipart API
server/routes/uploads/     上傳圖片讀取路由
server/utils/              SQLite、驗證與上傳工具
data/                      SQLite 與上傳圖片（執行時產生）
test/                      Vitest 驗證與上傳安全測試
e2e/                       Playwright 多尺寸頁面與權限檢查
tsconfig.json              Nuxt 前端、伺服器與共用程式的型別檢查入口
```

## 本機開發

### 需求

- Node.js `^22.19.0`、`^24.11.0` 或 `>=26.0.0`
- npm 11+

目前建議使用 Node 24 LTS。

```bash
git clone <你的 repository URL>
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

目前測試涵蓋 OAuth URL／code exchange／state、Session Cookie 與撤銷、管理員白名單、安全回跳路徑、same-origin、SQLite fresh schema 與 legacy migration、foreign-key cascade、建立者綁定、檔案刪除、頁面權限，以及 320px 到桌面與矮螢幕的滿版 snap 幾何。Playwright 每次會建立獨立暫存資料庫與 uploads 目錄，結束後自動移除，不會污染開發資料。

可測試健康端點：

```bash
curl http://localhost:3000/api/health
```

## 地圖架構與 OpenStreetMap 使用方式

首頁的 `components/RegionMap.client.vue` 是可重用的 client-only 地圖渲染元件，使用 Leaflet 顯示 OpenStreetMap Standard tiles，並直接以每則旅箋的經緯度建立頭像 Marker。元件的 `region` 參數包含 `center`、`zoom`、`minZoom`、`maxZoom` 與 `bounds`，未來支援日本、亞洲或全球時不需重寫地圖，只需傳入新的區域設定與旅箋資料。

目前預設臺灣設定：

```ts
{
  id: 'taiwan',
  label: '臺灣',
  center: [23.72, 121.0],
  zoom: 7,
  bounds: [[20.4, 117.7], [26.9, 123.8]]
}
```

地圖依 OpenStreetMap 規範保留可見 attribution。公開正式服務需遵守 [OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)：不可大量預抓、離線抓取或移除 attribution。若流量增加，應改用有 SLA 的圖磚供應商（例如 MapTiler、Stadia Maps）或自行架設 tile server，並只替換 `tileLayer` URL／attribution，不需更動旅箋資料模型。

## API 摘要

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/api/health` | 健康檢查 |
| `GET` | `/auth/discord` | 發起／接收 Discord OAuth2 登入 |
| `GET` | `/api/auth/session` | 目前登入狀態 |
| `POST` | `/api/auth/logout` | 登出並撤銷伺服器 Session |
| `GET` | `/api/checkins` | 旅箋列表 |
| `POST` | `/api/checkins` | 登入後以 multipart 建立旅箋 |
| `GET` | `/api/checkins/:id` | 旅箋與留言詳情 |
| `POST` | `/api/checkins/:id/comments` | 建立留言 |
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

Docker Compose 適合單機 VPS。正式公開服務建議在容器前放置 Caddy、Nginx、Traefik 或雲端 Load Balancer：

1. DNS 指向伺服器。
2. 反向代理 HTTPS 網域至 `127.0.0.1:3000`；只有防火牆確認 3000 不對外且代理會覆寫來源 IP 標頭時，才設定 `NUXT_TRUST_PROXY=true`。
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
| `NUXT_TRUST_PROXY` | `false` | 僅在 3000 埠不公開、且流量必經可信反向代理時設為 `true`，讓限流採用代理傳入 IP |
| `NUXT_PUBLIC_APP_URL` | `http://localhost:3000` | 公開網站 Origin，正式環境必須是 HTTPS |
| `NUXT_DISCORD_CLIENT_ID` | 無 | Discord Application Client ID |
| `NUXT_DISCORD_CLIENT_SECRET` | 無 | Discord Application Client Secret |
| `NUXT_DISCORD_REDIRECT_URI` | `<APP_URL>/auth/discord` | Discord Portal 中完全相同的 callback URL |
| `NUXT_ADMIN_DISCORD_IDS` | 無 | 逗號分隔的管理員 Discord User ID |
| `NUXT_SESSION_DAYS` | `30` | 登入 Session 天數，程式限制為 1–90 天 |
| `HOST` | `0.0.0.0` | Nitro 監聽位址 |
| `PORT` | `3000` | Nitro 連接埠 |

## 上線前仍建議補強

這份交付已要求 Discord 登入才能寫下旅箋，正式營運前仍建議加入：

- 更細緻的擁有者編輯／刪除權限與帳號封鎖流程
- Redis 或其他跨實例 rate limiting
- 圖片重新解碼與移除 EXIF/GPS metadata
- 自動與人工內容審核、檢舉、封鎖與刪除流程
- 隱私政策、服務條款、版權申訴與備份還原演練
