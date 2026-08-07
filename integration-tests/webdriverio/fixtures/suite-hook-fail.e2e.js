'use strict'

const hookType = process.env.WEBDRIVERIO_SUITE_HOOK
const beforeSuite = process.env.WEBDRIVERIO_FRAMEWORK === 'jasmine' ? globalThis.beforeAll : globalThis.before
const afterSuite = process.env.WEBDRIVERIO_FRAMEWORK === 'jasmine' ? globalThis.afterAll : globalThis.after

describe('WebdriverIO suite hook failure', () => {
  if (hookType === 'beforeAll') {
    beforeSuite(() => {
      throw new Error('beforeAll failure')
    })
  } else {
    afterSuite(() => {
      throw new Error('afterAll failure')
    })
  }

  it('is quarantined', () => {})
})
