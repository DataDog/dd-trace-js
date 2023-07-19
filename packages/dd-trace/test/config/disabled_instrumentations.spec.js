'use strict'

process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'express'

require('../setup/tap')

describe('config/disabled_instrumentations', () => {
  it('should disable loading instrumentations completely', () => {
    const handleBefore = require('express').application.handle
    const tracer = require('../../../..')
    const handleAfterImport = require('express').application.handle
    tracer.init()
    const handleAfterInit = require('express').application.handle

    expect(handleBefore).to.equal(handleAfterImport)
    expect(handleBefore).to.equal(handleAfterInit)
  })
})
