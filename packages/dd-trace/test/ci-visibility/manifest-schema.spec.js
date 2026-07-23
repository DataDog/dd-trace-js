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
        command: 'npm test',
        diagnosis: 'CI initialization evidence has not been completed.',
        initialization: { status: 'unknown', evidence: [] },
      },
      ...frameworkFields,
    }],
  }
}
