'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { addBeforeExitFinalizer, runBeforeExitHandlers } = require('../src/before-exit')
const log = require('../src/log')

/** @type {Array<() => void>} */
const added = []

/** @param {() => void} fn */
function finalizer (fn) {
  added.push(fn)
  addBeforeExitFinalizer(fn)
  return fn
}

describe('before-exit finalization', () => {
  afterEach(() => {
    for (const handler of added) globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(handler)
    added.length = 0
    sinon.restore()
  })
  it('runs late span producers before ordinary writer handlers without reordering the writers', () => {
    const order = []
    const first = () => order.push('first writer')
    const last = () => order.push('last writer')
    const producer = finalizer(() => order.push('producer'))
    runBeforeExitHandlers(new Set([first, producer, last]))
    assert.deepEqual(order, ['producer', 'first writer', 'last writer'])
  })
  it('preserves producer registration order and runs each handler once', () => {
    const order = []
    const first = finalizer(() => order.push('first producer'))
    const last = finalizer(() => order.push('last producer'))
    runBeforeExitHandlers(new Set([first, () => order.push('writer'), last]))
    assert.deepEqual(order, ['first producer', 'last producer', 'writer'])
  })
  it('logs a producer failure and still drains the ordinary writers', () => {
    const error = sinon.stub(log, 'error')
    const writer = sinon.spy()
    const producer = finalizer(() => { throw new Error('finalizer failed') })
    runBeforeExitHandlers(new Set([writer, producer]))
    assert.equal(writer.callCount, 1)
    assert.equal(error.firstCall.args[1], 'finalizer failed')
  })
})
