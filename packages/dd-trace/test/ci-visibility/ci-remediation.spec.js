'use strict'

const assert = require('node:assert/strict')

const { buildCiRemediation } = require('../../../../ci/test-optimization-validation/ci-remediation')
const { sanitizeForReport } = require('../../../../ci/test-optimization-validation/redaction')

describe('test optimization CI remediation', () => {
  it('builds an agentless-first copy-ready GitHub Actions fix', () => {
    const remediation = buildCiRemediation({
      id: 'vitest:axios',
      framework: 'vitest',
      project: { name: 'axios' },
      ciWiring: {
        provider: 'github-actions',
        configFile: '/repo/.github/workflows/test.yml',
        workflow: 'CI',
        job: 'unit',
        step: 'Run unit tests',
      },
      ciWiringCommand: {
        cwd: '/repo',
        argv: ['npm', 'run', 'test:unit'],
        env: { CI: 'true' },
      },
    })

    assert.match(remediation.location, /test\.yml.*workflow "CI".*job "unit".*step "Run unit tests"/)
    assert.deepStrictEqual(remediation.variants.map(variant => variant.id), ['agentless'])
    assert.match(remediation.variants[0].snippet, /# Job: unit/)
    assert.match(remediation.variants[0].snippet, /- name: "Run unit tests"/)
    assert.match(
      remediation.variants[0].snippet,
      /NODE_OPTIONS: "--import dd-trace\/register\.js -r dd-trace\/ci\/init"/
    )
    assert.match(remediation.variants[0].snippet, /run: \|\n {4}npm run test:unit/)
    assert.match(remediation.variants[0].snippet, /DD_CIVISIBILITY_AGENTLESS_ENABLED: "true"/)
    assert.match(remediation.variants[0].snippet, /DD_API_KEY: \$\{\{ secrets\.DD_API_KEY \}\}/)
    assert.match(remediation.variants[0].snippet, /DD_SERVICE: "axios-tests"/)
    assert.match(remediation.variants[0].snippet, /DD_TEST_SESSION_NAME: "vitest-unit-tests"/)
    assert.match(remediation.summary, /do not pass DD_API_KEY or DD_CIVISIBILITY_AGENTLESS_ENABLED/)
    assert.match(remediation.summary, /NODE_OPTIONS=--import dd-trace\/register\.js -r dd-trace\/ci\/init/)
    assert.doesNotMatch(remediation.summary, /DD_ENV|DD_TRACE_AGENT_URL/)
    assert.doesNotMatch(remediation.variants[0].snippet, /DD_ENV|DD_TRACE_AGENT_URL/)
    assert.strictEqual(
      remediation.variants[0].requiredValues.find(value => value.name === 'DD_API_KEY').source,
      'ci-secret-store'
    )
    assert.strictEqual(
      remediation.variants[0].requiredValues.find(value => value.name === 'NODE_OPTIONS').source,
      'literal'
    )
    assert.deepStrictEqual(remediation.variants[0].recommendedValues, [
      {
        name: 'DD_SERVICE',
        value: 'axios-tests',
        description: 'Use a service name that identifies this project test suite.',
      },
      {
        name: 'DD_TEST_SESSION_NAME',
        value: 'vitest-unit-tests',
        description: 'Use a session name that identifies this test runner and suite.',
      },
    ])
    assert.deepStrictEqual(remediation.variants[0].optionalValues.map(value => value.name), ['DD_SITE'])

    const sanitized = sanitizeForReport(remediation)
    assert.match(sanitized.variants[0].snippet, /DD_API_KEY: \$\{\{ secrets\.DD_API_KEY \}\}/)
    assert.strictEqual(sanitized.variants[0].requiredValues[0].source, 'literal')
    assert.strictEqual(
      sanitized.variants[0].requiredValues.find(value => value.name === 'DD_API_KEY').source,
      'ci-secret-store'
    )
  })

  it('does not recommend agentless variables when CI already identifies an Agent endpoint', () => {
    const remediation = buildCiRemediation({
      framework: 'jest',
      ciWiring: { provider: 'github-actions' },
      ciWiringCommand: {
        cwd: '/repo',
        argv: ['npm', 'test'],
        env: { DD_AGENT_HOST: 'datadog-agent' },
      },
    })

    assert.deepStrictEqual(remediation.variants.map(variant => variant.id), ['agent'])
    assert.doesNotMatch(remediation.variants[0].snippet, /DD_API_KEY|AGENTLESS/)
    assert.match(remediation.variants[0].snippet, /NODE_OPTIONS: "-r dd-trace\/ci\/init"/)
    assert.match(remediation.variants[0].snippet, /DD_SERVICE: "test-tests"/)
    assert.match(remediation.variants[0].snippet, /DD_TEST_SESSION_NAME: "jest-tests"/)
    assert.deepStrictEqual(remediation.variants[0].optionalValues.map(value => value.name), [
    ])
  })

  it('preserves the discovered CI command when live replay is unavailable', () => {
    const remediation = buildCiRemediation({
      id: 'vitest:date-fns',
      framework: 'vitest',
      project: { name: 'date-fns' },
      ciWiring: {
        provider: 'github-actions',
        packageScriptExpansionChain: [
          'mise //pkgs/core:test/node',
          './scripts/test/node.sh',
          'pnpm vitest run --project main',
        ],
      },
    })

    assert.match(remediation.variants[0].snippet, /run: \|\n {4}mise \/\/pkgs\/core:test\/node/)
    assert.doesNotMatch(remediation.variants[0].snippet, /keep the existing test command here/)
  })
})
