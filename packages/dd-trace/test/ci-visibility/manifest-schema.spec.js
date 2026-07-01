'use strict'

const assert = require('node:assert/strict')

const { validateManifest } = require('../../../../ci/test-optimization-validation/manifest-schema')

describe('test optimization validation manifest schema', () => {
  it('rejects unresolved placeholders in executable command env', () => {
    const errors = validateManifest(getManifest({
      ciWiringCommand: {
        cwd: '/repo',
        argv: ['npm', 'test'],
        env: {
          NODE_OPTIONS: '${NODE_OPTIONS}',
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
        argv: ['npm', 'test', '--', '${TEST_FILE}'],
      },
    }))

    assert.deepStrictEqual(errors, [
      'frameworks[0].forcedLocalCommand.argv[3] contains an unresolved placeholder. ' +
        'Resolve it before live validation.',
    ])
  })
})

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
        ...frameworkFields,
      },
    ],
  }
}
