'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

const { ErrorCode } = require('@openfeature/server-sdk')
const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { FlagEvaluationAggregator } = require('../../../src/openfeature/writers/flag-evaluation-aggregation')
const { iterateFlagEvaluationPayloads } = require('../../../src/openfeature/writers/flag-evaluation-payload')

const target = 'independent-target-canary'
const digest = 'sha256_' + createHash('sha256').update(target).digest('hex')
const attrs = Object.freeze({ secret: 'independent-context-canary' })
const codes = [ErrorCode.FLAG_NOT_FOUND, 'unapproved-error-canary', { message: 'error-object-canary' }, undefined]

describe('flag evaluation independent privacy boundaries', () => {
  it('merges equivalent contexts while retaining an immutable snapshot of each distinct identity', () => {
    const aggregator = new FlagEvaluationAggregator()
    const first = { b: false, a: 1 }
    const second = { a: 1, b: false }
    const event = {
      flagKey: 'flag', targetingKey: target, observeFullEvaluationData: true, runtimeDefault: false, timestamp: 100,
    }
    aggregator.add({ ...event, attrs: first })
    aggregator.add({ ...event, attrs: second, timestamp: 50 })
    first.a = 2
    second.b = true
    aggregator.add({ ...event, attrs: first, timestamp: 200 })
    first.a = 3
    const { full, degraded } = aggregator.take()
    assert.strictEqual(full.size, 2)
    for (const entry of full.values()) {
      assert.strictEqual(Object.isFrozen(entry.attrs), true)
      assert.strictEqual(Object.getPrototypeOf(entry.attrs), null)
    }
    const [payload] = [...iterateFlagEvaluationPayloads(full, degraded, { service: 'test' }, 300)]
    assert.deepStrictEqual(JSON.parse(payload.encoded).flagEvaluations.map(row => ({
      context: row.context.evaluation,
      count: row.evaluation_count,
      first: row.first_evaluation,
      last: row.last_evaluation,
    })), [
      { context: { a: 1, b: false }, count: 2, first: 50, last: 100 },
      { context: { a: 2, b: false }, count: 1, first: 200, last: 200 },
    ])
  })

  it('groups absent and rejected contexts together without colliding with scalar identities', () => {
    const aggregator = new FlagEvaluationAggregator()
    const event = {
      flagKey: 'flag', targetingKey: target, observeFullEvaluationData: true, runtimeDefault: false, timestamp: 100,
    }
    /** @type {Array<import('../../../src/openfeature/writers/flag-evaluation-context').ContextSnapshot | undefined>} */
    const contexts = [
      undefined, {}, { rejected: '\uD800' }, { x: 0 }, { x: -0 }, { x: '0' }, { x: false }, { x: null },
      { x: 'null' }, { 'x\0y': 'z' }, { x: 'y\0z' }, { x: 'a:b' }, { 'x:a': 'b' }, { x: '' },
    ]
    for (const context of contexts) aggregator.add({ ...event, attrs: context })
    const { full, degraded } = aggregator.take()
    const [payload] = [...iterateFlagEvaluationPayloads(full, degraded, { service: 'test' }, 300)]
    const rows = JSON.parse(payload.encoded).flagEvaluations
    assert.deepStrictEqual(rows.map(row => [row.context?.evaluation, row.evaluation_count]), [
      [undefined, 3], [{ x: 0 }, 2], [{ x: '0' }, 1], [{ x: false }, 1], [{ x: null }, 1],
      [{ x: 'null' }, 1], [{ 'x\0y': 'z' }, 1], [{ x: 'y\0z' }, 1], [{ x: 'a:b' }, 1], [{ 'x:a': 'b' }, 1],
      [{ x: '' }, 1],
    ])
  })

  for (const consent of [undefined, false, 1, 'true', true]) {
    it(`aggregation independently validates consent ${JSON.stringify(consent)} before retaining context`, () => {
      const aggregator = new FlagEvaluationAggregator()
      // Intentionally bypass the hook and enqueue guards at the real internal boundary.
      aggregator.add({
        flagKey: 'flag',
        targetingKey: target,
        attrs,
        observeFullEvaluationData: consent,
        errorCode: 'unapproved-error-canary',
        runtimeDefault: true,
        timestamp: 100,
      })
      const { full } = aggregator.take()
      const [identity, entry] = [...full][0]
      assert.strictEqual(entry.consent, consent === true)
      if (consent === true) {
        assert.deepStrictEqual({ ...entry.attrs }, attrs)
        assert.ok(Object.isFrozen(entry.attrs))
      } else {
        assert.strictEqual(entry.attrs, undefined)
      }
      assert.strictEqual(entry.error, 'GENERAL')
      assert.strictEqual(entry.runtimeDefault, true)
      assert.strictEqual(entry.count, 1)
      assert.strictEqual(identity.includes(target), true)
      if (consent !== true) {
        assert.strictEqual(identity.includes('independent-context-canary'), false)
      }
    })
  }

  it('hashes repeated protected observations only at output and never trusts digest-shaped raw keys', () => {
    const pii = require('../../../src/openfeature/writers/flag-evaluation-pii')
    const hash = sinon.spy(pii.prefixedTargetingKeyDigest)
    const overrides = { './flag-evaluation-pii': { ...pii, prefixedTargetingKeyDigest: hash } }
    const { FlagEvaluationAggregator } = proxyquire('../../../src/openfeature/writers/flag-evaluation-aggregation',
      overrides)
    const { iterateFlagEvaluationPayloads } = proxyquire('../../../src/openfeature/writers/flag-evaluation-payload',
      overrides)
    const aggregator = new FlagEvaluationAggregator()
    const lookalike = 'sha256_' + 'a'.repeat(64)
    for (let i = 0; i < 10; i++) {
      aggregator.add({ flagKey: 'flag', targetingKey: target, timestamp: 100, observeFullEvaluationData: false })
    }
    aggregator.add({ flagKey: 'flag', targetingKey: lookalike, timestamp: 100, observeFullEvaluationData: false })
    assert.strictEqual(hash.callCount, 0)
    const { full, degraded } = aggregator.take()
    const [payload] = [...iterateFlagEvaluationPayloads(full, degraded, { service: 'test' }, 300)]
    const rows = JSON.parse(payload.encoded).flagEvaluations
    assert.deepStrictEqual(rows.map(row => row.evaluation_count), [10, 1])
    assert.strictEqual(rows[0].targeting_key, digest)
    assert.strictEqual(rows[1].targeting_key, 'sha256_' + createHash('sha256').update(lookalike).digest('hex'))
    assert.strictEqual(payload.encoded.includes(target), false)
    assert.strictEqual(payload.encoded.includes(lookalike), false)
    assert.strictEqual(hash.callCount, 2)
  })

  for (const degraded of [false, true]) {
    for (const consent of [false, true]) {
      for (const [index, code] of codes.entries()) {
        it(`serializer alone protects tier=${degraded ? 'degraded' : 'full'} consent=${consent} error=${index}`, () => {
          // These entries bypass both capture and aggregation, including their error guards.
          const entry = {
            flagKey: 'flag',
            rawTargetingKey: target,
            attrs,
            consent,
            error: code,
            errorMessage: 'error-message-only-canary',
            runtimeDefault: true,
            count: 7,
            first: 100,
            last: 200,
          }
          const entries = new Map([['untrusted-boundary-input', entry]])
          const [payload] = [...iterateFlagEvaluationPayloads(
            degraded ? new Map() : entries, degraded ? entries : new Map(), { service: 'test' }, 300
          )]
          const bytes = Buffer.from(payload.encoded)
          const [row] = JSON.parse(bytes).flagEvaluations
          assert.strictEqual(row.evaluation_count, 7)
          assert.strictEqual(row.runtime_default_used, true)
          assert.strictEqual(row.first_evaluation, 100)
          assert.strictEqual(row.last_evaluation, 200)
          const expectedCode = code === undefined
            ? undefined
            : Object.values(ErrorCode).includes(code) ? code : 'GENERAL'
          assert.deepStrictEqual(row.error, expectedCode === undefined ? undefined : { message: expectedCode })
          assert.strictEqual(row.targeting_key, degraded ? undefined : consent ? target : digest)
          assert.deepStrictEqual(row.context, !degraded && consent ? { evaluation: attrs } : undefined)
          for (const canary of ['unapproved-error-canary', 'error-object-canary', 'error-message-only-canary']) {
            assert.strictEqual(bytes.includes(Buffer.from(canary)), false)
          }
          if (degraded || !consent) {
            assert.strictEqual(bytes.includes(Buffer.from(target)), false)
            assert.strictEqual(bytes.includes(Buffer.from('independent-context-canary')), false)
          }
        })
      }
    }
  }
})
