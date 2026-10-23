'use strict'

const { noAutoRetry } = require('dd-trace/test-optimization')
const callback = () => { expect(42).toBe(42) }
test('passing environment test', process.env.EXCLUSIONS_ANNOTATED_ENVIRONMENT === '1'
  ? noAutoRetry(callback)
  : callback)
