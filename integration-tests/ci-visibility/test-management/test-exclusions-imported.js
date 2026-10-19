'use strict'

const { test } = require('@jest/globals')
const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

const selected = test.only.each([1, 2])
selected('selected %s', preventFailureSuppression(noAutoRetry((value, done) => done(new Error(`failure ${value}`)))))
const skipped = test.skip.each([1, 2])
skipped('skipped %s', preventFailureSuppression(() => { throw new Error('must remain skipped') }))
const doneCases = test.only.each([1, 2])
doneCases('ordinary done %s', (value, done) => done())
