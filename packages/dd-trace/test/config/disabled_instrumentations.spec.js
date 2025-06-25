'use strict'

const t = require('tap')
require('../setup/core')

t.test('config/disabled_instrumentations', t => {
  t.test('should disable loading instrumentations completely', t => {
    process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'express'
    const handleBefore = require('express').application.handle
    const tracer = require('../../../..')
    const handleAfterImport = require('express').application.handle
    tracer.init()
    const handleAfterInit = require('express').application.handle

    expect(handleBefore).to.equal(handleAfterImport)
    expect(handleBefore).to.equal(handleAfterInit)
    delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
    t.end()
  })

  t.test('should disable loading instrumentations using DD_TRACE_<INTEGRATION>_ENABLED', t => {
    process.env.DD_TRACE_EXPRESS_ENABLED = 'false'
    const handleBefore = require('express').application.handle
    const tracer = require('../../../..')
    const handleAfterImport = require('express').application.handle
    tracer.init()
    const handleAfterInit = require('express').application.handle

    expect(handleBefore).to.equal(handleAfterImport)
    expect(handleBefore).to.equal(handleAfterInit)
    delete process.env.DD_TRACE_EXPRESS_ENABLED
    t.end()
  })
  t.end()
})
