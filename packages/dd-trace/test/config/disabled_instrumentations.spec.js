'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')

describe('config/disabled_instrumentations', () => {
  it('should disable loading instrumentations completely', () => {
    process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'express'
    const handleBefore = require('express').application.handle
    const tracer = require('../../../..')
    const handleAfterImport = require('express').application.handle
    tracer.init()
    const handleAfterInit = require('express').application.handle

    assert.strictEqual(handleBefore, handleAfterImport)
    assert.strictEqual(handleBefore, handleAfterInit)
    delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
  })

  it('should disable loading instrumentations using DD_TRACE_<INTEGRATION>_ENABLED', () => {
    process.env.DD_TRACE_EXPRESS_ENABLED = 'false'
    const handleBefore = require('express').application.handle
    const tracer = require('../../../..')
    const handleAfterImport = require('express').application.handle
    tracer.init()
    const handleAfterInit = require('express').application.handle

    assert.strictEqual(handleBefore, handleAfterImport)
    assert.strictEqual(handleBefore, handleAfterInit)
    delete process.env.DD_TRACE_EXPRESS_ENABLED
  })
})
