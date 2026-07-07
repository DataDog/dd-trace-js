'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const exporters = require('../../../../../ext/exporters')
const Exporter = require('../../../src/exporters/deferred')

describe('DeferredApmExporter', () => {
  let exporter
  let nextExporter

  beforeEach(() => {
    nextExporter = {
      export: sinon.stub(),
      flush: sinon.stub().callsFake(done => done?.()),
    }
  })

  afterEach(() => {
    exporter?.destroy()
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.clear()
    sinon.restore()
  })

  it('buffers traces until a concrete exporter is selected', () => {
    const trace = [{ name: 'workflow' }]
    exporter = new Exporter({ url: new URL('http://127.0.0.1:8126/') }, {})

    assert.strictEqual(exporter.export(trace), true)
    sinon.assert.notCalled(nextExporter.export)

    assert.strictEqual(exporter.transferPendingTo(nextExporter, exporters.AGENT), true)
    sinon.assert.calledOnceWithExactly(nextExporter.export, trace)
  })

  it('normalizes buffered LLMObs meta_struct tag keys when draining to agentless', () => {
    const span = {
      meta_struct: {
        _llmobs: {
          tags: {
            'ddtrace.version': '7.0.0',
            language: 'javascript',
          },
        },
      },
    }
    exporter = new Exporter({ url: new URL('http://127.0.0.1:8126/') }, {})

    exporter.export([span])
    exporter.transferPendingTo(nextExporter, exporters.AGENTLESS)

    const drainedTrace = nextExporter.export.getCall(0).args[0]
    assert.deepStrictEqual(drainedTrace[0].meta_struct._llmobs.tags, {
      ddtrace_version: '7.0.0',
      language: 'javascript',
    })
  })

  it('flushes the selected exporter when flush was requested before route resolution', () => {
    const done = sinon.stub()
    const trace = [{ name: 'workflow' }]
    exporter = new Exporter({ url: new URL('http://127.0.0.1:8126/') }, {})

    exporter.export(trace)
    exporter.flush(done)
    exporter.transferPendingTo(nextExporter, exporters.AGENT)

    sinon.assert.calledOnceWithExactly(nextExporter.export, trace)
    sinon.assert.calledOnce(nextExporter.flush)
    sinon.assert.calledOnce(done)
  })
})
