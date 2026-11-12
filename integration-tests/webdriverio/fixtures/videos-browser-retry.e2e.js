'use strict'

const assert = require('node:assert/strict')

const { browser } = require('@wdio/globals')

describe('WebdriverIO retry teardown video', () => {
  afterEach(async () => {
    await browser.url('data:text/html,<body style="background:lime">Teardown</body>')
    if (process.env.WEBDRIVERIO_VIDEO_HOOK === 'afterEach') throw new Error('teardown failed')
  })

  it('records teardown before retrying', async function () {
    await browser.url('data:text/html,<body style="background:blue">Test body</body>')
    if (this.test.currentRetry() === 0) assert.fail('retry this failure')
  })
})
