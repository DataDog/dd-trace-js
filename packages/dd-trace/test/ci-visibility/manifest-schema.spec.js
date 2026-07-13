'use strict'

const assert = require('node:assert/strict')

const { validateManifest } = require('../../../../ci/test-optimization-validation/manifest-schema')

describe('test optimization validation manifest schema', () => {
  it('rejects unresolved placeholders in executable command env', () => {
    const errors = validateManifest(getManifest({
      ciWiring: {
        status: 'fail',
        provider: 'github-actions',
        configFile: '/repo/.github/workflows/test.yml',
        job: 'test',
        step: 'Run tests',
        whySelected: 'This step runs the selected test command.',
        workingDirectory: '/repo',
      },
      ciWiringCommand: {
        cwd: '/repo',
        argv: ['npm', 'test'],
        env: {
          NODE_OPTIONS: '$' + '{NODE_OPTIONS}',
        },
      },
    }))

    assert.deepStrictEqual(errors, [
      'frameworks[0].ciWiringCommand.env.NODE_OPTIONS contains an unresolved placeholder. ' +
        'Resolve it before live validation.',
    ])
  })

  it('rejects unresolved placeholders in forced local command argv', () => {
    const errors = validateManifest(getManifest({
      forcedLocalCommand: {
        cwd: '/repo',
        argv: ['npm', 'test', '--', '$' + '{TEST_FILE}'],
      },
    }))

    assert.deepStrictEqual(errors, [
      'frameworks[0].forcedLocalCommand.argv[3] contains an unresolved placeholder. ' +
        'Resolve it before live validation.',
    ])
  })

  it('rejects duplicate runnable framework and CI command coverage', () => {
    const manifest = getManifest({
      ciWiring: getCiWiring(),
      ciWiringCommand: getCiWiringCommand(),
    })
    manifest.frameworks.push({
      ...manifest.frameworks[0],
      id: 'jest:release',
      ciWiring: {
        ...getCiWiring(),
        workflow: 'release',
        job: 'release-test',
      },
      ciWiringCommand: {
        ...getCiWiringCommand(),
        env: { CI: 'true' },
      },
    })

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[1] duplicates runnable framework and CI command coverage from frameworks[0]. ' +
        'Keep one representative framework entry and record the other CI job as an omitted or duplicate candidate.',
    ])
  })

  it('allows the same CI command shape when Datadog initialization differs', () => {
    const manifest = getManifest({
      ciWiring: getCiWiring(),
      ciWiringCommand: getCiWiringCommand(),
    })
    manifest.frameworks.push({
      ...manifest.frameworks[0],
      id: 'jest:initialized',
      ciWiring: {
        ...getCiWiring(),
        workflow: 'initialized',
      },
      ciWiringCommand: {
        ...getCiWiringCommand(),
        env: { NODE_OPTIONS: '-r dd-trace/ci/init' },
      },
    })

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  it('accepts structured CI initialization evidence', () => {
    const manifest = getManifest({
      ciWiring: {
        ...getCiWiring(),
        initialization: {
          status: 'not_configured',
          evidence: ['The selected job has no NODE_OPTIONS or DD_* configuration.'],
        },
      },
      ciWiringCommand: getCiWiringCommand(),
    })

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  it('rejects conclusive CI initialization status without evidence', () => {
    const manifest = getManifest({
      ciWiring: {
        ...getCiWiring(),
        initialization: {
          status: 'configured',
          evidence: [],
        },
      },
      ciWiringCommand: getCiWiringCommand(),
    })

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.initialization.evidence must explain the configured conclusion.',
    ])
  })
})

function getCiWiring () {
  return {
    status: 'unknown',
    provider: 'github-actions',
    configFile: '/repo/.github/workflows/test.yml',
    job: 'test',
    step: 'Run tests',
    whySelected: 'This step runs tests.',
    workingDirectory: '/repo',
    diagnosis: 'The command is replayable.',
  }
}

function getCiWiringCommand () {
  return {
    cwd: '/repo',
    argv: ['npm', 'test'],
    env: { CI: 'true' },
  }
}

function getManifest (frameworkFields) {
  return {
    schemaVersion: '1.0',
    repository: {
      root: '/repo',
    },
    environment: {},
    frameworks: [
      {
        id: 'jest:root',
        framework: 'jest',
        status: 'runnable',
        project: {
          root: '/repo',
        },
        existingTestCommand: {
          cwd: '/repo',
          argv: ['npm', 'test'],
        },
        preflight: {
          ran: true,
          exitCode: 0,
        },
        ciWiring: {
          status: 'skip',
          reason: 'No replayable CI test command was selected for this fixture.',
        },
        ...frameworkFields,
      },
    ],
  }
}
