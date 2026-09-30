'use strict'

const assert = require('node:assert/strict')

const { browser } = require('@wdio/globals')

describe('WebdriverIO browser videos', () => {
  beforeEach(() => {
    assert.strictEqual(browser.isBidi, process.env.WEBDRIVERIO_CLASSIC !== 'true')
  })

  it('discards a passing recording', async () => {
    await browser.url('data:text/html,<body style="background:white">Passing attempt</body>')
  })

  it('records navigation, commands, idle periods and the failed page', async () => {
    for (const [color, text] of [['red', 'START'], ['lime', 'NAVIGATED'], ['blue', 'FAILURE']]) {
      const html = `<body style="background:${color};color:white;font:48px sans-serif">
        <h1>${text}</h1><button onclick="this.textContent='Clicked'">Click me</button></body>`
      // Each navigation replaces the document, as in a real browser test.
      await browser.url(`data:text/html,${encodeURIComponent(html)}`)
      await browser.$('button').click()
      await browser.pause(800)
    }
    assert.fail('intentional failure for video inspection')
  })

  // A skipped attempt must not produce a video.
  xit('does not record a skipped attempt', () => {})
})
