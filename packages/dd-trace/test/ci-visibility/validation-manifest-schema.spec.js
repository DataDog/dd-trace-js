'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const jsonSchema = require('../../../../ci/test-optimization-validation-manifest.schema.json')
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
          expectedWithoutDatadog: getExpectedOutcome(0),
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
          expectedWithoutDatadog: getExpectedOutcome(1),
        },
        {
          id: 'test-management-target',
          runCommand: getCommand(),
          expectedWithoutDatadog: getExpectedOutcome(0),
          testIdentities: [],
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
      'frameworks[0].generatedTestStrategy.scenarios[1].testIdentities must be a non-empty array when ' +
        'generatedTestStrategy is planned or verified.',
      'frameworks[0].generatedTestStrategy.scenarios[2].testIdentities must be a non-empty array when ' +
        'generatedTestStrategy is planned or verified.',
      'frameworks[0].generatedTestStrategy.testDirectory must be an absolute path when present.',
      'frameworks[0].generatedTestStrategy.cleanupPaths[0] must be an absolute path.',
    ])
  })

  it('publishes absolute-path constraints for path fields in the JSON schema', () => {
    const absolutePathRef = { $ref: '#/$defs/absolutePathString' }
    const nullableAbsolutePath = {
      anyOf: [
        absolutePathRef,
        { type: 'null' },
      ],
    }

    assert.deepStrictEqual(jsonSchema.$defs.repository.properties.root, absolutePathRef)
    assert.deepStrictEqual(jsonSchema.$defs.project.properties.root, absolutePathRef)
    assert.deepStrictEqual(jsonSchema.$defs.project.properties.packageJson, nullableAbsolutePath)
    assert.deepStrictEqual(jsonSchema.$defs.project.properties.configFiles.items, absolutePathRef)
    assert.deepStrictEqual(jsonSchema.$defs.command.properties.cwd, absolutePathRef)
    assert.deepStrictEqual(jsonSchema.$defs.generatedTestStrategy.properties.testDirectory, nullableAbsolutePath)
    assert.deepStrictEqual(jsonSchema.$defs.generatedTestStrategy.properties.cleanupPaths.items, absolutePathRef)
    assert.deepStrictEqual(jsonSchema.$defs.generatedFile.properties.path, absolutePathRef)
    assert.deepStrictEqual(jsonSchema.$defs.testIdentity.properties.file, nullableAbsolutePath)
  })

  it('publishes runtime conditional requirements in the JSON schema', () => {
    const frameworkAllOf = jsonSchema.$defs.framework.allOf
    const commandAllOf = jsonSchema.$defs.command.allOf

    assert.ok(frameworkAllOf.some(condition => {
      return condition.if?.properties?.status?.enum?.includes('requires_manual_setup') &&
        condition.then?.required?.includes('notes') &&
        condition.then?.properties?.notes?.minItems === 1
    }))
    assert.ok(commandAllOf.some(condition => {
      return condition.if?.properties?.usesShell?.const === true &&
        condition.if?.required?.includes('usesShell') &&
        condition.then?.required?.includes('shellCommand')
    }))
    assert.ok(frameworkAllOf.some(condition => {
      return condition.if?.properties?.ciWiring?.properties?.status?.enum?.includes('fail') &&
        condition.then?.required?.includes('ciWiringCommand')
    }))
    assert.deepStrictEqual(jsonSchema.$defs.expectedWithoutDatadog.required, [
      'exitCode',
      'observedTestCount',
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
          expectedWithoutDatadog: getExpectedOutcome(0),
        },
      ],
      cleanupPaths: ['/repo/test/dd-test-optimization-validation.test.js'],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].generatedTestStrategy.scenarios must include generated scenario "atr-fail-once" ' +
        'when status is planned or verified.',
      'frameworks[0].generatedTestStrategy.scenarios must include generated scenario "test-management-target" ' +
        'when status is planned or verified.',
      'frameworks[0].generatedTestStrategy.scenarios[0].testIdentities must be a non-empty array when ' +
        'generatedTestStrategy is planned or verified.',
    ])
  })

  it('allows proposed generated strategies without test identities', () => {
    const manifest = getManifest()
    manifest.frameworks[0].generatedTestStrategy = {
      status: 'proposed',
      reason: 'The selected runner cannot focus generated tests yet.',
      scenarios: [
        {
          id: 'basic-pass',
          runCommand: getCommand(),
        },
      ],
    }

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  it('requires runnable frameworks to classify CI wiring explicitly', () => {
    const manifest = getManifest()
    delete manifest.frameworks[0].ciWiring

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring must be an object.',
    ])
  })

  it('requires replayable failed CI wiring to include its command', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring = { status: 'fail' }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiringCommand is required when ciWiring.status is fail.',
    ])
  })

  it('requires verified generated commands to isolate one scenario with the expected exit code', () => {
    const manifest = getManifest()
    manifest.frameworks[0].generatedTestStrategy = {
      status: 'verified',
      files: [],
      cleanupPaths: [],
      scenarios: [
        getGeneratedScenario('basic-pass', 1, 3),
        getGeneratedScenario('atr-fail-once', 0, 3),
        getGeneratedScenario('test-management-target', 0, 3),
      ],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].generatedTestStrategy.scenarios[0].expectedWithoutDatadog.exitCode must be 0 for basic-pass.',
      'frameworks[0].generatedTestStrategy.scenarios[0].expectedWithoutDatadog.observedTestCount must be 1 so ' +
        'the command isolates this scenario.',
      'frameworks[0].generatedTestStrategy.scenarios[1].expectedWithoutDatadog.exitCode must be 1 for ' +
        'atr-fail-once.',
      'frameworks[0].generatedTestStrategy.scenarios[1].expectedWithoutDatadog.observedTestCount must be 1 so ' +
        'the command isolates this scenario.',
      'frameworks[0].generatedTestStrategy.scenarios[2].expectedWithoutDatadog.observedTestCount must be 1 so ' +
        'the command isolates this scenario.',
    ])
  })

  it('accepts complete generated strategies that the validator will verify', () => {
    const manifest = getManifest()
    manifest.frameworks[0].generatedTestStrategy = {
      status: 'planned',
      files: [],
      cleanupPaths: [],
      scenarios: [
        getGeneratedScenario('basic-pass', 0, 1),
        getGeneratedScenario('atr-fail-once', 1, 1),
        getGeneratedScenario('test-management-target', 0, 1),
      ],
    }

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  it('requires CI command metadata and matching working directories', () => {
    const manifest = getManifest()
    manifest.frameworks[0].ciWiring = {
      status: 'unknown',
      reason: 'Replayable command selected.',
    }
    manifest.frameworks[0].ciWiringCommand = {
      cwd: '/repo/packages/app',
      argv: ['npm', 'test'],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].ciWiring.provider must be a non-empty string.',
      'frameworks[0].ciWiring.configFile must be a non-empty string.',
      'frameworks[0].ciWiring.job must be a non-empty string.',
      'frameworks[0].ciWiring.step must be a non-empty string.',
      'frameworks[0].ciWiring.whySelected must be a non-empty string.',
      'frameworks[0].ciWiring.configFile must be an absolute path.',
      'frameworks[0].ciWiring.workingDirectory must be an absolute path.',
      'frameworks[0].ciWiringCommand.cwd must match frameworks[0].ciWiring.workingDirectory.',
    ])
  })

  it('requires validator-controlled commands to be free of Datadog initialization', () => {
    const manifest = getManifest()
    manifest.frameworks[0].existingTestCommand.env = {
      DD_API_KEY: 'placeholder',
      NODE_OPTIONS: '--max-old-space-size=4096 -r dd-trace/ci/init',
    }
    manifest.frameworks[0].forcedLocalCommand = {
      ...getCommand(),
      env: { DD_CIVISIBILITY_ENABLED: '1' },
    }
    manifest.frameworks[0].generatedTestStrategy = {
      status: 'proposed',
      reason: 'Scenario selection is not complete.',
      scenarios: [{
        id: 'basic-pass',
        runCommand: {
          ...getCommand(),
          env: { NODE_OPTIONS: '-r dd-trace/ci/init' },
        },
      }],
    }

    assert.deepStrictEqual(validateManifest(manifest), [
      'frameworks[0].existingTestCommand.env.DD_API_KEY must not configure Datadog initialization for local ' +
        'validation.',
      'frameworks[0].existingTestCommand.env.NODE_OPTIONS must not configure Datadog initialization for local ' +
        'validation.',
      'frameworks[0].forcedLocalCommand.env.DD_CIVISIBILITY_ENABLED must not configure Datadog initialization ' +
        'for local validation.',
      'frameworks[0].generatedTestStrategy.scenarios[0].runCommand.env.NODE_OPTIONS must not configure Datadog ' +
        'initialization for local validation.',
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
        ciWiring: {
          status: 'unknown',
          reason: 'No replayable CI command was identified.',
        },
        notes: [],
        ...frameworkOverrides,
      },
    ],
  }
}

function getGeneratedScenario (id, exitCode, observedTestCount) {
  return {
    id,
    runCommand: getCommand(),
    expectedWithoutDatadog: {
      exitCode,
      observedTestCount,
    },
    testIdentities: [{ name: id, file: `/repo/test/${id}.test.js` }],
  }
}

function getExpectedOutcome (exitCode) {
  return {
    exitCode,
    observedTestCount: 1,
  }
}

function getCommand () {
  return {
    cwd: '/repo',
    argv: ['npm', 'test'],
  }
}
