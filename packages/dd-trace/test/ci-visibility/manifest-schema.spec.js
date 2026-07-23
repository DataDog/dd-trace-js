'use strict'

const assert = require('node:assert/strict')

const { validateManifest } = require('../../../../ci/test-optimization-validation/manifest-schema')

describe('test optimization validation manifest schema', () => {
  it('rejects unresolved placeholders in executable command env', () => {
    const manifest = getManifest()
    manifest.frameworks[0].existingTestCommand.env = { NODE_OPTIONS: '$' + '{NODE_OPTIONS}' }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].existingTestCommand.env.NODE_OPTIONS contains an unresolved placeholder. ' +
        'Resolve it before live validation.',
    ])
  })

  it('accepts explicitly inherited non-secret project environment names', () => {
    const manifest = getManifest()
    manifest.frameworks[0].existingTestCommand.requiredEnvVars = ['NODE_ENV', 'PROJECT_TEST_MODE']

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  it('rejects dangerous, secret-like, Datadog, duplicate, and explicit inherited environment names', () => {
    const manifest = getManifest()
    manifest.frameworks[0].existingTestCommand.env = { PROJECT_TEST_MODE: 'integration' }
    manifest.frameworks[0].existingTestCommand.requiredEnvVars = [
      'NODE_OPTIONS',
      'SERVICE_TOKEN',
      'DD_API_KEY',
      'PROJECT_TEST_MODE',
      'NODE_ENV',
      'NODE_ENV',
    ]

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].existingTestCommand.requiredEnvVars[0] may alter executable or configuration loading and must ' +
        'not be inherited.',
      'frameworks[0].existingTestCommand.requiredEnvVars[1] must not inherit a secret-like variable.',
      'frameworks[0].existingTestCommand.requiredEnvVars[2] must not inherit a DD_* or _DD_* variable.',
      'frameworks[0].existingTestCommand.requiredEnvVars[2] must not inherit a secret-like variable.',
      'frameworks[0].existingTestCommand.requiredEnvVars[3] duplicates an explicit command.env entry.',
      'frameworks[0].existingTestCommand.requiredEnvVars[5] duplicates another requiredEnvVars entry.',
    ])
  })

  it('rejects Windows environment aliases that configure Datadog or Node.js outputs', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const manifest = getManifest()
    manifest.frameworks[0].existingTestCommand.env = {
      dd_api_key: 'placeholder',
      Node_Options: '-r dd-trace/ci/init',
    }

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      assert.deepStrictEqual(validateManifest(manifest), [
        'frameworks[0].existingTestCommand.env.dd_api_key must not configure Datadog initialization for local ' +
          'validation.',
        'frameworks[0].existingTestCommand.env.Node_Options must not configure Datadog initialization for local ' +
          'validation.',
      ])
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('rejects the removed forced local command role', () => {
    const errors = validateManifest(getManifest({
      forcedLocalCommand: { cwd: '/repo', argv: ['npm', 'test'] },
    }))

    assert.deepStrictEqual(errors, [
      'frameworks[0].forcedLocalCommand is not supported. Use the focused existingTestCommand for Basic ' +
        'Reporting and record CI initialization only as static ciWiring evidence.',
    ])
  })

  it('accepts structured static CI initialization evidence', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The selected job has no NODE_OPTIONS configuration.'],
    }

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  it('accepts unknown CI transport without evidence', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring.transport = { mode: 'unknown', evidence: [] }

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  it('requires evidence for a conclusive CI transport mode', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring.transport = { mode: 'agent', evidence: [] }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.transport.evidence must explain the agent conclusion.',
    ])
  })

  it('rejects unsupported CI transport modes', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring.transport = { mode: 'sidecar', evidence: ['A sidecar was found.'] }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.transport.mode must be exactly agentless, agent, none, or unknown.',
    ])
  })

  it('requires structured CI job evidence before recording a conclusive transport mode', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring = {
      diagnosis: 'No reporting transport was found.',
      initialization: { status: 'unknown', evidence: [] },
      transport: { mode: 'none', evidence: ['The selected job has no Agent or agentless reporting.'] },
      unresolved: ['The selected CI test job still requires review.'],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.configFile must be populated before setting ' +
        'frameworks[0].ciWiring.transport.mode to none.',
      'frameworks[0].ciWiring.job must be populated before setting frameworks[0].ciWiring.transport.mode to none.',
      'frameworks[0].ciWiring.command must be populated before setting ' +
        'frameworks[0].ciWiring.transport.mode to none.',
    ])
  })

  it('requires structured CI job evidence before recording a conclusive initialization status', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring = {
      configFile: null,
      job: null,
      command: null,
      diagnosis: 'The selected CI job does not configure Test Optimization.',
      initialization: {
        status: 'not_configured',
        evidence: ['No initialization was found.'],
      },
      transport: { mode: 'unknown', evidence: [] },
      unresolved: ['The selected CI test job still requires review.'],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.configFile must be populated before setting ' +
        'frameworks[0].ciWiring.initialization.status to not_configured.',
      'frameworks[0].ciWiring.job must be populated before setting ' +
        'frameworks[0].ciWiring.initialization.status to not_configured.',
      'frameworks[0].ciWiring.command must be populated before setting ' +
        'frameworks[0].ciWiring.initialization.status to not_configured.',
    ])
  })

  it('requires structured CI job evidence before clearing unresolved review items', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring = {
      configFile: null,
      job: null,
      command: null,
      diagnosis: 'CI initialization evidence has not been completed.',
      initialization: { status: 'unknown', evidence: [] },
      transport: { mode: 'unknown', evidence: [] },
      unresolved: [],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.configFile must be populated before clearing frameworks[0].ciWiring.unresolved.',
      'frameworks[0].ciWiring.job must be populated before clearing frameworks[0].ciWiring.unresolved.',
      'frameworks[0].ciWiring.command must be populated before clearing frameworks[0].ciWiring.unresolved.',
    ])
  })

  it('requires the CI review flag to be boolean', () => {
    const manifest = getManifest()
    manifest.ciDiscovery = { reviewRequired: 'no' }

    assert.deepStrictEqual(validateManifest(manifest), [
      'ciDiscovery.reviewRequired must be a boolean when present.',
    ])
  })

  it('explains the exact CI initialization status for natural-language aliases', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring.initialization = {
      status: 'missing',
      evidence: ['The selected job has no NODE_OPTIONS configuration.'],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.initialization.status must be exactly configured, not_configured, or unknown. ' +
        'Use not_configured when the selected CI job does not initialize Test Optimization; do not use missing, ' +
        'absent, unconfigured, or other natural-language values.',
    ])
  })

  it('rejects execution instructions on a non-runnable framework', () => {
    const manifest = getManifest({
      status: 'detected_not_runnable',
      notes: ['The installed runner version is unsupported.'],
      setup: { commands: [{ cwd: '/repo', argv: ['npm', 'test'] }] },
      generatedTestStrategy: { status: 'not_possible', reason: 'Unsupported runner version.' },
    })

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].existingTestCommand must be omitted when frameworks[0].status is not runnable.',
      'frameworks[0].preflight must be omitted when frameworks[0].status is not runnable.',
      'frameworks[0].generatedTestStrategy must be omitted when frameworks[0].status is not runnable.',
      'frameworks[0].setup.commands is not supported. Record the concrete project-setup blocker and run setup as ' +
        'a separate, explicitly approved workflow before creating a fresh validation plan.',
    ])
  })

  it('rejects conclusive CI initialization status without evidence', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring.initialization = { status: 'configured', evidence: [] }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.initialization.evidence must explain the configured conclusion.',
    ])
  })

  it('requires static CI initialization evidence for runnable frameworks', () => {
    const manifest = getManifest()
    delete manifest.frameworks[0].ciWiring.initialization

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.initialization must record the static CI configuration conclusion.',
    ])
  })

  it('rejects executable CI command fields', () => {
    const manifest = getManifest({
      ciWiringCommand: { cwd: '/repo', argv: ['npm', 'test'] },
    })

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiringCommand is not supported. Record the CI command as inert text in ' +
        'frameworks[0].ciWiring.command.',
    ])
  })

  it('requires CI commands to remain inert text', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring.command = { cwd: '/repo', argv: ['npm', 'test'] }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.command must be a string when present.',
    ])
  })

  it('requires execution capability flags to be boolean', () => {
    const manifest = getManifest({
      browserRequired: 'yes',
      localSocketRequired: 1,
    })

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].browserRequired must be a boolean when present.',
      'frameworks[0].localSocketRequired must be a boolean when present.',
    ])
  })

  it('requires each isolation command to match its project-command fallback', () => {
    const manifest = getManifest({
      localTestCandidates: [
        {
          command: { cwd: '/repo', argv: ['npm', 'test', '--', '/repo/test/first.test.js'] },
          maxTestCount: 1,
          origin: 'project',
          sourceFile: '/repo/test/first.test.js',
        },
        {
          command: { cwd: '/repo', argv: ['npm', 'test', '--', '/repo/test/second.test.js'] },
          maxTestCount: 1,
          origin: 'project',
          sourceFile: '/repo/test/second.test.js',
        },
      ],
      isolationTestCandidates: [{
        command: {
          cwd: '/repo',
          argv: ['node', '/repo/node_modules/vitest/vitest.mjs', 'run', '/repo/test/first.test.js'],
        },
        equivalence: {
          configurationArgs: [],
          framework: 'jest',
          mode: 'test',
          sourceFile: '/repo/test/first.test.js',
        },
        maxTestCount: 1,
        origin: 'validator-direct',
        primaryCandidateIndex: 1,
        sourceFile: '/repo/test/first.test.js',
      }],
    })

    const errors = validateManifest(manifest)

    assert.ok(errors.includes(
      'frameworks[0].isolationTestCandidates[0].sourceFile must match its selected localTestCandidates sourceFile.'
    ))
  })
})

function getManifest (frameworkFields) {
  return {
    schemaVersion: '1.0',
    repository: { root: '/repo' },
    environment: {},
    frameworks: [{
      id: 'jest:root',
      framework: 'jest',
      status: 'runnable',
      project: { root: '/repo' },
      existingTestCommand: { cwd: '/repo', argv: ['npm', 'test'] },
      preflight: { ran: true, exitCode: 0, maxTestCount: 50 },
      ciWiring: {
        configFile: '/repo/.github/workflows/test.yml',
        job: 'test',
        command: 'npm test',
        diagnosis: 'CI initialization evidence has not been completed.',
        initialization: { status: 'unknown', evidence: [] },
        transport: { mode: 'unknown', evidence: [] },
        unresolved: [],
      },
      ...frameworkFields,
    }],
  }
}
