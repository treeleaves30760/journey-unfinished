import { expect, test, type Page } from '@playwright/test'
import { authenticate, seedApplication } from './fixtures/app'

let firstCheckinId: number

async function stabilize(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#main-content').waitFor()
  await page.evaluate(() => document.fonts.ready)
}

async function expectNoAccidentalOverflow(page: Page) {
  await stabilize(page)
  const metrics = await page.evaluate(() => {
    const viewport = window.innerWidth
    const allowedScroller = '.admin-table-wrap, .stories-panel .card-grid, .map-side .story-list, .leaflet-container'
    const offenders = [...document.querySelectorAll<HTMLElement>('a, button, input, select, textarea, summary')]
      .filter((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return false
        if (element.closest(allowedScroller) || element.closest('.home-panel:not(.is-active)')) return false
        return rect.left < -1 || rect.right > viewport + 1
      })
      .map(element => `${element.tagName.toLowerCase()}.${element.className}:${element.textContent?.trim().slice(0, 24)}`)
    const main = document.querySelector<HTMLElement>('#main-content')
    return {
      viewport,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      mainWidth: main?.getBoundingClientRect().width || 0,
      offenders
    }
  })
  expect(metrics.documentWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport + 1)
  expect(metrics.bodyWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport + 1)
  expect(metrics.mainWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport + 1)
  expect(metrics.offenders, JSON.stringify(metrics)).toEqual([])
}

test.beforeAll(async () => {
  ({ firstCheckinId } = await seedApplication())
})

for (const viewport of [
  { name: 'minimum-mobile', width: 320, height: 568 },
  { name: 'mobile', width: 360, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'short-desktop', width: 1024, height: 600 },
  { name: 'desktop', width: 1440, height: 900 }
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport })

    test('all public pages keep visible controls inside the viewport', async ({ page }) => {
      for (const path of ['/', '/login', `/checkins/${firstCheckinId}`]) {
        await page.goto(path)
        await expectNoAccidentalOverflow(page)
      }
    })

    test('creation and admin pages keep visible controls inside the viewport', async ({ page, context }) => {
      await authenticate(context, 'admin')
      for (const path of ['/checkins/new', '/admin']) {
        await page.goto(path)
        await expect(page).toHaveURL(new RegExp(`${path}$`))
        await expectNoAccidentalOverflow(page)
      }
      await page.locator('.account-menu summary').click()
      await expect(page.locator('.account-popover')).toBeVisible()
      await expectNoAccidentalOverflow(page)
    })
  })
}
