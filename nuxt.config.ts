// 每一條指令都對應本站實際會載入的資源，之後新增外部相依時必須同步更新，否則會直接被瀏覽器擋下。
const contentSecurityPolicy = [
  // 沒有明確列出的資源型別一律只允許同源，避免漏掉的 fetch 目標變成資料外洩管道
  "default-src 'self'",
  // Nuxt SSR 會把 hydration payload 以 inline script 寫進 HTML，目前沒有 nonce 機制可掛，所以只能開 'unsafe-inline'。
  // 這不是嚴格 CSP：只要有 XSS 注入點，注入的 inline script 一樣會被執行。
  // 要拿掉必須改成 nonce-based CSP：每個請求產生一次性 nonce，用 nitro plugin 同時注入 <script nonce> 與這個標頭
  // （並且 'nonce-xxx' 與 'unsafe-inline' 不能並存，瀏覽器只要看到 nonce 就會忽略 'unsafe-inline'）。
  "script-src 'self' 'unsafe-inline'",
  // fonts.googleapis.com 來自 assets/css/main.css 第一行的 @import；
  // Vue scoped styles 與 Leaflet 會直接寫 style 屬性與 <style> 區塊，同樣得等 nonce 化之後才能收掉 'unsafe-inline'
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // Google Fonts 的樣式表在 googleapis，字型檔本身則從 gstatic 下載
  "font-src 'self' https://fonts.gstatic.com",
  // data: 供打包時被內聯的小圖（含 Leaflet 樣式內的圖示），blob: 供 AvatarCropper 的 canvas 裁圖與表單本機預覽，
  // tile.openstreetmap.org 是 RegionMap.client.vue 的地圖圖磚，cdn.discordapp.com 是登入後的 Discord 頭像
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://cdn.discordapp.com",
  // 前端只打自家 /api，Discord 的 token 交換全在 server 端完成，不需要放行任何外部主機
  "connect-src 'self'",
  // 站上沒有任何 <object>/<embed>，關掉可移除一整類舊外掛的執行途徑
  "object-src 'none'",
  // 鎖住 <base>，避免注入 <base href> 把所有相對路徑資源導去攻擊者主機
  "base-uri 'self'",
  // 表單只會送回本站，防止被改成把留言或登入資料送去外部
  "form-action 'self'",
  // /admin 上就是「刪除旅箋」按鈕，禁止被內嵌才擋得住 clickjacking（X-Frame-Options 是給舊瀏覽器的等價保險）
  "frame-ancestors 'none'"
].join('; ')

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // 只有 pages/checkins/new.vue 的「使用目前位置」需要定位，其餘裝置能力站上完全用不到，一律關閉
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), midi=(), display-capture=()',
  'Content-Security-Policy': contentSecurityPolicy
}

export default defineNuxtConfig({
  compatibilityDate: '2026-03-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant' },
      title: '未完旅箋｜小小的你，世界很大',
      meta: [
        { name: 'description', content: '和心愛的小小旅伴一起去遠方，把共同看過的風景與故事，寫進仍在延續的旅箋。' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#fff7ee' },
        // 不要再把 X-Content-Type-Options 寫成 <meta http-equiv>：瀏覽器只認真正的 HTTP header，
        // meta 形式完全不生效，會誤導後人以為已經有防護。真正的設定在下面的 routeRules。
        // <meta name="referrer"> 則是規格上有效的形式，保留當作 Referrer-Policy 標頭的備援。
        { name: 'referrer', content: 'strict-origin-when-cross-origin' }
      ]
    }
  },
  routeRules: {
    // 全站套用安全標頭；只有真正的 HTTP header 才會被瀏覽器採信
    '/**': { headers: securityHeaders },
    // 使用者上傳的圖片是公開提供的第三方內容，被直接開啟時應該完全沒有執行能力：
    // 就算有人上傳同時是合法圖片又是合法 HTML 的 polyglot 檔，default-src 'none' + sandbox
    // 也讓它在本站 origin 下讀不到、也做不了任何事。
    // 這裡刻意只覆寫 CSP，Content-Type 與 Cache-Control 仍由 server/routes/uploads/[file].get.ts 決定。
    '/uploads/**': { headers: { 'Content-Security-Policy': "default-src 'none'; sandbox" } }
  },
  runtimeConfig: {
    databasePath: './data/journey-unfinished.sqlite',
    uploadDir: './data/uploads',
    maxUploadBytes: 5_242_880,
    trustProxy: false,
    // 0 代表完全忽略 X-Forwarded-For（安全預設，來源 IP 一律取 socket 位址，任何人都無法偽造）；
    // 設為 N 代表應用前面有 N 層可信代理，來源 IP 取 XFF 由右往左數第 N 筆
    // （左邊的欄位是上游隨手加的、可被客戶端偽造，只有最右邊 N 筆是自家代理寫的）。
    trustedProxyHops: 0,
    discordClientId: '',
    discordClientSecret: '',
    discordRedirectUri: '',
    adminDiscordIds: '',
    sessionDays: 30,
    public: {
      appUrl: 'http://localhost:3000'
    }
  },
  nitro: {
    // better-sqlite3 與 sharp 都是原生模組（.node binding），被 bundle 進去會找不到二進位檔
    externals: { external: ['better-sqlite3', 'sharp'] }
  },
  typescript: { strict: true }
})
