'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')

const exec = promisify(execFile)
const fixture = join(__dirname, 'writers/fixtures/released-provider.js')
const now = 1_790_150_400_000
const target = 'released-target-canary'
const digest = 'sha256_' + createHash('sha256').update(target).digest('hex')

async function run (options) {
  const { stdout, stderr } = await exec(process.execPath, [fixture, JSON.stringify(options)], { timeout: 10000 })
  if (options.path === 'exception' || options.path === 'swap-error') {
    assert.match(stderr, /Error evaluating flag/)
    assert.match(stderr, /released-error-canary/)
  } else {
    assert.strictEqual(stderr, '')
  }
  const result = JSON.parse(stdout)
  assert.strictEqual(result.requests.length, 1)
  assert.strictEqual(result.requests[0].url, '/evp_proxy/v2/api/v2/flagevaluation')
  result.raw = result.requests[0].raw
  result.rows = JSON.parse(result.raw).flagEvaluations
  assert.strictEqual(result.raw.includes('mutated-'), false)
  assert.strictEqual(result.raw.includes('released-error-canary'), false)
  return result
}

function assertPrivacy (result, full, missingTarget = false) {
  assert.strictEqual(result.rows.length, 1)
  const [row] = result.rows
  assert.strictEqual(row.evaluation_count, 1)
  assert.strictEqual(row.first_evaluation, now)
  assert.strictEqual(row.last_evaluation, now)
  assert.strictEqual(row.targeting_key, missingTarget ? undefined : full ? target : digest)
  assert.deepStrictEqual(row.context, full ? { evaluation: { 'nested.secret': 'released-context-canary' } } : undefined)
  if (!full) {
    assert.strictEqual(result.raw.includes(target), false)
    assert.strictEqual(result.raw.includes('released-context-canary'), false)
  }
}

describe('released provider EVP wire contract', function () {
  this.timeout(15000)

  for (const consent of [undefined, false, true, 'true', 1, null, { observeFullEvaluationData: true }]) {
    it(`uses strict root consent from the real evaluator (${JSON.stringify(consent)})`, async () => {
      const result = await run({ consent })
      assert.strictEqual(result.details[0].value, true)
      assert.strictEqual(result.details[0].variant, 'on')
      assert.strictEqual(result.details[0].flagMetadata.__dd_observe_full_evaluation_data, consent === true)
      assertPrivacy(result, consent === true)
    })
  }

  it('ignores consent placed on a flag or environment instead of the configuration root', async () => {
    assertPrivacy(await run({ nestedConsent: true }), false)
  })

  for (const consent of [false, true]) {
    for (const path of ['swap', 'swap-error']) {
      it(`keeps evaluation-time consent and timestamp across ${consent} -> ${!consent} (${path})`, async () => {
        const result = await run({ consent, swap: true, path })
        assert.strictEqual(result.swapped, true)
        assert.strictEqual(result.consentReads, 1)
        assert.strictEqual(result.details[0].value, path !== 'swap-error')
        assert.strictEqual(result.details[0].errorCode, path === 'swap-error' ? 'GENERAL' : undefined)
        assert.strictEqual(result.details[0].flagMetadata.__dd_eval_timestamp_ms, now)
        assertPrivacy(result, consent)
      })
    }
    for (const [path, reason, errorCode] of [
      ['disabled', 'DISABLED', undefined],
      ['missing', 'ERROR', 'FLAG_NOT_FOUND'],
      ['no-allocation', 'DEFAULT', undefined],
      ['mismatch', 'ERROR', 'TYPE_MISMATCH'],
      ['malformed', 'ERROR', 'PARSE_ERROR'],
      ['target-missing', 'ERROR', 'TARGETING_KEY_MISSING'],
      ['exception', 'ERROR', 'GENERAL'],
    ]) {
      it(`retains counts/defaults and privacy on ${path}, consent=${consent}`, async () => {
        const result = await run({ consent, path })
        const [details] = result.details
        assert.strictEqual(details.value, false)
        assert.strictEqual(details.reason, reason)
        assert.strictEqual(details.errorCode, errorCode)
        assert.strictEqual(details.flagMetadata.__dd_observe_full_evaluation_data, consent)
        assert.strictEqual(details.flagMetadata.__dd_eval_timestamp_ms, now)
        assertPrivacy(result, consent, path === 'target-missing')
        assert.strictEqual(result.rows[0].runtime_default_used, true)
        assert.deepStrictEqual(result.rows[0].error, errorCode ? { message: errorCode } : undefined)
      })
    }
  }

  for (const [path, code] of [
    ['no-config', 'PROVIDER_NOT_READY'], ['not-ready', 'PROVIDER_NOT_READY'], ['fatal', 'PROVIDER_FATAL'],
  ]) {
    it(`fails closed on the real ${path} path`, async () => {
      const result = await run({ consent: true, path })
      assert.strictEqual(result.details[0].value, false)
      assert.strictEqual(result.details[0].errorCode, code)
      assert.strictEqual(result.rows[0].runtime_default_used, true)
      assert.deepStrictEqual(result.rows[0].error, { message: code })
      assertPrivacy(result, false)
    })
  }

  for (const doLog of [false, true]) {
    it(`keeps mixed-consent buckets separate before one flush, independently of DoLog=${doLog}`, async () => {
      const result = await run({ mixed: true, doLog })
      assert.ok(result.details.every(details => details.value === true && details.variant === 'on'))
      assert.strictEqual(result.rows.length, 2)
      const [protectedRow, fullRow] = result.rows
      assert.deepStrictEqual(result.rows.map(row => row.evaluation_count), [2, 2])
      assert.deepStrictEqual(result.rows.map(row => [row.first_evaluation, row.last_evaluation]), [
        [now, now + 200], [now + 100, now + 300],
      ])
      assert.strictEqual(protectedRow.targeting_key, digest)
      assert.strictEqual(protectedRow.context, undefined)
      assert.strictEqual(fullRow.targeting_key, target)
      assert.deepStrictEqual(fullRow.context, { evaluation: { 'nested.secret': 'released-context-canary' } })
    })
  }
})
