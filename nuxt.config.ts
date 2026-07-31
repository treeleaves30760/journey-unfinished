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
        { 'http-equiv': 'X-Content-Type-Options', content: 'nosniff' },
        { name: 'referrer', content: 'strict-origin-when-cross-origin' }
      ]
    }
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
