'use strict'

/* global browser */

describe('WebdriverIO RUM correlation without afterEach', () => {
  it('correlates the first RUM session', async () => {
    await browser.url('http://first.example.test')
  })

  it('reuses the first RUM session for the second test', () => {})
})
