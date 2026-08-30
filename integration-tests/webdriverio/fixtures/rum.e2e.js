'use strict'

/* global browser */

describe('WebdriverIO RUM correlation', () => {
  afterEach(async () => {
    await browser.url('http://after-each.example.test')
  })

  it('correlates the RUM session with the test execution', async () => {
    await browser.url('http://example.test')
    await browser.refresh()
  })
})
