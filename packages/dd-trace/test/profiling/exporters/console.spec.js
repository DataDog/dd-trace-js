'use strict'

const sinon = require('sinon')
const { inspect } = require('util')

describe('exporters/console', () => {
  let ConsoleExporter
  let log

  beforeEach(() => {
    log = sinon.stub(console, 'log')

    ConsoleExporter = require('../../../src/profiling/exporters/console').ConsoleExporter
  })

  afterEach(() => {
    log.restore()
  })

  it('should export to console as object', async () => {
    const exporter = new ConsoleExporter()
    const profiles = {}

    await exporter.export({ profiles })

    sinon.assert.calledWith(log, inspect(profiles, false, Infinity, true))
  })

  it('should export to console as JSON', async () => {
    const exporter = new ConsoleExporter({ json: true })
    const profiles = {}

    await exporter.export({ profiles })

    sinon.assert.calledWith(log, JSON.stringify(profiles, null, 2))
  })
})
