'use strict'

const assert = require('node:assert/strict')
const { setTimeout } = require('node:timers/promises')

const { browser } = require('@wdio/globals')

describe('WebdriverIO video without teardown hooks', () => {
  let failing = false
  let completed = 0
  let pending = 0

  before(() => {
    browser.overwriteCommand('takeScreenshot', async function (original) {
      const screenshot = await original()
      if (failing) {
        pending++
        await setTimeout(150)
        pending--
        completed++
      }
      return screenshot
    })
  })

  it('fails without afterEach hooks', async () => {
    assert.strictEqual(pending, 0, 'the previous attempt must finish capturing before a retry')
    failing = false
    completed = 0
    await browser.url('data:text/html,<body style="background:lime">Failed attempt</body>')
    failing = true
    assert.fail('failure without teardown hooks')
  })

  it('starts only after the final failed attempt has finished capturing', async () => {
    assert.strictEqual(pending, 0)
    assert.ok(completed > 0, 'the final screenshot must settle before the next test starts')
    failing = false
    await browser.url('data:text/html,<body style="background:blue">Next test</body>')
  })
})
