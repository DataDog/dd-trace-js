'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateManifest } = require('../../../../ci/test-optimization-validation/manifest-schema')

describe('test optimization validation manifest schema', () => {
  it('requires unique framework ids', () => {
    const manifest = getManifest()
    manifest.frameworks.push({ ...manifest.frameworks[0] })

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[1].id must be unique; duplicate "mocha:root".',
    ])
  })

  it('requires runnable entries to include preflight evidence', () => {
    const manifest = getManifest()
    delete manifest.frameworks[0].preflight

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].preflight must be an object.',
    ])
  })

  it('requires non-runnable entries to explain why they cannot run', () => {
    const manifest = getManifest({
      status: 'requires_manual_setup',
      notes: [],
    })
    delete manifest.frameworks[0].existingTestCommand
    delete manifest.frameworks[0].preflight

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].notes must include a reason when status is requires_manual_setup.',
    ])
  })

  it('requires generated paths and identity files to be absolute', () => {
    const manifest = getManifest()
    manifest.frameworks[0].project.packageJson = 'package.json'
    manifest.frameworks[0].project.configFiles = ['mocha.config.js']
    manifest.frameworks[0].generatedTestStrategy = {
      status: 'verified',
      testDirectory: 'test',
      files: [
        {
          path: 'test/generated.test.js',
          contentLines: ['it("passes", function () {})', 1],
        },
      ],
      scenarios: [
        {
          id: 'basic-pass',
          runCommand: getCommand(),
          testIdentities: [
            {
              name: 'passes',
              file: 'test/generated.test.js',
            },
          ],
        },
        {
          id: 'atr-fail-once',
          runCommand: getCommand(),
        },
        {
          id: 'test-management-target',
          runCommand: getCommand(),
        },
      ],
      cleanupPaths: ['test/generated.test.js'],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].project.packageJson must be an absolute path when present.',
      'frameworks[0].project.configFiles[0] must be an absolute path.',
      'frameworks[0].generatedTestStrategy.files[0].path must be an absolute path.',
      'frameworks[0].generatedTestStrategy.files[0].contentLines[1] must be a string.',
      'frameworks[0].generatedTestStrategy.scenarios[0].testIdentities[0].file must be an absolute path ' +
        'when present.',
      'frameworks[0].generatedTestStrategy.testDirectory must be an absolute path when present.',
      'frameworks[0].generatedTestStrategy.cleanupPaths[0] must be an absolute path.',
    ])
  })

  it('requires verified generated strategies to include every validation scenario', () => {
    const manifest = getManifest()
    manifest.frameworks[0].generatedTestStrategy = {
      status: 'verified',
      files: [
        {
          path: '/repo/test/dd-test-optimization-validation.test.js',
          contentLines: ['it("passes", function () {})'],
        },
      ],
      scenarios: [
        {
          id: 'basic-pass',
          runCommand: getCommand(),
        },
      ],
      cleanupPaths: ['/repo/test/dd-test-optimization-validation.test.js'],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].generatedTestStrategy.scenarios must include generated scenario "atr-fail-once" ' +
        'when status is verified.',
      'frameworks[0].generatedTestStrategy.scenarios must include generated scenario "test-management-target" ' +
        'when status is verified.',
    ])
  })
})

function getManifest (frameworkOverrides = {}) {
  const root = '/repo'
  return {
    schemaVersion: '1.0',
    repository: {
      root,
    },
    environment: {},
    frameworks: [
      {
        id: 'mocha:root',
        framework: 'mocha',
        status: 'runnable',
        project: {
          root,
          packageJson: path.join(root, 'package.json'),
          configFiles: [],
        },
        existingTestCommand: getCommand(),
        preflight: {
          ran: true,
          exitCode: 0,
        },
        notes: [],
        ...frameworkOverrides,
      },
    ],
  }
}

function getCommand () {
  return {
    cwd: '/repo',
    argv: ['npm', 'test'],
  }
}
