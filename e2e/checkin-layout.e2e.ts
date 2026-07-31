import { expect, test, type Page } from '@playwright/test'
import { authenticate, seedApplication, waitForHydration } from './fixtures/app'

async function setGeneratedPng(page: Page, selector: string, filename: string) {
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: 32, height: 32 } })
  await page.locator(selector).setInputFiles({ name: filename, mimeType: 'image/png', buffer })
}

async function creationGeometry(page: Page) {
  return page.evaluate(() => {
    const measure = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, right: rect.right, width: rect.width, scrollWidth: element.scrollWidth }
    }
    return {
      viewport: window.innerWidth,
      page: measure('.form-page'),
      layout: measure('.form-layout'),
      form: measure('.checkin-form'),
      aside: measure('.form-aside'),
      firstTwoFieldGrid: measure('.field-grid.two'),
      coordinateButton: measure('.coordinate-heading .secondary-button'),
      photoUpload: measure('.upload-drop:not(.compact-upload)'),
      columns: getComputedStyle(document.querySelector('.form-layout')!).gridTemplateColumns,
      fieldColumns: getComputedStyle(document.querySelector('.field-grid.two')!).gridTemplateColumns
    }
  })
}

test.beforeAll(async () => {
  await seedApplication()
})

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'desktop-breakpoint', width: 1101, height: 900 },
  { name: 'stacked-breakpoint', width: 1100, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'minimum-mobile', width: 320, height: 568 }
]) {
  test(`${viewport.name} keeps the creation form centered and correctly stacked`, async ({ page, context }) => {
    await page.setViewportSize(viewport)
    await authenticate(context, 'admin')
    await page.goto('/checkins/new')
    await page.evaluate(() => document.fonts.ready)
    const geometry = await creationGeometry(page)
    const expectedGutter = viewport.width <= 720 ? 14 : viewport.width > 1216 ? (viewport.width - 1180) / 2 : 18
    const expectedWidth = Math.min(1180, viewport.width - (viewport.width <= 720 ? 28 : 36))

    expect(geometry.page.width, JSON.stringify(geometry)).toBeCloseTo(expectedWidth, 0)
    expect(geometry.page.x, JSON.stringify(geometry)).toBeCloseTo(expectedGutter, 0)
    expect(geometry.layout.x).toBeCloseTo(geometry.page.x, 0)
    expect(geometry.layout.width).toBeCloseTo(geometry.page.width, 0)
    expect(geometry.form.scrollWidth).toBeLessThanOrEqual(geometry.form.width)
    expect(geometry.aside.scrollWidth).toBeLessThanOrEqual(geometry.aside.width)
    expect(geometry.coordinateButton.x).toBeGreaterThanOrEqual(geometry.form.x)
    expect(geometry.coordinateButton.right).toBeLessThanOrEqual(geometry.form.right + 1)
    expect(geometry.photoUpload.x).toBeGreaterThanOrEqual(geometry.form.x)
    expect(geometry.photoUpload.right).toBeLessThanOrEqual(geometry.form.right + 1)

    if (viewport.width > 1100) {
      expect(geometry.columns.split(' ')).toHaveLength(2)
      expect(geometry.form.x).toBeCloseTo(geometry.page.x, 0)
      expect(geometry.aside.right).toBeCloseTo(geometry.page.right, 0)
      expect(Math.abs(geometry.aside.y - geometry.form.y)).toBeLessThanOrEqual(1)
    } else {
      expect(geometry.columns.split(' ')).toHaveLength(1)
      expect(geometry.form.width).toBeCloseTo(geometry.page.width, 0)
      expect(geometry.aside.width).toBeCloseTo(geometry.page.width, 0)
      expect(geometry.aside.y).toBeLessThan(geometry.form.y)
    }

    expect(geometry.fieldColumns.split(' ')).toHaveLength(viewport.width <= 720 ? 1 : 2)
  })
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
]) {
  test(`${viewport.name} image previews and crop controls remain inside the form`, async ({ page, context }) => {
    await page.setViewportSize(viewport)
    await authenticate(context, 'admin')
    await page.goto('/checkins/new')
    await waitForHydration(page)
    await setGeneratedPng(page, '.avatar-cropper input[type="file"]', 'avatar.png')
    await expect(page.locator('.crop-editor')).toBeVisible()
    await setGeneratedPng(page, '#travel-photo', 'trip.png')
    await expect(page.locator('.upload-drop.has-preview')).toBeVisible()

    const bounds = await page.evaluate(() => {
      const form = document.querySelector('.checkin-form')!.getBoundingClientRect()
      return ['.crop-editor', '.crop-canvas-wrap', '.crop-controls', '.upload-drop.has-preview'].map((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect()
        return { selector, left: rect.left, right: rect.right, width: rect.width, formLeft: form.left, formRight: form.right }
      })
    })
    for (const item of bounds) {
      expect(item.left, JSON.stringify(item)).toBeGreaterThanOrEqual(item.formLeft)
      expect(item.right, JSON.stringify(item)).toBeLessThanOrEqual(item.formRight + 1)
      expect(item.width).toBeGreaterThan(0)
    }
  })
}
