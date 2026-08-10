'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../setup/core')

const FlagEvaluationsWriter = require('../../../src/openfeature/writers/flag_evaluations')

const { hashTargetingKey } = FlagEvaluationsWriter

// SHA-256 of the empty string — pinned so a future refactor cannot silently
// change the hashing algorithm.
const SHA256_EMPTY = 'sha256_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

// The canonical cross-SDK vector. Every SDK — Java, Go, Python, Ruby, PHP,
// .NET, JS — MUST produce this exact digest for this exact input. Any drift
// (trim, case fold, Unicode normalization, salt) silently breaks the
// per-(flag, allocation) unique-subject count join in the backend.
const CANONICAL_INPUT = 'jane.doe@datadoghq.com'
const CANONICAL_HASH = 'sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b'

describe('FlagEvaluationsWriter.hashTargetingKey', () => {
  it('matches the cross-SDK canonical vector', () => {
    assert.strictEqual(hashTargetingKey(CANONICAL_INPUT), CANONICAL_HASH)
  })

  it('produces a 71-char output for any input', () => {
    assert.strictEqual(hashTargetingKey('').length, 71)
    assert.strictEqual(hashTargetingKey(CANONICAL_INPUT).length, 71)
    assert.strictEqual(hashTargetingKey('a'.repeat(4096)).length, 71)
  })

  it('hashes the empty string to the SHA-256 empty digest', () => {
    assert.strictEqual(hashTargetingKey(''), SHA256_EMPTY)
  })

  it('does not trim whitespace', () => {
    assert.notStrictEqual(hashTargetingKey(' jane '), hashTargetingKey('jane'))
    assert.notStrictEqual(hashTargetingKey('jane\n'), hashTargetingKey('jane'))
  })

  it('does not case-fold', () => {
    assert.notStrictEqual(hashTargetingKey('Jane'), hashTargetingKey('jane'))
    assert.notStrictEqual(hashTargetingKey('JANE'), hashTargetingKey('jane'))
  })

  it('does not Unicode-normalize', () => {
    // U+00E9 (single code point) vs U+0065 U+0301 (composed pair). Both render
    // as "é" but are byte-distinct; a normalizing hash would collapse them.
    const nfc = 'é'
    const nfd = 'é'
    assert.notStrictEqual(hashTargetingKey(nfc), hashTargetingKey(nfd))
  })

  it('is stable across repeated calls with the same input', () => {
    assert.strictEqual(hashTargetingKey(CANONICAL_INPUT), hashTargetingKey(CANONICAL_INPUT))
  })
})
