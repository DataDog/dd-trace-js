'use strict'

const { test, expect } = require('@playwright/test')

let cleanupCookie
let cleanupPreservedUserCookie
let cleanupRemovedRumCookie
let rejectedRumCookie

test.beforeEach(async ({ page }) => {
  const rumCookieFailure = process.env.RUM_COOKIE_FAILURE
  if (rumCookieFailure) {
    /**
     * @param {{ name: string, value: string, domain?: string, path?: string }[]} cookies
     */
    page.context().addCookies = ([cookie]) => {
      rejectedRumCookie = cookie
      if (rumCookieFailure === 'throw') {
        throw new Error('RUM correlation cookie threw')
      }
      return Promise.reject(new Error('RUM correlation cookie rejected'))
    }
  }
  if (process.env.VERIFY_RUM_COOKIE_CLEANUP === 'true') {
    const context = page.context()
    await context.addCookies([{
      name: 'user-cookie',
      value: 'kept',
      domain: 'localhost',
      path: '/',
    }])
    const addCookies = context.addCookies.bind(context)
    context.addCookies = async (cookies) => {
      await addCookies(cookies)
      const cookie = cookies[0]
      if (cookie.name === 'datadog-ci-visibility-test-execution-id' && cookie.expires === 0) {
        cleanupCookie = cookie
        const remainingCookies = await context.cookies()
        cleanupPreservedUserCookie = remainingCookies.some(({ name, value }) => {
          return name === 'user-cookie' && value === 'kept'
        })
        cleanupRemovedRumCookie = !remainingCookies.some(({ name }) => {
          return name === 'datadog-ci-visibility-test-execution-id'
        })
      }
    }
  }
  await page.goto(process.env.PW_BASE_URL)
})

test.afterAll(() => {
  if (process.env.VERIFY_RUM_COOKIE_CLEANUP === 'true') {
    expect(cleanupCookie).toEqual({
      name: 'datadog-ci-visibility-test-execution-id',
      value: '',
      domain: 'localhost',
      path: '/',
      expires: 0,
    })
    expect(cleanupPreservedUserCookie).toBe(true)
    expect(cleanupRemovedRumCookie).toBe(true)
  }
})

test.describe('playwright', () => {
  test('should have RUM active', async ({ page }) => {
    await expect(page.locator('.hello-world')).toHaveText([
      'Hello World',
    ])
    if (process.env.RUM_COOKIE_FAILURE) {
      expect(rejectedRumCookie).toEqual({
        name: 'datadog-ci-visibility-test-execution-id',
        value: expect.stringMatching(/^\d+$/),
        domain: 'localhost',
        path: '/',
      })
    }
  })
})
