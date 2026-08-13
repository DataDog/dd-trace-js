'use strict'

require('../setup/core')

const assert = require('node:assert/strict')

const { EventWriter, NoopEventWriter } = require('../../src/native-spans/event-writer')

/**
 * @param {Function} target
 * @returns {string[]}
 */
function methodNames (target) {
  return Object.getOwnPropertyNames(target.prototype)
    .filter(name => name !== 'constructor')
    .sort()
}

describe('native-spans event writer', () => {
  describe('DD_NATIVE_SPANS_WRITE=0', () => {
    // `NoopEventWriter` disables writing by overriding every write method rather than
    // branching inside them, which keeps the flag off the hot path when it is on. The
    // failure mode is silent: a method added to `EventWriter` without an override here
    // keeps writing, and the flag under-reports the cost it is supposed to isolate. That
    // is not hypothetical — it happened when the web-server events were added.
    it('overrides every method of the real writer', () => {
      assert.deepStrictEqual(methodNames(NoopEventWriter), methodNames(EventWriter))
    })

    it('accepts every write without touching the buffers', () => {
      const writer = new NoopEventWriter()
      const context = {
        _traceId: { hi: 1, lo: 2, upperHi: 0, upperLo: 0 },
        _segmentId: { hi: 1, lo: 2 },
        _spanId: { hi: 1, lo: 2 },
        _parentId: { hi: 0, lo: 0 },
      }

      // Every entry point, generic and specialized. None may throw, and `flush` must have
      // nothing to hand over — which is what makes the whole Rust pipeline go quiet too.
      writer.segmentStart(context)
      writer.spanStart(context, 0, 1)
      writer.setTagString(context, 'key', 'value')
      writer.setTagNumber(context, 'key', 1)
      writer.addLink(context, context._spanId, '')
      writer.addEvent(context, 'name', 0, '')
      writer.spanError(context, 'message', 'Error', 'stack')
      writer.webRequestStart(context, 0, 1, 'GET', 'http://localhost/')
      writer.webRequestFinish(context, 0, 1, 1, 200, '/', 0)
      writer.finish(context, 0, 1, 1)
      writer.flush()
    })
  })
})
