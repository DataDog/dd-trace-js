'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

const { ErrorCode } = require('@openfeature/server-sdk')
const { describe, it } = require('mocha')

const {
  normalizeTargetingKey,
  prefixedTargetingKeyDigest,
  protectedErrorCode,
} = require('../../../src/openfeature/writers/flag-evaluation-pii')
const { hashTargetingKey: spanDigest } = require('../../../src/openfeature/encoding')

const APPROVED_CODES = [
  'PROVIDER_NOT_READY',
  'PROVIDER_FATAL',
  'FLAG_NOT_FOUND',
  'PARSE_ERROR',
  'TYPE_MISMATCH',
  'TARGETING_KEY_MISSING',
  'INVALID_CONTEXT',
  'GENERAL',
]

describe('flag evaluation privacy policy', () => {
  describe('targeting keys', () => {
    const vectors = [
      [
        'jane.doe@datadoghq.com',
        'sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b',
      ],
      [
        'vickie.fridge@datadoghq.com',
        'sha256_6f455051b0ca08ba29e72e718a6ceef7e02681a9ce3950d5be7bb09c110c327d',
      ],
    ]

    for (const [input, expected] of vectors) {
      it(`matches the shared vector for ${input}`, () => {
        assert.strictEqual(normalizeTargetingKey(input), input)
        assert.strictEqual(prefixedTargetingKeyDigest(input), expected)
        assert.strictEqual(spanDigest(input), expected.slice(7))
      })
    }

    const exactInputs = [
      'Alice', 'alice', ' alice ', '\u00e9', 'e\u0301', '\ud83d\ude00', '\ud800\udc00', '\udbff\udfff', '\0',
    ]
    for (const input of exactInputs) {
      it(`preserves the exact UTF-8 bytes of ${JSON.stringify(input)}`, () => {
        const expected = 'sha256_' + createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex')
        assert.strictEqual(normalizeTargetingKey(input), input)
        assert.strictEqual(prefixedTargetingKeyDigest(input), expected)
        assert.match(prefixedTargetingKeyDigest(input), /^sha256_[0-9a-f]{64}$/)
      })
    }

    it('does not normalize case, whitespace, Unicode, or an apparent hash prefix', () => {
      assert.notStrictEqual(prefixedTargetingKeyDigest('Alice'), prefixedTargetingKeyDigest('alice'))
      assert.notStrictEqual(prefixedTargetingKeyDigest(' alice '), prefixedTargetingKeyDigest('alice'))
      assert.notStrictEqual(prefixedTargetingKeyDigest('\u00e9'), prefixedTargetingKeyDigest('e\u0301'))
      const [input, expected] = vectors[0]
      assert.notStrictEqual(prefixedTargetingKeyDigest(expected), prefixedTargetingKeyDigest(input))
    })

    it('preserves empty targeting text without hashing it', () => {
      assert.strictEqual(normalizeTargetingKey(''), '')
      assert.strictEqual(prefixedTargetingKeyDigest(''), '')
    })

    const malformed = [
      '\ud800', '\udbff', '\udc00', '\udfff',
      'before\ud800', '\ud800after', 'before\udc00after',
      '\ud800\ud800', '\udc00\ud800', '\udc00\udc00',
      '\ud83d\ude00\ud800', '\ud800x\udc00',
    ]
    for (const input of malformed) {
      it(`omits malformed UTF-16 ${JSON.stringify(input)} without replacement`, () => {
        assert.strictEqual(normalizeTargetingKey(input), undefined)
        assert.strictEqual(prefixedTargetingKeyDigest(input), undefined)
      })
    }

    it('accepts an actual replacement character as valid input', () => {
      assert.strictEqual(normalizeTargetingKey('\ufffd'), '\ufffd')
      assert.strictEqual(prefixedTargetingKeyDigest('\ufffd'),
        'sha256_' + createHash('sha256').update(Buffer.from([0xef, 0xbf, 0xbd])).digest('hex'))
    })

    for (const input of [undefined, null, true, false, 0, 1, NaN, 1n, [], {}, Buffer.from('user'), Symbol('user')]) {
      it(`omits targeting input of type ${typeof input} without coercion`, () => {
        assert.strictEqual(normalizeTargetingKey(input), undefined)
        assert.strictEqual(prefixedTargetingKeyDigest(input), undefined)
      })
    }

    it('does not invoke hostile coercion hooks or proxy traps', () => {
      const hostile = new Proxy({}, {
        get () { assert.fail('must not access non-string input') },
        getPrototypeOf () { assert.fail('must not inspect non-string input') },
      })
      assert.strictEqual(normalizeTargetingKey(hostile), undefined)
      assert.strictEqual(prefixedTargetingKeyDigest(hostile), undefined)
      const revoked = Proxy.revocable({}, {})
      revoked.revoke()
      assert.strictEqual(prefixedTargetingKeyDigest(revoked.proxy), undefined)
    })
  })

  describe('error codes', () => {
    it('requires an explicit vocabulary review when OpenFeature adds or removes codes', () => {
      assert.deepStrictEqual(Object.values(ErrorCode).sort(), [...APPROVED_CODES].sort())
    })

    for (const code of APPROVED_CODES) {
      it(`preserves the approved ${code} code`, () => {
        assert.strictEqual(protectedErrorCode(code), code)
      })
    }

    for (const absent of [undefined, null, '']) {
      it(`omits an absent error code (${JSON.stringify(absent)})`, () => {
        assert.strictEqual(protectedErrorCode(absent), undefined)
      })
    }

    for (const input of [
      'customer-pii@example.test', 'general', ' GENERAL ', 'GENERAL\0canary',
      'toString', 'constructor', '__proto__', '\ud800', true, false, 0, 1, [], {}, Symbol('error'),
    ]) {
      it(`maps unknown or malformed ${typeof input} error codes to GENERAL`, () => {
        assert.strictEqual(protectedErrorCode(input), 'GENERAL')
      })
    }

    it('does not read or stringify an error object', () => {
      const hostile = new Proxy({}, {
        get () { assert.fail('must not read message, code, or coercion hooks') },
      })
      assert.strictEqual(protectedErrorCode(hostile), 'GENERAL')
    })
  })
})
