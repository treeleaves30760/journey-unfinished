import { expect, test, type Page } from '@playwright/test'
import { authenticate, clearDrafts, seedApplication, waitForHydration } from './fixtures/app'

// 上傳用的圖片直接拿頁面截圖：那是一張真的能被 sharp 解碼的 PNG，
// 湊 magic bytes 的假檔案會在伺服器重新編碼時被擋下（見 fixtures 的 sampleJpeg 註解）。
async function attachScreenshot(page: Page, selector: string) {
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: 32, height: 32 } })
  await page.locator(selector).setInputFiles({ name: 'trip.png', mimeType: 'image/png', buffer })
}

async function setCoordinates(page: Page, latitude: string, longitude: string) {
  // 走「手動輸入座標」而不是瀏覽器定位：定位會觸發反查地址、打到外部服務，
  // 這個測試要驗證的是表單本身，不該綁在網路可用性上。
  await page.getByRole('button', { name: '手動輸入座標' }).click()
  await page.locator('.picker-manual input').first().fill(latitude)
  await page.locator('.picker-manual input').nth(1).fill(longitude)
}

test.beforeEach(async () => {
  await seedApplication()
  // 草稿會留在同一個 e2e 資料庫裡，不清掉的話「應該只有一份草稿」會被前一個案例的殘留破壞
  clearDrafts()
})

test('the compose form offers worldwide place fields and a live markdown preview', async ({ page, context }) => {
  await authenticate(context, 'member')
  await page.goto('/checkins/new')
  await waitForHydration(page)

  // 全球化：區域是完整的 ISO 清單（分洲別群組），行政區是自由文字而不是臺灣 22 縣市的列舉
  const region = page.locator('select').filter({ has: page.locator('optgroup[label="亞洲"]') })
  await expect(region).toHaveValue('TW')
  await expect(region.locator('optgroup')).toHaveCount(6)
  // 選項只有名稱，沒有國旗 emoji —— 介面刻意不顯示主權符號
  await expect(region.locator('option[value="JP"]')).toHaveText('日本')
  await region.selectOption('JP')
  await expect(page.locator('#taiwan-counties')).toHaveCount(0)

  await page.locator('#travel-message').fill('# 竹林的清晨\n\n- 廣角鏡\n- 底片兩捲\n\n> 下次想在秋天再來。')
  await page.getByRole('tab', { name: '預覽' }).click()
  const preview = page.locator('.markdown-preview')
  await expect(preview.locator('h2')).toHaveText('竹林的清晨')
  await expect(preview.locator('li')).toHaveCount(2)
  await expect(preview.locator('blockquote')).toContainText('下次想在秋天再來。')
})

test('saving from the compose form creates a draft and then updates the same one', async ({ page, context }) => {
  await authenticate(context, 'member')
  await page.goto('/checkins/new')
  await waitForHydration(page)

  await page.getByLabel(/行政區/).fill('新北市')
  await page.getByLabel(/地點名稱/).fill('淡水漁人碼頭')
  await page.getByRole('button', { name: '存成草稿' }).click()
  await expect(page).toHaveURL(/\/checkins\/new\?draft=\d+/)
  const draftUrl = page.url()

  // 第二次儲存走的是「更新既有草稿」，不該再開一份新的
  await expect(page.getByRole('button', { name: '更新草稿' })).toBeVisible()
  await page.locator('#travel-message').fill('先記下來，回家再寫完。')
  await page.getByRole('button', { name: '更新草稿' }).click()
  await expect(page.locator('.info-alert')).toContainText('草稿已儲存')
  expect(page.url()).toBe(draftUrl)

  await page.goto('/drafts')
  await waitForHydration(page)
  await expect(page.locator('.draft-card')).toHaveCount(1)
  await expect(page.locator('.draft-excerpt')).toContainText('先記下來，回家再寫完。')
})

test('the markdown preview renders user HTML as text instead of executing it', async ({ page, context }) => {
  await authenticate(context, 'member')
  await page.goto('/checkins/new')
  await waitForHydration(page)

  await page.locator('#travel-message').fill('<img src=x onerror="window.__xss = true"> 與 [連結](javascript:alert(1))')
  await page.getByRole('tab', { name: '預覽' }).click()

  const preview = page.locator('.markdown-preview')
  // 預覽全程用 h() 產生節點，沒有任何 v-html：HTML 只會變成文字
  await expect(preview.locator('img')).toHaveCount(0)
  await expect(preview.locator('a')).toHaveCount(0)
  await expect(preview).toContainText('<img src=x onerror="window.__xss = true">')
  expect(await page.evaluate(() => (window as { __xss?: boolean }).__xss)).toBeUndefined()
})

test('a phone capture becomes a draft that the desktop form picks up and publishes', async ({ page, context }) => {
  await authenticate(context, 'member')
  await page.setViewportSize({ width: 390, height: 844 })

  // 手機端：拍照 → 標位置 → 存草稿
  await page.goto('/checkins/quick')
  await waitForHydration(page)
  await attachScreenshot(page, '.quick-capture input[type="file"]')
  await setCoordinates(page, '35.0169', '135.6716')
  await page.getByRole('button', { name: '存成草稿' }).click()
  await expect(page.getByRole('heading', { name: '草稿已存好' })).toBeVisible()

  // 草稿列表看得到它，而且會標出還缺哪些欄位
  await page.goto('/drafts')
  await waitForHydration(page)
  await expect(page.locator('.draft-card')).toHaveCount(1)
  await expect(page.locator('.draft-missing')).toContainText('旅途留言')

  // 電腦端：打開同一份草稿接手，照片與座標都還在
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.draft-card').getByRole('link', { name: /繼續寫/ }).click()
  await expect(page).toHaveURL(/\/checkins\/new\?draft=\d+/)
  await waitForHydration(page)
  await expect(page.locator('.upload-drop.has-preview img')).toBeVisible()
  await page.getByRole('button', { name: '手動輸入座標' }).click()
  await expect(page.locator('.picker-manual input').first()).toHaveValue('35.0169')

  // 補完剩下的欄位後直接發佈：草稿的照片會被沿用，不必再上傳一次。
  // 區域也在這一步才確定——手機上沒有網路或反查失敗時，草稿會停在預設的臺灣，
  // 回到電腦改成正確的區域是這個流程本來就該支援的事。
  await page.locator('select').filter({ has: page.locator('optgroup[label="亞洲"]') }).selectOption('JP')
  await page.getByLabel(/行政區/).fill('京都府')
  await page.getByLabel(/地點名稱/).fill('嵐山竹林小徑')
  await page.getByLabel(/娃娃名稱/).fill('小柚')
  await page.locator('#travel-message').fill('# 竹林的清晨\n\n六點的竹林還沒有人，只有風。')
  await page.getByRole('button', { name: /寫進未完旅箋/ }).click()

  await expect(page).toHaveURL(/\/checkins\/\d+\?created=1/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('嵐山竹林小徑')
  // 詳情頁用 MarkdownView 渲染心得：使用者寫的 # 從 h2 起跳，頁面仍然只有一個 h1
  await expect(page.locator('.detail-message h2')).toHaveText('竹林的清晨')
  await expect(page.locator('.county-chip')).toContainText('日本・京都府')
  await expect(page.locator('.detail-photo img')).toBeVisible()

  // 發佈成功之後草稿就消失了
  await page.goto('/drafts')
  await waitForHydration(page)
  await expect(page.locator('.draft-card')).toHaveCount(0)
})
