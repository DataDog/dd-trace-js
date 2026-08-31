'use strict'

/* global browser */

describe('WebdriverIO RUM correlation without afterEach', () => {
  it('correlates the first RUM session', async () => {
    await browser.url('http://first.example.test')
  })

  it('cleans the first session before correlating the second', async () => {
    await browser.url('http://second.example.test')
  })
})
