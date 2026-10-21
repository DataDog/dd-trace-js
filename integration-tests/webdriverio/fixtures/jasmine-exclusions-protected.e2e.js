'use strict'

const assert = require('node:assert/strict')
const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')
let attempts = 0
const callback = () => process.env.WEBDRIVERIO_EXCLUSIONS_RECOVER === 'true'
  ? assert.strictEqual(++attempts, 2)
  : assert.strictEqual(process.env.WEBDRIVERIO_EXCLUSIONS_PASS, 'true')
const annotated = process.env.WEBDRIVERIO_EXCLUSIONS_APPLY !== 'false'
  ? preventFailureSuppression(process.env.WEBDRIVERIO_EXCLUSIONS_ALLOW_RETRIES === 'true'
    ? callback
    : noAutoRetry(callback))
  : callback

describe('WebdriverIO protected exclusion', () => {
  it('critical check', annotated)
})
