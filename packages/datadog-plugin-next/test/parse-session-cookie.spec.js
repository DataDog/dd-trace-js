'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { parseRumSessionId } = require('../src/utils/parse-session-cookie')

describe('parseRumSessionId', () => {
  it('should extract id from a Cookie header containing only _dd_s', () => {
    assert.equal(parseRumSessionId('_dd_s=id=abc123&created=1234&rum=1'), 'abc123')
  })

  it('should extract id regardless of position within the _dd_s value', () => {
    assert.equal(parseRumSessionId('_dd_s=created=1234&id=xyz789&rum=1'), 'xyz789')
  })

  it('should extract id when _dd_s value has only the id entry', () => {
    assert.equal(parseRumSessionId('_dd_s=id=only-this'), 'only-this')
  })

  it('should extract id when _dd_s is not the first cookie in the header', () => {
    assert.equal(parseRumSessionId('foo=bar; _dd_s=id=mid-cookie&rum=1; baz=qux'), 'mid-cookie')
  })

  it('should accept array-valued cookie headers', () => {
    assert.equal(parseRumSessionId(['_dd_s=id=from-array&rum=1']), 'from-array')
    assert.equal(parseRumSessionId(['other=val', '_dd_s=id=second-entry']), 'second-entry')
  })

  it('should return undefined for empty / nullish input', () => {
    assert.equal(parseRumSessionId(''), undefined)
    assert.equal(parseRumSessionId(undefined), undefined)
  })

  it('should return undefined when no _dd_s cookie is present', () => {
    assert.equal(parseRumSessionId('foo=bar; baz=qux'), undefined)
  })

  it('should return undefined when _dd_s exists but has no id entry', () => {
    assert.equal(parseRumSessionId('_dd_s=created=1234&rum=1'), undefined)
  })

  it('should not match a non-_dd_s cookie whose name ends with _dd_s', () => {
    assert.equal(parseRumSessionId('not_dd_s=id=should-not-match'), undefined)
  })
})
