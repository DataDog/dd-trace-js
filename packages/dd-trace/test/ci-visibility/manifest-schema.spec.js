'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateManifest } = require('../../../../ci/test-optimization-validation/manifest-schema')

describe('test optimization validation manifest schema', () => {
  it('rejects unresolved placeholders in executable command env', () => {
    const errors = validateManifest(getManifest({
      ciWiring: {
        status: 'fail',
        replayability: 'replayable',
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

  it('rejects the removed forced local command role', () => {
    const errors = validateManifest(getManifest({
      forcedLocalCommand: {
        cwd: '/repo',
        argv: ['npm', 'test'],
      },
    }))

    assert.deepStrictEqual(errors, [
      'frameworks[0].forcedLocalCommand is not supported. Use the focused existingTestCommand for Basic ' +
        'Reporting and ciWiringCommand for the CI-shaped replay.',
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

  it('rejects CI replay initialization that contradicts discovery evidence', () => {
    const manifest = getManifest({
      ciWiring: {
        ...getCiWiring(),
        initialization: {
          status: 'not_configured',
          evidence: ['The selected job has no NODE_OPTIONS or DD_* configuration.'],
        },
      },
      ciWiringCommand: {
        ...getCiWiringCommand(),
        env: { NODE_OPTIONS: '--require dd-trace/ci/init' },
      },
    })

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.initialization.status is not_configured, but ' +
        'frameworks[0].ciWiringCommand adds dd-trace initialization. The replay command must preserve the ' +
        'discovered CI configuration; remove the added initialization or correct the initialization status and ' +
        'evidence.',
    ])
  })

  it('does not treat a project-local ci/init script as Datadog initialization', () => {
    const manifest = getManifest({
      ciWiring: {
        ...getCiWiring(),
        initialization: {
          status: 'not_configured',
          evidence: ['The selected job has no NODE_OPTIONS or DD_* configuration.'],
        },
      },
      ciWiringCommand: {
        ...getCiWiringCommand(),
        env: { NODE_OPTIONS: '-r ./ci/init' },
      },
    })

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  it('recognizes the validator init path in contradiction checks', () => {
    const manifest = getManifest({
      ciWiring: {
        ...getCiWiring(),
        initialization: {
          status: 'not_configured',
          evidence: ['The selected job has no NODE_OPTIONS or DD_* configuration.'],
        },
      },
      ciWiringCommand: {
        ...getCiWiringCommand(),
        env: { NODE_OPTIONS: `-r ${path.resolve(__dirname, '../../../../ci/init.js')}` },
      },
    })

    assert.match(validateManifest(manifest)[0], /adds dd-trace initialization/)
  })

  it('rejects execution instructions on a non-runnable framework', () => {
    const manifest = getManifest({
      status: 'detected_not_runnable',
      notes: ['The installed runner version is unsupported.'],
      setup: { commands: [getCiWiringCommand()] },
      generatedTestStrategy: { status: 'not_possible', reason: 'Unsupported runner version.' },
    })

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].existingTestCommand must be omitted when frameworks[0].status is not runnable.',
      'frameworks[0].preflight must be omitted when frameworks[0].status is not runnable.',
      'frameworks[0].generatedTestStrategy must be omitted when frameworks[0].status is not runnable.',
      'frameworks[0].setup.commands must be empty or omitted when frameworks[0].status is not runnable.',
    ])
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

  it('requires an explicit CI replayability decision', () => {
    const manifest = getManifest()
    delete manifest.frameworks[0].ciWiring.replayability

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.replayability must be replayable or not_replayable.',
    ])
  })

  it('requires the CI command when replay is possible', () => {
    const manifest = getManifest({
      ciWiring: {
        ...getCiWiring(),
        status: 'unknown',
      },
    })

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiringCommand is required when frameworks[0].ciWiring.replayability is replayable.',
    ])
  })

  it('requires a concrete blocker when CI replay is unavailable', () => {
    const manifest = getManifest()
    delete manifest.frameworks[0].ciWiring.replayBlocker

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.replayBlocker must explain why CI replay is not_replayable.',
    ])
  })

  it('rejects a conclusive CI status when replay is unavailable', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring.status = 'fail'

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.status must be skip or unknown when replayability is not_replayable.',
    ])
  })

  it('rejects a CI command nested inside CI discovery evidence', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring.ciWiringCommand = getCiWiringCommand()

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.ciWiringCommand is misplaced; use frameworks[0].ciWiringCommand.',
    ])
  })
})

function getCiWiring () {
  return {
    status: 'unknown',
    replayability: 'replayable',
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
          maxTestCount: 50,
        },
        ciWiring: {
          status: 'skip',
          replayability: 'not_replayable',
          replayBlocker: 'No replayable CI test command was selected for this fixture.',
          reason: 'No replayable CI test command was selected for this fixture.',
        },
        ...frameworkFields,
      },
    ],
  }
}
