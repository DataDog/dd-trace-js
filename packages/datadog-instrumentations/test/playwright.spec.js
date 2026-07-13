'use strict'

const { EventEmitter } = require('node:events')

const { tracingChannel } = require('dc-polyfill')
const { before, beforeEach, describe, it } = require('mocha')

const dispatcherCreateWorkerCh = tracingChannel('orchestrion:playwright:Dispatcher_createWorker')

describe('playwright instrumentation', () => {
  let worker

  before(() => {
    require('../src/playwright')
  })

  beforeEach(() => {
    const dispatcher = {
      _ddAllTests: [],
      _testRun: { config: { config: { projects: [] } } },
    }
    worker = new EventEmitter()
    dispatcherCreateWorkerCh.end.publish({ self: dispatcher, result: worker })
  })

  it('ignores testBegin events for unknown test IDs', () => {
    worker.emit('testBegin', { testId: 'unknown' })
  })

  it('ignores testEnd events for unknown test IDs', () => {
    worker.emit('testEnd', { testId: 'unknown' })
  })
})
