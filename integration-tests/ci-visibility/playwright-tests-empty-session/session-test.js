'use strict'

const { test: it } = require('@playwright/test')
const { beforeEach, describe } = it

const mode = process.env.EMPTY_SESSION_MODE

if (mode !== 'empty') {
  describe('empty session', () => {
    // Playwright 1.18 supports suite-level test.skip(), but not describe.skip().
    if (mode === 'skip-suite') it.skip()
    beforeEach(() => {
      if (mode === 'error') throw new Error('empty session hook failure')
    })
    it.skip('skipped test', () => { throw new Error('skipped test ran') })
    if (mode !== 'skip-tests') it('runnable test', () => {})
  })
}
