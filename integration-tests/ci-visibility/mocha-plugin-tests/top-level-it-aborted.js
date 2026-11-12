'use strict'

const sum = require('../test/sum')

const hook = process.env.MOCHA_FAILING_HOOK === 'afterEach' ? afterEach : beforeEach

hook(() => {
  sum(1, 2)
  throw new Error('intentional hook failure')
})

it('first top-level test', () => {})
it('second top-level test', () => {})
