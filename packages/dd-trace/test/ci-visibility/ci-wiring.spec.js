'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runCiWiring } = require('../../../../ci/test-optimization-validation/scenarios/ci-wiring')

function getFramework (overrides = {}) {
  return {
    id: 'vitest:unit',
    framework: 'vitest',
    project: { name: 'fixture', root: process.cwd() },
    ciWiring: {
      provider: 'github-actions',
      configFile: path.join(process.cwd(), '.github/workflows/test.yml'),
      job: 'test',
      step: 'Run tests',
      command: 'npm test',
      initialization: {
        status: 'unknown',
        evidence: [],
      },
    },
    ...overrides,
  }
}

describe('test optimization CI configuration audit', () => {
  it('confirms that an identified CI job does not initialize Test Optimization', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The selected test step does not set NODE_OPTIONS.'],
    }

    const result = runCiWiring({ manifest: {}, framework, basicResult: { status: 'pass' } })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    assert.strictEqual(result.evidence.domain, 'ci_configuration')
    assert.match(result.diagnosis, /no project CI command was run/)
  })

  it('does not claim a test job was identified from a workflow-wide scan', () => {
    const framework = getFramework()
    delete framework.ciWiring.job
    delete framework.ciWiring.step
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['No discovered CI configuration references dd-trace/ci/init.'],
    }

    const result = runCiWiring({ manifest: {}, framework, basicResult: { status: 'pass' } })

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /^The inspected CI workflow does not configure NODE_OPTIONS/)
    assert.doesNotMatch(result.diagnosis, /identified CI test job/)
  })

  it('reports configured agentless CI as propagation-unverified', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.stepEnv = { DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true' }
    framework.ciWiring.requiredSecretEnvVars = ['DD_API_KEY']

    const result = runCiWiring({ manifest: {}, framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    assert.match(result.diagnosis, /cannot prove that NODE_OPTIONS reaches the final test process/)
  })

  it('recognizes the explicit ci/init.js preload when inferring initialization', () => {
    const framework = getFramework()
    framework.ciWiring.stepEnv = {
      DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true',
      NODE_OPTIONS: '-r dd-trace/ci/init.js',
    }
    framework.ciWiring.requiredSecretEnvVars = ['DD_API_KEY']

    const result = runCiWiring({ manifest: {}, framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.initializationStatus, 'configured')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
  })

  it('accepts DATADOG_API_KEY as the agentless API key reference', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.stepEnv = { DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true' }
    framework.ciWiring.requiredSecretEnvVars = ['DATADOG_API_KEY']

    const result = runCiWiring({ manifest: {}, framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.apiKeyConfigured, true)
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
  })

  it('fails when agentless reporting has no API key reference', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.stepEnv = { DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true' }

    const result = runCiWiring({ manifest: {}, framework })

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /does not record DD_API_KEY/)
  })

  it('fails when initialization is configured without a reporting transport', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }

    const result = runCiWiring({ manifest: {}, framework })

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /neither enables agentless reporting nor records a Datadog Agent/)
  })

  it('reports an explicit NODE_OPTIONS reset with its package script source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ci-audit-'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'NODE_OPTIONS= vitest run' },
    }))
    const framework = getFramework({ project: { name: 'fixture', root } })
    framework.ciWiring.packageScriptExpansionChain = ['NODE_OPTIONS= vitest run']

    const result = runCiWiring({ manifest: { repository: { root } }, framework })

    assert.strictEqual(result.status, 'fail')
    assert.deepStrictEqual(result.evidence.nodeOptionsRemoval, {
      command: 'NODE_OPTIONS= vitest run',
      packageJson: path.join(root, 'package.json'),
      scriptName: 'test',
    })
    assert.match(result.diagnosis, /clears the Datadog preload/)
  })

  it('keeps contradictory CI discovery incomplete', () => {
    const framework = getFramework()
    framework.ciWiring.provider = 'none'
    framework.ciWiring.diagnosis = 'No CI workflow was found.'

    const result = runCiWiring({
      manifest: { ciDiscovery: { staticFound: ['.github/workflows/test.yml'] } },
      framework,
    })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.match(result.diagnosis, /CI workflow files were found/)
  })

  it('audits CI independently when Basic Reporting does not pass', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The selected test step does not set NODE_OPTIONS.'],
    }

    const result = runCiWiring({
      manifest: {},
      framework,
      basicResult: { status: 'error', diagnosis: 'Project setup failed.' },
    })

    assert.strictEqual(result.status, 'fail')
    assert.deepStrictEqual(result.evidence.directInitializationBasicReporting, {
      ran: true,
      status: 'error',
      diagnosis: 'Project setup failed.',
    })
  })
})
