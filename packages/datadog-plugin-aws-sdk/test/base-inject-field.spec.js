'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { injectFieldIntoJsonObject } = require('../src/base')

describe('BaseAwsSdkPlugin.injectFieldIntoJsonObject', () => {
  describe('fast path', () => {
    it('returns a single-key object when the payload is "{}"', () => {
      assert.strictEqual(
        injectFieldIntoJsonObject('{}', '_datadog', { trace: 'abc' }),
        '{"_datadog":{"trace":"abc"}}'
      )
    })

    it('splices the new field in before the trailing brace when nothing precedes "}"', () => {
      assert.strictEqual(
        injectFieldIntoJsonObject('{"a":1}', '_datadog', { trace: 'abc' }),
        '{"a":1,"_datadog":{"trace":"abc"}}'
      )
    })
  })

  describe('slow path (JSON.parse + assign + JSON.stringify)', () => {
    for (const [label, payload] of [
      ['space', '{"a":1 }'],
      ['tab', '{"a":1\t}'],
      ['newline', '{"a":1\n}'],
      ['carriage return', '{"a":1\r}'],
    ]) {
      it(`falls back when whitespace (${label}) precedes the closing brace`, () => {
        assert.strictEqual(
          injectFieldIntoJsonObject(payload, '_datadog', { trace: 'abc' }),
          '{"a":1,"_datadog":{"trace":"abc"}}'
        )
      })
    }

    it('replaces an existing top-level key with the new value rather than merging', () => {
      assert.strictEqual(
        injectFieldIntoJsonObject('{"_datadog":{"old":true,"keep":1},"a":1}', '_datadog', { trace: 'abc' }),
        '{"_datadog":{"trace":"abc"},"a":1}'
      )
    })

    it('falls back when the key string occurs only under a nested object and adds the field at top level', () => {
      assert.strictEqual(
        injectFieldIntoJsonObject('{"a":{"_datadog":"nested"}}', '_datadog', { trace: 'abc' }),
        '{"a":{"_datadog":"nested"},"_datadog":{"trace":"abc"}}'
      )
    })
  })

  describe('non-object JSON payloads', () => {
    it('throws on a JSON number because assigning a string key to a primitive fails in strict mode', () => {
      assert.throws(
        () => injectFieldIntoJsonObject('42', '_datadog', { trace: 'abc' }),
        /Cannot create property '_datadog' on number '42'/
      )
    })

    it('throws on a JSON string for the same reason', () => {
      assert.throws(
        () => injectFieldIntoJsonObject('"foo"', '_datadog', { trace: 'abc' }),
        /Cannot create property '_datadog' on string 'foo'/
      )
    })

    it('throws on JSON null because string-key assignment on null is a TypeError', () => {
      assert.throws(
        () => injectFieldIntoJsonObject('null', '_datadog', { trace: 'abc' }),
        /Cannot set properties of null/
      )
    })

    it('returns a JSON array unchanged because JSON.stringify omits non-index properties', () => {
      // The slow path runs `arr["_datadog"] = value` on the parsed array; the assignment succeeds
      // but JSON.stringify skips non-numeric keys, so the array round-trips byte-for-byte.
      assert.strictEqual(
        injectFieldIntoJsonObject('[1,2,3]', '_datadog', { trace: 'abc' }),
        '[1,2,3]'
      )
    })
  })
})
