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
    externals: { external: ['better-sqlite3'] }
  },
  typescript: { strict: true }
})
