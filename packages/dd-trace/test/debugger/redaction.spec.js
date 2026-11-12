'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/mocha')

const { createIsRedactedIdentifier } = require('../../src/debugger/redaction')

describe('createIsRedactedIdentifier', function () {
  const isRedactedIdentifier = createIsRedactedIdentifier({
    DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS: [],
    DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS: [],
  })

  it('should redact the default identifiers regardless of case and separators', function () {
    for (const name of ['password', 'PASSWORD', 'apiKey', 'api_key', 'API-KEY', '@token', '$secret', 'connect.sid']) {
      assert.strictEqual(isRedactedIdentifier(name), true, name)
    }
  })

  it('should not redact other identifiers', function () {
    for (const name of ['name', 'passwords', 'key', 'it']) {
      assert.strictEqual(isRedactedIdentifier(name), false, name)
    }
  })

  it('should strip the `Symbol(...)` wrapper of symbol descriptions', function () {
    assert.strictEqual(isRedactedIdentifier('Symbol(password)', true), true)
    assert.strictEqual(isRedactedIdentifier('Symbol(name)', true), false)
  })

  it('should honor the configured redacted and excluded identifiers', function () {
    const isRedactedIdentifier = createIsRedactedIdentifier({
      DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS: ['foo', 'Bar_Baz'],
      DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS: ['PASS-WORD', 'bar_baz'],
    })

    assert.strictEqual(isRedactedIdentifier('foo'), true)
    assert.strictEqual(isRedactedIdentifier('token'), true)
    assert.strictEqual(isRedactedIdentifier('password'), false)
    assert.strictEqual(isRedactedIdentifier('barBaz'), false)
  })
})
