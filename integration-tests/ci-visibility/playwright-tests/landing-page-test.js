'use strict'

const { test, expect } = require('@playwright/test')
const tracer = require('dd-trace')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

// active span is only supported from >=1.38.0, at which point we add DD_PLAYWRIGHT_WORKER to the env
function setActiveTestSpanTags (tags) {
  if (process.env.DD_PLAYWRIGHT_WORKER) {
    tracer.scope().active().addTags(tags)
  }
  return null
}

test.describe('highest-level-describe', () => {
  test.describe(' leading and trailing spaces ', () => {
    // even empty describe blocks should be allowed
    test.describe(' ', () => {
      test.beforeEach(async ({ page }) => {
        setActiveTestSpanTags({
          'custom_tag.beforeEach': 'hello beforeEach'
        })
      })
      test.afterEach(async ({ page }) => {
        setActiveTestSpanTags({
          'custom_tag.afterEach': 'hello afterEach'
        })
      })
      test('should work with passing tests', async ({ page }) => {
        setActiveTestSpanTags({
          'custom_tag.it': 'hello it'
        })
        await expect(page.locator('.hello-world')).toHaveText([
          'Hello World'
        ])
      })
      test.skip('should work with skipped tests', async ({ page }) => {
        await expect(page.locator('.hello-world')).toHaveText([
          'Hello World'
        ])
      })
      test.fixme('should work with fixme', async ({ page }) => {
        await expect(page.locator('.hello-world')).toHaveText([
          'Hello Warld'
        ])
      })
      test('should work with annotated tests', async ({ page }) => {
        test.info().annotations.push({ type: 'DD_TAGS[test.memory.usage]', description: 'low' })
        test.info().annotations.push({ type: 'DD_TAGS[test.memory.allocations]', description: 16 })
        // this is malformed and should be ignored
        test.info().annotations.push({ type: 'DD_TAGS[test.invalid', description: 'high' })
        await expect(page.locator('.hello-world')).toHaveText([
          'Hello World'
        ])
      })
    })
  })
})
