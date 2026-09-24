'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

const { ErrorCode } = require('@openfeature/server-sdk')
const { describe, it } = require('mocha')

const { FlagEvaluationAggregator } = require('../../../src/openfeature/writers/flag-evaluation-aggregation')
const { buildFlagEvaluationPayloads } = require('../../../src/openfeature/writers/flag-evaluation-payload')

const target = 'independent-target-canary'
const digest = 'sha256_' + createHash('sha256').update(target).digest('hex')
const attrs = Object.freeze({ secret: 'independent-context-canary' })
const codes = [ErrorCode.FLAG_NOT_FOUND, 'unapproved-error-canary', { message: 'error-object-canary' }, undefined]

describe('flag evaluation independent privacy boundaries', () => {
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
      assert.strictEqual(identity.includes(consent === true ? target : digest), true)
      if (consent !== true) {
        assert.strictEqual(identity.includes(target), false)
        assert.strictEqual(identity.includes('independent-context-canary'), false)
      }
    })
  }

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
          const [payload] = buildFlagEvaluationPayloads(
            degraded ? new Map() : entries, degraded ? entries : new Map(), { service: 'test' }, 300
          )
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
