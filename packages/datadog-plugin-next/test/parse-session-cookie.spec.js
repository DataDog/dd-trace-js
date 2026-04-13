'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { parseRumSessionId } = require('../src/utils/parse-session-cookie')

describe('parseRumSessionId', () => {
  it('should extract session id from a valid cookie value', () => {
    assert.equal(parseRumSessionId('id=abc123&created=1234&rum=1'), 'abc123')
  })

  it('should return the id regardless of position', () => {
    assert.equal(parseRumSessionId('created=1234&id=xyz789&rum=1'), 'xyz789')
  })

  it('should return undefined for empty string', () => {
    assert.equal(parseRumSessionId(''), undefined)
  })

  it('should return undefined for undefined input', () => {
    assert.equal(parseRumSessionId(undefined), undefined)
  })

  it('should return undefined when no id entry exists', () => {
    assert.equal(parseRumSessionId('created=1234&rum=1'), undefined)
  })

  it('should return undefined for malformed entries', () => {
    assert.equal(parseRumSessionId('===&bad'), undefined)
  })

  it('should handle cookie value with only the id entry', () => {
    assert.equal(parseRumSessionId('id=only-this'), 'only-this')
  })
})
