'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha

require('../setup/tap')

describe('config/disabled_instrumentations', () => {
  it('should disable loading instrumentations completely', () => {
    process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'express'
    const handleBefore = require('express').application.handle
    const tracer = require('../../../..')
    const handleAfterImport = require('express').application.handle
    tracer.init()
    const handleAfterInit = require('express').application.handle

    expect(handleBefore).to.equal(handleAfterImport)
    expect(handleBefore).to.equal(handleAfterInit)
    delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
  })

  it('should disable loading instrumentations using DD_TRACE_<INTEGRATION>_ENABLED', () => {
    process.env.DD_TRACE_EXPRESS_ENABLED = 'false'
    const handleBefore = require('express').application.handle
    const tracer = require('../../../..')
    const handleAfterImport = require('express').application.handle
    tracer.init()
    const handleAfterInit = require('express').application.handle

    expect(handleBefore).to.equal(handleAfterImport)
    expect(handleBefore).to.equal(handleAfterInit)
    delete process.env.DD_TRACE_EXPRESS_ENABLED
  })
})
