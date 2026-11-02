'use strict'

const assert = require('node:assert/strict')

const { browser } = require('@wdio/globals')

describe('WebdriverIO videos', () => {
  beforeEach(async () => {
    if (process.env.WEBDRIVERIO_EXPECT_PROMPT_BEHAVIOR) {
      assert.strictEqual(browser.capabilities.unhandledPromptBehavior, process.env.WEBDRIVERIO_EXPECT_PROMPT_BEHAVIOR)
    }
    await browser.url('http://example.test/before')
    if (process.env.WEBDRIVERIO_VIDEO_HOOK === 'beforeEach') throw new Error('video beforeEach failure')
  })

  afterEach(async () => {
    await browser.url('http://example.test/after')
    if (process.env.WEBDRIVERIO_VIDEO_HOOK === 'afterEach') throw new Error('video afterEach failure')
  })

  it('passes', async () => {
    if (process.env.WEBDRIVERIO_FAKE_DATE === 'true') assert.strictEqual(Date.now(), 0)
    await browser.url('http://example.test/passing')
  })

  it('fails', async () => {
    await browser.url('http://example.test/failing')
    assert.fail('video test failure')
  })

  // A skipped attempt must not produce a video.
  xit('is skipped', () => {})
})
