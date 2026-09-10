'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')

const agent = require('../plugins/agent')

const retainedSpan = Symbol.for('dd-trace.test.retained-span')

describe('span leak detector process fixture', () => {
  const finishCh = channel('dd-trace:span:finish')
  let execFileSync
  let finishedSpan

  /** @param {import('../../src/opentracing/span')} span */
  function observeFinishedSpan (span) {
    if (span._integrationName === 'child_process') {
      finishedSpan = span
    }
  }

  before(async () => {
    finishCh.subscribe(observeFinishedSpan)
    await agent.load('child_process')
    const childProcess = require('node:child_process')
    execFileSync = childProcess.execFileSync
  })

  after(async () => {
    finishCh.unsubscribe(observeFinishedSpan)
    await agent.close()
  })

  it('finishes a span', () => {
    execFileSync(process.execPath, ['-e', ''])

    assert.strictEqual(finishedSpan._integrationName, 'child_process')
    if (process.env.DD_TEST_RETAIN_FINISHED_SPAN === '1') {
      globalThis[retainedSpan] = finishedSpan
    }
  })
})
