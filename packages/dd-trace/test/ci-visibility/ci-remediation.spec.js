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
        command: 'npm run test:unit',
        stepEnv: { CI: 'true' },
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

  it('formats sparse CI locations without a leading separator', () => {
    const workflow = buildCiRemediation({ framework: 'jest', ciWiring: { workflow: 'CI' } })
    const step = buildCiRemediation({ framework: 'jest', ciWiring: { step: 'Run tests' } })
    const fallback = buildCiRemediation({ framework: 'jest' })

    assert.strictEqual(workflow.location, 'workflow "CI"')
    assert.strictEqual(step.location, 'step "Run tests"')
    assert.strictEqual(fallback.location, 'the selected CI test step')
  })

  it('does not recommend agentless variables when CI records Agent transport evidence', () => {
    const remediation = buildCiRemediation({
      framework: 'jest',
      ciWiring: {
        provider: 'github-actions',
        command: 'npm test',
        transport: {
          mode: 'agent',
          evidence: ['The selected test job declares a Datadog Agent sidecar.'],
        },
        stepEnv: {
          DD_AGENT_HOST: 'datadog-agent',
          DD_API_KEY: 'dd-validation-placeholder',
        },
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

  it('does not infer agentless transport from a bare API key', () => {
    const remediation = buildCiRemediation({
      framework: 'jest',
      ciWiring: {
        provider: 'github-actions',
        command: 'npm test',
        stepEnv: { DD_API_KEY: 'dd-validation-placeholder' },
      },
    })

    assert.strictEqual(remediation.transport, 'unknown')
    assert.deepStrictEqual(remediation.variants.map(variant => variant.id), ['agentless'])
    assert.match(remediation.summary, /If a Datadog Agent is available and reachable/)
  })

  it('preserves the discovered CI command from static evidence', () => {
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

  it('preserves the original CI command as inert configuration evidence', () => {
    const originalCommand = 'npm test -- --project "unit tests" && echo "$CI_JOB"'
    const remediation = buildCiRemediation({
      framework: 'jest',
      project: { name: 'example' },
      ciWiring: {
        provider: 'github-actions',
        command: originalCommand,
      },
    })

    assert.match(remediation.variants[0].snippet, /npm test -- --project "unit tests" && echo "\$CI_JOB"/)
  })

  it('preserves existing literal NODE_OPTIONS when adding the Datadog preload', () => {
    const remediation = buildCiRemediation({
      framework: 'jest',
      project: { name: 'example' },
      ciWiring: {
        provider: 'github-actions',
        command: 'npm test',
        stepEnv: {
          NODE_OPTIONS: '--max-old-space-size=4096 --enable-source-maps',
        },
      },
    })

    assert.match(
      remediation.variants[0].snippet,
      /NODE_OPTIONS: "--max-old-space-size=4096 --enable-source-maps -r dd-trace\/ci\/init"/
    )
    assert.match(
      remediation.summary,
      /NODE_OPTIONS=--max-old-space-size=4096 --enable-source-maps -r dd-trace\/ci\/init/
    )
  })

  it('preserves a case-insensitive NODE_OPTIONS entry for Windows CI shells', () => {
    const remediation = buildCiRemediation({
      framework: 'jest',
      project: { name: 'example' },
      ciWiring: {
        provider: 'github-actions',
        shell: 'pwsh',
        command: 'npm test',
        stepEnv: {
          node_options: '--max-old-space-size=4096',
        },
      },
    })

    assert.match(
      remediation.variants[0].snippet,
      /NODE_OPTIONS: "--max-old-space-size=4096 -r dd-trace\/ci\/init"/
    )
  })

  it('does not invent a GitHub Actions test command when discovery did not resolve one', () => {
    const remediation = buildCiRemediation({
      framework: 'jest',
      ciWiring: {
        provider: 'github-actions',
        configFile: '/repo/.github/workflows/test.yml',
        job: 'unit',
      },
    })

    assert.match(remediation.variants[0].snippet, /^env:$/m)
    assert.doesNotMatch(remediation.variants[0].snippet, /- name:|run:|keep the existing test command/)
  })

  it('removes a confirmed inline NODE_OPTIONS reset from a GitHub Actions fix', () => {
    const remediation = buildCiRemediation({
      framework: 'jest',
      ciWiring: {
        provider: 'github-actions',
        command: 'NODE_OPTIONS="" node ./node_modules/jest/bin/jest.js test/example.test.js',
        job: 'test',
        step: 'Run tests',
        transport: { mode: 'agent' },
      },
    })

    assert.match(remediation.variants[0].snippet, /NODE_OPTIONS: "-r dd-trace\/ci\/init"/)
    assert.match(
      remediation.variants[0].snippet,
      /run: \|\n {4}node \.\/node_modules\/jest\/bin\/jest\.js test\/example\.test\.js/
    )
    assert.doesNotMatch(remediation.variants[0].snippet, /NODE_OPTIONS=""/)
  })

  it('quotes shell values for non-GitHub CI providers', () => {
    const remediation = buildCiRemediation({
      framework: 'jest',
      ciWiring: { provider: 'gitlab-ci' },
    })

    assert.match(remediation.variants[0].snippet, /^NODE_OPTIONS="-r dd-trace\/ci\/init"$/m)
    assert.match(
      remediation.variants[0].snippet,
      /^DD_API_KEY="<DD_API_KEY_FROM_CI_SECRET_STORE>"$/m
    )
    assert.doesNotMatch(remediation.variants[0].snippet, /^NODE_OPTIONS=-r /m)
  })
})
