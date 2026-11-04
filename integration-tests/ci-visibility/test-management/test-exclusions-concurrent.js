'use strict'

const { test } = require('@jest/globals')
const { preventFailureSuppression, noAutoRetry } = require('dd-trace/ci/test-annotations')

const fail = preventFailureSuppression(noAutoRetry(async () => { throw new Error('concurrent failure') }))
test.concurrent('protected concurrent', fail)
const eachConcurrentCase = test.concurrent.each([1, 2])
eachConcurrentCase('protected concurrent case %s', fail)
