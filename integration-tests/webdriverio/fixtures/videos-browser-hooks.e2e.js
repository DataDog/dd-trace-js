'use strict'

const assert = require('node:assert/strict')

const { browser } = require('@wdio/globals')

const failure = process.env.WEBDRIVERIO_VIDEO_HOOK

afterEach(async () => {
  await browser.url('data:text/html,<body style="background:lime">Final teardown</body>')
  if (failure === 'root' || failure === 'cascading') throw new Error('final teardown failed')
})

describe('WebdriverIO hook failure video', () => {
  afterEach(async () => {
    await browser.url('data:text/html,<body style="background:red">Outer teardown</body>')
    if (failure === 'cascading') throw new Error('outer teardown failed')
  })

  describe('inner suite', () => {
    beforeEach(async () => {
      await browser.url('data:text/html,<body style="background:blue">Setup</body>')
      if (failure === 'beforeEach' || failure === 'cascading') throw new Error('setup failed')
    })

    afterEach(async () => {
      await browser.url('data:text/html,<body style="background:yellow">Inner teardown</body>')
      if (failure === 'afterEach' || failure === 'retry' || failure === 'cascading') {
        throw new Error('inner teardown failed')
      }
    })

    it('records every remaining teardown hook', () => {
      if (failure === 'retry') assert.fail('retry this failure')
    })
  })
})
