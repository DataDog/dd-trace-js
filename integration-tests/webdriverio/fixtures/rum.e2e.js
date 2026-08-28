'use strict'

/* global browser */

describe('WebdriverIO RUM correlation', () => {
  it('correlates the RUM session with the test execution', async () => {
    await browser.url('http://example.test')
  })
})
