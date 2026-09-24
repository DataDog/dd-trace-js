'use strict'

const { test, expect } = require('@playwright/test')

const scenario = process.env.PLAYWRIGHT_SERIAL_SCENARIO

test.describe.serial('different budgets', () => {
  test('earlier short test', () => {
    if (scenario === 'earlier-fails-on-retry') expect(test.info().retry).toBe(0)
  })

  async function runLaterTest () {
    if (test.info().retry === 0) await new Promise(resolve => setTimeout(resolve, 6000))
    if (scenario === 'all-pass') return
    if (scenario === 'later-recovers' && test.info().retry > 0) return
    expect(true).toBe(false)
  }

  if (scenario === 'screenshots') {
    test('later slow test', async ({ page }) => {
      await page.setContent('<h1>Serial retry</h1>')
      await runLaterTest()
    })
  } else {
    test('later slow test', runLaterTest)
  }
})
