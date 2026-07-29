'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const retryMarker = path.join(__dirname, '.webdriverio-spec-file-retry')

describe('WebdriverIO spec file retries', () => {
  it('reports the retried worker', () => {
    const activeSpan = tracer.scope().active()

    assert.ok(activeSpan)
    activeSpan.setTag('test.webdriverio.worker', 'spec-file-retry')

    if (!fs.existsSync(retryMarker)) {
      fs.writeFileSync(retryMarker, '')
      assert.fail('fail the first spec file execution')
    }

    fs.unlinkSync(retryMarker)
  })
})
