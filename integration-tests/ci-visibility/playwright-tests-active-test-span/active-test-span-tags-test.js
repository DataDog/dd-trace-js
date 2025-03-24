const { test, expect } = require('@playwright/test')
const tracer = require('dd-trace')

test.beforeEach(async ({ page }) => {
  await page.goto(process.env.PW_BASE_URL)
})

test.describe('playwright', () => {
  test('should be able to grab the active test span', async ({ page }) => {
    const testSpan = tracer.scope().active()

    // TODO: remove this comment
    // This is simple and it can actually be done with annotations today, but
    // this allows distributed tracing: if the customer were to start an HTTP request
    // here it would have the correct headers
    // It also makes it simpler to for example add a correlation between the test
    // and a RUM session.
    testSpan.addTags({
      'test.custom_tag': 'this is custom'
    })

    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World'
    ])
  })
})
