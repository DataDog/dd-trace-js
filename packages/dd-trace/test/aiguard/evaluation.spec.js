'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  createEvaluationOutcome,
  parseEvaluationResponse,
  shouldBlockEvaluation,
} = require('../../src/aiguard/evaluation')

describe('AI Guard evaluation response', () => {
  it('parses the backend response into the internal evaluation contract', () => {
    const sdsFindings = [{ category: 'ssn' }]
    const redactionReplacements = [{ path: 'messages[0].content', replacement: '<REDACTED>' }]
    const tagProbabilities = { jailbreak: 0.8 }
    const response = {
      data: {
        attributes: {
          action: 'DENY',
          reason: 'Sensitive data detected.',
          tags: ['jailbreak'],
          sds_findings: sdsFindings,
          tag_probs: tagProbabilities,
          is_blocking_enabled: true,
          redaction_replacements: redactionReplacements,
        },
      },
    }

    assert.deepStrictEqual(parseEvaluationResponse(response), {
      action: 'DENY',
      reason: 'Sensitive data detected.',
      tags: ['jailbreak'],
      sdsFindings,
      tagProbabilities,
      hasTagProbabilities: true,
      blockingEnabled: true,
      redactionReplacements,
    })
  })

  it('uses safe defaults for optional backend fields', () => {
    assert.deepStrictEqual(parseEvaluationResponse({ data: { attributes: { action: 'ALLOW' } } }), {
      action: 'ALLOW',
      reason: undefined,
      tags: [],
      sdsFindings: [],
      tagProbabilities: {},
      hasTagProbabilities: false,
      blockingEnabled: false,
      redactionReplacements: undefined,
    })
  })

  for (const response of [
    undefined,
    {},
    { data: {} },
    { data: { attributes: {} } },
    { data: { attributes: { action: '' } } },
    { data: { attributes: { action: 42 } } },
  ]) {
    it('rejects an invalid backend response', () => {
      assert.strictEqual(parseEvaluationResponse(response), undefined)
    })
  }

  it('returns the redacted private snapshot in a blocked outcome', () => {
    const privateSnapshot = [{ role: 'user', content: 'My SSN is 123-45-6789' }]
    const evaluation = parseEvaluationResponse({
      data: {
        attributes: {
          action: 'DENY',
          reason: 'Sensitive data detected.',
          tags: ['prompt-injection'],
          sds_findings: [{ category: 'email_address', matched_text: 'ops@acme.io' }],
          tag_probs: { 'prompt-injection': 0.9 },
          is_blocking_enabled: true,
          redaction_replacements: [
            { path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' },
          ],
        },
      },
    })

    assert.ok(evaluation)
    const outcome = createEvaluationOutcome(privateSnapshot, evaluation, { block: true, redactionEnabled: true })

    assert.deepStrictEqual(outcome, {
      result: {
        action: 'DENY',
        reason: 'Sensitive data detected.',
        tags: ['prompt-injection'],
        tagProbabilities: { 'prompt-injection': 0.9 },
        sds: [{ category: 'email_address', matched_text: 'ops@acme.io' }],
        messages: [{ role: 'user', content: 'My SSN is <REDACTED>' }],
        redactionReplacements: [{ path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' }],
      },
      shouldBlock: true,
      hasTagProbabilities: true,
      redaction: {
        enabled: true,
        applied: true,
        failures: 0,
      },
    })
    assert.strictEqual(outcome.result.messages, privateSnapshot)
    assert.strictEqual(privateSnapshot[0].content, 'My SSN is <REDACTED>')
  })

  it('keeps original messages but reports the backend replacements when redaction is disabled', () => {
    const messages = [{ role: 'user', content: 'My SSN is 123-45-6789' }]
    const evaluation = parseEvaluationResponse({
      data: {
        attributes: {
          action: 'ALLOW',
          redaction_replacements: [
            { path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' },
          ],
        },
      },
    })

    assert.ok(evaluation)
    const outcome = createEvaluationOutcome(messages, evaluation, { block: true, redactionEnabled: false })

    assert.strictEqual(outcome.result.messages, messages)
    assert.deepStrictEqual(outcome.result.redactionReplacements, [
      { path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' },
    ])
    assert.deepStrictEqual(outcome.redaction, {
      enabled: false,
      applied: false,
      failures: 0,
    })
  })

  for (const redactionEnabled of [true, false]) {
    it(`reports no replacements when the backend sends none and redaction is ${
      redactionEnabled ? 'enabled' : 'disabled'}`, () => {
      const messages = [{ role: 'user', content: 'Hello' }]
      const evaluation = parseEvaluationResponse({ data: { attributes: { action: 'ALLOW' } } })

      assert.ok(evaluation)
      const outcome = createEvaluationOutcome(messages, evaluation, { block: true, redactionEnabled })

      assert.deepStrictEqual(outcome.result.redactionReplacements, [])
    })
  }

  it('reports only well-formed replacements while still counting malformed ones as failures', () => {
    const messages = [{ role: 'user', content: 'My SSN is 123-45-6789' }]
    const evaluation = parseEvaluationResponse({
      data: {
        attributes: {
          action: 'ALLOW',
          redaction_replacements: [
            { path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' },
            { path: 'messages[8].content', replacement: 'unresolvable but well-formed' },
            'not an object',
            { path: 'messages[0].content', replacement: 42 },
            { path: '', replacement: 'empty path' },
          ],
        },
      },
    })

    assert.ok(evaluation)
    const outcome = createEvaluationOutcome(messages, evaluation, { block: true, redactionEnabled: true })

    assert.deepStrictEqual(outcome.result.redactionReplacements, [
      { path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' },
      { path: 'messages[8].content', replacement: 'unresolvable but well-formed' },
    ])
    assert.strictEqual(outcome.redaction.failures, 4)
  })

  for (const replacements of ['not an array', false]) {
    it(`reports no replacements when the backend sends non-array ${JSON.stringify(replacements)}`, () => {
      const privateSnapshot = [{ role: 'user', content: 'My SSN is 123-45-6789' }]
      const evaluation = parseEvaluationResponse({
        data: { attributes: { action: 'ALLOW', redaction_replacements: replacements } },
      })

      assert.ok(evaluation)
      const outcome = createEvaluationOutcome(privateSnapshot, evaluation, { block: true, redactionEnabled: true })

      assert.deepStrictEqual(outcome.result.redactionReplacements, [])
      assert.strictEqual(outcome.result.messages, privateSnapshot)
      assert.deepStrictEqual(privateSnapshot, [{ role: 'user', content: 'My SSN is 123-45-6789' }])
      assert.deepStrictEqual(outcome.redaction, {
        enabled: true,
        applied: false,
        failures: 1,
      })
    })
  }

  for (const testCase of [
    { block: false, action: 'DENY', blockingEnabled: true, expected: false },
    { block: true, action: 'DENY', blockingEnabled: false, expected: false },
    { block: true, action: 'ALLOW', blockingEnabled: true, expected: false },
    { block: true, action: 'DENY', blockingEnabled: true, expected: true },
  ]) {
    it(`returns ${testCase.expected} when block=${testCase.block}, action=${testCase.action}, and ` +
      `blockingEnabled=${testCase.blockingEnabled}`, () => {
      const evaluation = {
        action: testCase.action,
        blockingEnabled: testCase.blockingEnabled,
      }

      assert.strictEqual(shouldBlockEvaluation(testCase.block, evaluation), testCase.expected)
    })
  }
})
