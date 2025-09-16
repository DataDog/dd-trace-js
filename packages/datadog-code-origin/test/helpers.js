'use strict'

const assert = require('node:assert')

const { assertObjectContains } = require('../../../integration-tests/helpers')

module.exports = {
  assertCodeOriginFromTraces (traces, frame) {
    const spans = traces[0]
    const tags = spans[0].meta

    assertObjectContains(tags, {
      '_dd.code_origin.type': 'entry',
      '_dd.code_origin.frames.0.file': frame.file,
      '_dd.code_origin.frames.0.line': String(frame.line),
      '_dd.code_origin.frames.0.column': frame.column,
    })

    assert.match(tags['_dd.code_origin.frames.0.column'], /^\d+$/)
    if (frame.method) {
      assert.strictEqual(tags['_dd.code_origin.frames.0.method'], frame.method)
    } else {
      assert.ok(!Object.hasOwn(tags, '_dd.code_origin.frames.0.method'))
    }
    if (frame.type) {
      assert.strictEqual(tags['_dd.code_origin.frames.0.type'], frame.type)
    } else {
      assert.ok(!Object.hasOwn(tags, '_dd.code_origin.frames.0.type'))
    }

    // The second frame should not be present, because we only collect 1 frame for entry spans
    assert.ok(!Object.hasOwn(tags, '_dd.code_origin.frames.1.file'))
  }
}
