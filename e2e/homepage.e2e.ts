import { expect, test, type Page } from '@playwright/test'
import { seedApplication } from './fixtures/app'

async function panelGeometry(page: Page, index: number) {
  return page.evaluate((panelIndex) => {
    const root = document.querySelector<HTMLElement>('.home-page')!
    const panels = [...document.querySelectorAll<HTMLElement>('.home-panel')]
    const panel = panels[panelIndex]
    if (!panel) throw new Error(`Missing home panel ${panelIndex}`)
    const rootRect = root.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    return {
      rootHeight: root.clientHeight,
      rootScrollHeight: root.scrollHeight,
      rootScrollTop: root.scrollTop,
      panelHeight: panel.getBoundingClientRect().height,
      panelOffsetTop: panel.offsetTop,
      panelTopDelta: panelRect.top - rootRect.top,
      windowScrollY: window.scrollY
    }
  }, index)
}

async function goToPanel(page: Page, index: number) {
  await expect(page.locator('.home-page')).toHaveClass(/is-enhanced/)
  await page.locator('.page-dots button').nth(index).click()
  await expect(page.locator('.page-dots button').nth(index)).toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => Math.abs((await panelGeometry(page, index)).panelTopDelta)).toBeLessThanOrEqual(1)
}

test.beforeAll(async () => {
  await seedApplication()
})

test('presents the renamed brand and metadata', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('未完旅箋｜小小的你，世界很大')
  await expect(page.locator('.brand-copy strong')).toHaveText('未完旅箋')
  await expect(page.locator('.hero-panel h1')).toContainText('小小的你，世界很大。')
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /寫進仍在延續的旅箋/)
})

for (const viewport of [
  { name: 'mobile', width: 360, height: 800 },
  { name: 'short', width: 1024, height: 600 },
  { name: 'desktop', width: 1440, height: 900 }
]) {
  test.describe(`snap geometry ${viewport.name}`, () => {
    test.use({ viewport })

    test('all four pages align exactly with the inner scroller', async ({ page }) => {
      await page.goto('/')
      for (let index = 0; index < 4; index += 1) {
        await goToPanel(page, index)
        const geometry = await panelGeometry(page, index)
        expect(Math.abs(geometry.panelHeight - geometry.rootHeight), JSON.stringify(geometry)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.rootScrollTop - geometry.panelOffsetTop), JSON.stringify(geometry)).toBeLessThanOrEqual(1)
        expect(geometry.windowScrollY).toBe(0)
      }
      const geometry = await panelGeometry(page, 3)
      expect(Math.abs(geometry.rootScrollHeight - geometry.rootHeight * 4)).toBeLessThanOrEqual(2)
    })

    test('map page has no inherited top gap', async ({ page }) => {
      await page.goto('/')
      await goToPanel(page, 1)
      const spacing = await page.evaluate(() => {
        const rootTop = document.querySelector('.home-page')!.getBoundingClientRect().top
        const panel = document.querySelector<HTMLElement>('#map')!
        const headingTop = panel.querySelector('.section-heading')!.getBoundingClientRect().top
        return {
          panelTop: panel.getBoundingClientRect().top - rootTop,
          headingTop: headingTop - rootTop,
          scrollMarginTop: getComputedStyle(panel).scrollMarginTop
        }
      })
      expect(spacing.panelTop).toBeCloseTo(0, 0)
      expect(spacing.headingTop).toBeGreaterThanOrEqual(18)
      expect(spacing.headingTop).toBeLessThanOrEqual(45)
      expect(spacing.scrollMarginTop).toBe('0px')
    })
  })
}

test('panel content exits and returns from opposite directions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.locator('.home-page')).toHaveClass(/is-enhanced/)
  await expect(page.locator('.hero-panel .hero-copy')).toHaveCSS('opacity', '1')
  const inactiveTransform = await page.locator('#map .map-panel').evaluate(element => getComputedStyle(element).transform)
  expect(inactiveTransform).not.toBe('none')
  await goToPanel(page, 1)
  await expect(page.locator('#map .map-panel')).toHaveCSS('opacity', '1')
  await expect.poll(() => page.locator('#map .map-panel').evaluate((element) => {
    const transform = new DOMMatrix(getComputedStyle(element).transform)
    return Math.abs(transform.e) + Math.abs(transform.f)
  })).toBeLessThan(0.1)
  await expect(page.locator('.hero-panel .hero-copy')).toHaveCSS('opacity', '0')
})

test.describe('reduced motion', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('removes transition duration and delay while preserving navigation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await goToPanel(page, 1)
    const motion = await page.locator('#map .map-panel').evaluate((element) => {
      const style = getComputedStyle(element)
      return { duration: style.transitionDuration, delay: style.transitionDelay, opacity: style.opacity }
    })
    expect(Number.parseFloat(motion.duration) * 1000).toBeLessThanOrEqual(.02)
    expect(Number.parseFloat(motion.delay)).toBe(0)
    expect(motion.opacity).toBe('1')
  })
})
