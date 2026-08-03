'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createManifestScaffold } = require('../../../../ci/test-optimization-validation/manifest-scaffold')
const { validateManifest } = require('../../../../ci/test-optimization-validation/manifest-schema')
const {
  cleanupGeneratedFiles,
  writeGeneratedFiles,
} = require('../../../../ci/test-optimization-validation/generated-files')
const {
  getBasicCommand,
  getGeneratedCommand,
  getManifestCommands,
} = require('../../../../ci/test-optimization-validation/runner-command')
const { getRunnerContract } = require('../../../../ci/test-optimization-validation/runner-contract')
const {
  FRAMEWORKS,
  createRepositoryFixture,
  removeFixture,
} = require('./validation-test-helpers')

describe('test optimization validation manifest scaffold', () => {
  for (const frameworkName of Object.keys(FRAMEWORKS)) {
    it(`creates a data-only direct-runner manifest for ${frameworkName}`, () => {
      const fixture = createRepositoryFixture({
        framework: frameworkName,
        script: 'node -e "throw new Error(\'package script must not execute\')"',
      })
      try {
        const manifest = createManifestScaffold({
          root: fixture.root,
          frameworks: new Set([frameworkName]),
        })
        const framework = manifest.frameworks[0]
        const basic = getBasicCommand(framework)

        assert.deepStrictEqual(validateManifest(manifest), [])
        assert.strictEqual(manifest.schemaVersion, '2.0')
        assert.strictEqual(framework.status, 'runnable')
        assert.strictEqual(framework.validation.runner, fs.realpathSync(fixture.runner))
        assert.strictEqual(framework.validation.selectorScope, 'bounded_direct_runner')
        assert.strictEqual(framework.validation.testFile, fixture.testFile)
        assert.deepStrictEqual(basic.argv.slice(0, 2), [process.execPath, fs.realpathSync(fixture.runner)])
        assert.ok(basic.argv.includes(fixture.testFile))
        assert.strictEqual(JSON.stringify(manifest).includes('package script must not execute'), false)
        assert.strictEqual(JSON.stringify(manifest).includes('"argv"'), false)
        assert.strictEqual(JSON.stringify(manifest).includes('"runCommand"'), false)
        assert.deepStrictEqual(
          framework.generatedTestStrategy.scenarios.map(scenario => scenario.id),
          ['basic-pass', 'atr-fail-once', 'test-management-target']
        )
        for (const scenario of framework.generatedTestStrategy.scenarios) {
          const command = getGeneratedCommand(framework, scenario)
          assert.strictEqual(command.argv[0], process.execPath)
          assert.strictEqual(command.argv[1], fs.realpathSync(fixture.runner))
          assert.ok(command.argv.includes(scenario.testIdentities[0].file))
        }
      } finally {
        removeFixture(fixture.root)
      }
    })
  }

  it('finds a real Cucumber feature instead of a lint script mentioning cucumber.js', () => {
    const fixture = createRepositoryFixture({
      framework: 'cucumber',
      script: "eslint 'src/**/*.js' cucumber.js",
    })
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(fixture.root, 'package.json')))
      packageJson.scripts.conformance = 'cucumber-js ./features/example.feature -p default'
      fs.writeFileSync(path.join(fixture.root, 'package.json'), `${JSON.stringify(packageJson)}\n`)
      fs.writeFileSync(path.join(fixture.root, 'features', 'a-support.feature'), 'Feature: support only\n')

      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['cucumber']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.strictEqual(framework.validation.testFile, fixture.testFile)
      assert.match(framework.validation.runner, /cucumber-js\.js$/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('rejects files visibly owned by another global-style runner', () => {
    const fixture = createRepositoryFixture({ framework: 'jest' })
    const vitestFile = path.join(fixture.root, 'test', 'a-vitest.test.js')
    fs.writeFileSync(vitestFile, "test('vitest', () => { vi.fn() })\n")
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      }).frameworks[0]

      assert.strictEqual(framework.validation.testFile, fixture.testFile)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('retains allowlisted Mocha loader configuration without executing the package script', () => {
    const fixture = createRepositoryFixture({
      framework: 'mocha',
      script: 'cross-env TS_NODE_PROJECT=test/tsconfig.json mocha -r ts-node/register "test/**/*.spec.js" -R dot',
    })
    const loader = path.join(fixture.root, 'node_modules', 'ts-node', 'register.js')
    fs.mkdirSync(path.dirname(loader), { recursive: true })
    fs.writeFileSync(loader, 'void 0\n')
    fs.writeFileSync(path.join(fixture.root, 'test', 'tsconfig.json'), '{}\n')
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      }).frameworks[0]
      const command = getBasicCommand(framework)

      assert.deepStrictEqual(framework.validation.runnerArgs, ['-r', 'ts-node/register'])
      assert.deepStrictEqual(framework.validation.environment, { TS_NODE_PROJECT: 'test/tsconfig.json' })
      assert.deepStrictEqual(command.argv.slice(2, 4), ['-r', 'ts-node/register'])
      assert.deepStrictEqual(
        command.argv.slice(4, 9),
        ['--no-config', '--no-package', '--no-opts', '--reporter', 'spec']
      )
      assert.strictEqual(command.env.TS_NODE_PROJECT, 'test/tsconfig.json')
      assert.ok(framework.project.configFiles.includes(path.join(fixture.root, 'test', 'tsconfig.json')))
      assert.ok(framework.project.configFiles.includes(fs.realpathSync(loader)))
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('disables implicit Mocha config for representative and generated commands', () => {
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    fs.writeFileSync(path.join(fixture.root, '.mocharc.json'), JSON.stringify({
      spec: ['test/**/*.js'],
    }))
    const packageJsonPath = path.join(fixture.root, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath))
    packageJson.mocha = { spec: ['other-tests/**/*.js'] }
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson)}\n`)
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      }).frameworks[0]
      const generated = framework.generatedTestStrategy.scenarios[0]
      const commands = [
        [getBasicCommand(framework), framework.validation.testFile],
        [getGeneratedCommand(framework, generated), generated.testIdentities[0].file],
      ]

      assert.strictEqual(framework.status, 'runnable')
      for (const [command, expectedTestFile] of commands) {
        assert.ok(command.argv.includes('--no-config'))
        assert.ok(command.argv.includes('--no-package'))
        assert.ok(command.argv.includes('--no-opts'))
        assert.strictEqual(command.argv.at(-1), expectedTestFile)
      }
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('requires setup instead of retaining an explicit Mocha config', () => {
    const fixture = createRepositoryFixture({
      framework: 'mocha',
      script: 'mocha --config .mocharc.json test/example.spec.js',
    })
    fs.writeFileSync(path.join(fixture.root, '.mocharc.json'), '{}\n')
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes.join('\n'), /--config has configuration semantics/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('normalizes bounded Vitest mode options and discloses the omission', () => {
    const fixture = createRepositoryFixture({
      framework: 'vitest',
      script: 'vitest --run --typecheck test/example.test.js',
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['vitest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.deepStrictEqual(framework.validation.runnerArgs, [])
      assert.deepStrictEqual(framework.validation.omittedRunnerOptions, ['--run', '--typecheck'])
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('rejects non-English Cucumber generation instead of interpreting localized Gherkin', () => {
    const fixture = createRepositoryFixture({
      framework: 'cucumber',
      script: 'cucumber-js --language fr features/example.feature',
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['cucumber']),
      }).frameworks[0]

      assert.notStrictEqual(framework.status, 'runnable')
      assert.match(framework.notes.join('\n'), /--language fr is not supported/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('retains Jest configuration from a JavaScript runner entrypoint', () => {
    const fixture = createRepositoryFixture({
      framework: 'jest',
      script: 'node ./node_modules/jest/bin/jest.js --config ./jest.special.json test/example.test.js',
    })
    const config = path.join(fixture.root, 'jest.special.json')
    fs.writeFileSync(config, '{}\n')
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.deepStrictEqual(framework.validation.runnerArgs, ['--config', './jest.special.json'])
      assert.ok(framework.project.configFiles.includes(config))
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('approval-binds an auto-discovered Jest JSON configuration', () => {
    const fixture = createRepositoryFixture({ framework: 'jest' })
    const config = path.join(fixture.root, 'jest.config.json')
    fs.writeFileSync(config, '{}\n')
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.ok(framework.project.configFiles.includes(config))
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('approval-binds a default Jest config beyond the bounded discovery window', () => {
    const fixture = createRepositoryFixture({ framework: 'jest' })
    const config = path.join(fixture.root, 'jest.config.js')
    for (let index = 0; index < 1_025; index++) {
      fs.writeFileSync(path.join(fixture.root, `a-${String(index).padStart(4, '0')}.txt`), '')
    }
    fs.writeFileSync(config, 'module.exports = {}\n')
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.ok(framework.project.configFiles.includes(fs.realpathSync(config)))
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('retains a built-in Mocha interface without treating it as a code-loading input', () => {
    const fixture = createRepositoryFixture({
      framework: 'mocha',
      script: 'mocha --ui bdd test/example.spec.js',
    })
    try {
      const manifest = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      })
      const framework = manifest.frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.deepStrictEqual(framework.validation.runnerArgs, ['--ui', 'bdd'])
      assert.deepStrictEqual(validateManifest(manifest), [])
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('does not retain a custom Mocha interface outside the repository', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-outside-ui-')))
    const ui = path.join(outside, 'ui.js')
    fs.writeFileSync(ui, 'module.exports = () => {}\n')
    const fixture = createRepositoryFixture({
      framework: 'mocha',
      script: `mocha --ui ${ui} test/example.spec.js`,
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /resolves outside the repository/)
      assert.strictEqual(framework.validation, undefined)
    } finally {
      removeFixture(fixture.root)
      fs.rmSync(outside, { force: true, recursive: true })
    }
  })

  it('does not retain a runner preload outside the repository', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-outside-loader-')))
    const preload = path.join(outside, 'preload.js')
    fs.writeFileSync(preload, 'void 0\n')
    const fixture = createRepositoryFixture({
      framework: 'mocha',
      script: `mocha --require ${preload} test/example.spec.js`,
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /resolves outside the repository/)
      assert.strictEqual(framework.validation, undefined)
    } finally {
      removeFixture(fixture.root)
      fs.rmSync(outside, { force: true, recursive: true })
    }
  })

  it('uses an exact repository-contained Node test wrapper', () => {
    const fixture = createRepositoryFixture({
      framework: 'jest',
      script: 'node ./scripts/jest-cli.js',
    })
    const wrapper = path.join(fixture.root, 'scripts', 'jest-cli.js')
    fs.mkdirSync(path.dirname(wrapper), { recursive: true })
    fs.writeFileSync(wrapper, 'void 0\n')
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      }).frameworks[0]

      assert.strictEqual(framework.validation.runner, fs.realpathSync(wrapper))
      assert.strictEqual(framework.validation.selectorScope, 'instrumented_event_identity')
      assert.strictEqual(getBasicCommand(framework).argv[1], fs.realpathSync(wrapper))
      assert.match(framework.notes.join(' '), /repository test wrapper/)
      assert.match(framework.notes.join(' '), /captured test events identify only/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('uses the representative filename convention for generated tests', () => {
    const fixture = createRepositoryFixture({ framework: 'vitest', script: 'vitest run' })
    const representative = path.join(fixture.root, 'src', 'add', 'test.ts')
    fs.rmSync(fixture.testFile)
    fs.mkdirSync(path.dirname(representative), { recursive: true })
    fs.writeFileSync(representative, "import { test } from 'vitest'\ntest('works', () => {})\n")
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['vitest']),
      }).frameworks[0]
      const generated = framework.generatedTestStrategy.scenarios[0].testIdentities[0].file

      assert.strictEqual(framework.validation.testFile, representative)
      assert.strictEqual(
        generated,
        path.join(fixture.root, 'src', 'dd-test-optimization-validation-vitest-basic-pass', 'test.ts')
      )
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('rejects a bare source test without an explicit framework import or test directory', () => {
    const fixture = createRepositoryFixture({ framework: 'vitest', script: 'vitest run' })
    const sourceTest = path.join(fixture.root, 'src', 'runners', 'test.ts')
    fs.rmSync(fixture.testFile)
    fs.mkdirSync(path.dirname(sourceTest), { recursive: true })
    fs.writeFileSync(sourceTest, "test('source helper', () => {})\n")
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['vitest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /No single Vitest test file/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  for (const [frameworkName, relativeTest] of [
    ['vitest', 'test/types/compose.test-d.ts'],
    ['jest', 'typetests/jest.test.ts'],
  ]) {
    it(`rejects the type-only representative ${relativeTest}`, () => {
      const fixture = createRepositoryFixture({ framework: frameworkName, script: frameworkName })
      const typeTest = path.join(fixture.root, relativeTest)
      fs.rmSync(fixture.testFile)
      fs.mkdirSync(path.dirname(typeTest), { recursive: true })
      fs.writeFileSync(typeTest, "test('type-only', () => {})\n")
      try {
        const framework = createManifestScaffold({
          root: fixture.root,
          frameworks: new Set([frameworkName]),
        }).frameworks[0]

        assert.strictEqual(framework.status, 'requires_manual_setup')
        assert.match(framework.notes[0], /No single/)
      } finally {
        removeFixture(fixture.root)
      }
    })
  }

  it('selects a conventional runtime test instead of a nearby type-only file', () => {
    const fixture = createRepositoryFixture({ framework: 'vitest', script: 'vitest run' })
    const runtimeTest = path.join(fixture.root, 'src', 'compose.test.ts')
    const typeTest = path.join(fixture.root, 'src', 'compose.test-d.ts')
    fs.rmSync(fixture.testFile)
    fs.mkdirSync(path.dirname(runtimeTest), { recursive: true })
    fs.writeFileSync(runtimeTest, "test('runtime', () => {})\n")
    fs.writeFileSync(typeTest, "test('type-only', () => {})\n")
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['vitest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.strictEqual(framework.validation.testFile, runtimeTest)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('marks retained Vitest browser mode as browser-required', () => {
    const fixture = createRepositoryFixture({
      framework: 'vitest',
      script: 'vitest run --browser',
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['vitest']),
      }).frameworks[0]

      assert.strictEqual(framework.browserRequired, true)
      assert.deepStrictEqual(framework.validation.runnerArgs, ['--browser'])
      assert.strictEqual(framework.validation.timeoutMs, 300_000)
    } finally {
      removeFixture(fixture.root)
    }
  })

  for (const rootOption of ['--root packages/foo', '--root=packages/foo']) {
    it(`selects the representative inside the retained Vitest ${rootOption}`, () => {
      const fixture = createRepositoryFixture({
        framework: 'vitest',
        script: `vitest run ${rootOption}`,
      })
      const selected = path.join(fixture.root, 'packages', 'foo', 'src', 'selected.test.ts')
      const outside = path.join(fixture.root, 'src', 'outside.test.ts')
      fs.rmSync(fixture.testFile)
      fs.mkdirSync(path.dirname(selected), { recursive: true })
      fs.mkdirSync(path.dirname(outside), { recursive: true })
      fs.writeFileSync(selected, "test('selected', () => {})\n")
      fs.writeFileSync(outside, "test('outside', () => {})\n")
      try {
        const framework = createManifestScaffold({
          root: fixture.root,
          frameworks: new Set(['vitest']),
        }).frameworks[0]

        assert.strictEqual(framework.status, 'runnable')
        assert.strictEqual(framework.validation.testFile, selected)
        assert.ok(framework.validation.runnerArgs.includes('--root') ||
          framework.validation.runnerArgs.includes('--root=packages/foo'))
      } finally {
        removeFixture(fixture.root)
      }
    })
  }

  it('keeps Jest suffixes and disables retained leak detection for generated checks', () => {
    const fixture = createRepositoryFixture({
      framework: 'jest',
      script: 'jest tests_jest --detectLeaks=true',
    })
    const representative = path.join(fixture.root, 'tests_jest', 'memory_leak.spec.js')
    fs.rmSync(fixture.testFile)
    fs.mkdirSync(path.dirname(representative), { recursive: true })
    fs.writeFileSync(representative, "test('works', () => {})\n")
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      }).frameworks[0]
      const scenario = framework.generatedTestStrategy.scenarios[0]
      const command = getGeneratedCommand(framework, scenario)

      assert.match(scenario.testIdentities[0].file, /\.spec\.js$/)
      assert.ok(command.argv.includes('--detectLeaks=true'))
      assert.ok(command.argv.includes('--detectLeaks=false'))
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('requires setup instead of interpreting Jest projects', () => {
    const fixture = createRepositoryFixture({
      framework: 'jest',
      script: 'jest --projects packages/app',
    })
    const selected = path.join(fixture.root, 'packages', 'app', 'example.test.js')
    fs.rmSync(fixture.testFile)
    fs.mkdirSync(path.dirname(selected), { recursive: true })
    fs.writeFileSync(selected, "test('works', () => {})\n")
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /--projects/)
      assert.strictEqual(framework.validation, undefined)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('retains Cypress configuration for generated checks', () => {
    const fixture = createRepositoryFixture({
      framework: 'cypress',
      script: 'cypress run --spec cypress/e2e/example.cy.js --browser chrome --config-file cypress.custom.js --e2e',
    })
    fs.writeFileSync(path.join(fixture.root, 'cypress.custom.js'), 'module.exports = {}\n')
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['cypress']),
      }).frameworks[0]
      const scenario = framework.generatedTestStrategy.scenarios[0]
      const command = getGeneratedCommand(framework, scenario)

      assert.deepStrictEqual(framework.validation.runnerArgs, [
        '--browser',
        'chrome',
        '--config-file',
        'cypress.custom.js',
        '--e2e',
      ])
      assert.strictEqual(framework.validation.testFile, fixture.testFile)
      assert.strictEqual(framework.validation.runnerArgs.includes('--spec'), false)
      assert.deepStrictEqual(command.argv.slice(2, 8), [
        'run',
        '--browser',
        'chrome',
        '--config-file',
        'cypress.custom.js',
        '--e2e',
      ])
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('requires setup instead of interpreting Cypress inline configuration', () => {
    const fixture = createRepositoryFixture({
      framework: 'cypress',
      script: 'cypress run --config baseUrl=http://localhost:3000 --browser chrome',
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['cypress']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /--config/)
      assert.strictEqual(framework.validation, undefined)
    } finally {
      removeFixture(fixture.root)
    }
  })

  for (const [frameworkName, script, option] of [
    ['jest', 'jest --setupFilesAfterEnv ./test/setup.js test/example.test.js', '--setupFilesAfterEnv'],
    ['cypress', 'cypress run --env apiUrl=http://localhost:8080', '--env'],
  ]) {
    it(`requires setup instead of dropping ${frameworkName} option ${option}`, () => {
      const fixture = createRepositoryFixture({
        framework: frameworkName,
        script,
      })
      try {
        const framework = createManifestScaffold({
          root: fixture.root,
          frameworks: new Set([frameworkName]),
        }).frameworks[0]

        assert.strictEqual(framework.status, 'requires_manual_setup')
        assert.match(framework.notes[0], new RegExp(option))
        assert.match(framework.notes[0], /not preserved/)
        assert.strictEqual(framework.validation, undefined)
      } finally {
        removeFixture(fixture.root)
      }
    })
  }

  it('requires setup when every Cypress representative needs a localhost application', () => {
    const fixture = createRepositoryFixture({
      framework: 'cypress',
      testSource: [
        "describe('kitchensink', () => {",
        "  it('loads the app', () => cy.visit('http://localhost:8080/commands/actions'))",
        '})',
      ].join('\n'),
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['cypress']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /localhost application/)
      assert.match(framework.notes[0], /discovery will not start/)
      assert.strictEqual(framework.validation, undefined)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('prefers a self-contained Cypress spec over one requiring localhost', () => {
    const fixture = createRepositoryFixture({
      framework: 'cypress',
      testSource: "it('loads the app', () => cy.visit('http://127.0.0.1:8080'))\n",
    })
    const selfContained = path.join(fixture.root, 'cypress', 'e2e', 'unit.cy.js')
    fs.writeFileSync(selfContained, "it('works', () => expect(true).to.equal(true))\n")
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['cypress']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.strictEqual(framework.validation.testFile, selfContained)
    } finally {
      removeFixture(fixture.root)
    }
  })

  for (const value of ['$NODE_ENV', '$' + '{NODE_ENV}', '$?', '%NODE_ENV%', '!NODE_ENV!']) {
    it(`rejects dynamic runner environment assignment ${value}`, () => {
      const fixture = createRepositoryFixture({
        framework: 'mocha',
        script: `NODE_ENV=${value} mocha test/example.spec.js`,
      })
      try {
        const framework = createManifestScaffold({
          root: fixture.root,
          frameworks: new Set(['mocha']),
        }).frameworks[0]

        assert.strictEqual(framework.status, 'requires_manual_setup')
        assert.match(framework.notes[0], /runner environment contains an unsafe value for NODE_ENV/)
      } finally {
        removeFixture(fixture.root)
      }
    })
  }

  it('requires setup instead of dropping env wrapper options', () => {
    const fixture = createRepositoryFixture({
      framework: 'jest',
      script: 'env -C packages/app jest test/example.test.js',
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /runner launch wrapper contains options or positional arguments/)
      assert.strictEqual(framework.validation, undefined)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('requires setup instead of dropping an unrecognized runner launcher', () => {
    const fixture = createRepositoryFixture({
      framework: 'jest',
      script: 'dotenvx run -- jest test/example.test.js',
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /runner launch wrapper dotenvx is not allowlisted/)
      assert.strictEqual(framework.validation, undefined)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('canonicalizes allowlisted runner environment names using Windows semantics', () => {
    const contract = getRunnerContract(
      'jest',
      'cross-env ci=true jest test/example.test.js',
      process.cwd(),
      process.cwd(),
      'win32'
    )

    assert.deepStrictEqual(contract.environment, { CI: 'true' })
    assert.strictEqual(contract.error, undefined)
  })

  for (const selector of ['$SPEC', '%SPEC%', '!SPEC!']) {
    it(`requires setup instead of dropping shell-expanded selector ${selector}`, () => {
      const fixture = createRepositoryFixture({
        framework: 'jest',
        script: `jest ${selector}`,
      })
      try {
        const framework = createManifestScaffold({
          root: fixture.root,
          frameworks: new Set(['jest']),
        }).frameworks[0]

        assert.strictEqual(framework.status, 'requires_manual_setup')
        assert.match(framework.notes[0], /runner command contains shell-expanded values/)
        assert.strictEqual(framework.validation, undefined)
      } finally {
        removeFixture(fixture.root)
      }
    })
  }

  it('selects non-suffixed Mocha files from a literal test root', () => {
    const fixture = createRepositoryFixture({
      framework: 'mocha',
      script: 'c8 mocha --enable-source-maps ./test/*.mjs --require ./test/before.mjs --timeout=24000 --check-leaks',
    })
    const representative = path.join(fixture.root, 'test', 'obj-filter.mjs')
    fs.rmSync(fixture.testFile)
    fs.writeFileSync(path.join(fixture.root, 'test', 'before.mjs'), 'void 0\n')
    fs.writeFileSync(representative, "describe('example', () => { it('works', () => {}) })\n")
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      }).frameworks[0]

      assert.strictEqual(framework.validation.testFile, representative)
      assert.deepStrictEqual(framework.validation.runnerArgs, [
        '--enable-source-maps',
        '--require',
        './test/before.mjs',
        '--timeout=24000',
        '--check-leaks',
      ])
      assert.ok(framework.project.configFiles.includes(path.join(fixture.root, 'test', 'before.mjs')))
      assert.match(framework.generatedTestStrategy.scenarios[0].testIdentities[0].file, /\.test\.mjs$/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('reports setup required when the installed runner is missing', () => {
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    try {
      fs.rmSync(path.dirname(path.dirname(fixture.runner)), { force: true, recursive: true })
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /executable is unavailable/)
      assert.strictEqual(framework.validation, undefined)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('reports setup required when no single owned test file is available', () => {
    const fixture = createRepositoryFixture({
      framework: 'vitest',
      testSource: "const { test } = require('node:test')\ntest('wrong runner', () => {})\n",
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['vitest']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /No single Vitest test file/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('records localhost as a prerequisite without rejecting the test', () => {
    const fixture = createRepositoryFixture({
      framework: 'mocha',
      testSource: [
        "const http = require('node:http')",
        "describe('server', () => { it('works', () => http.createServer().listen(0)) })",
      ].join('\n'),
    })
    try {
      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.strictEqual(framework.localSocketRequired, true)
      assert.match(framework.notes.join(' '), /require localhost/)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('discovers CI files but leaves interpretation incomplete', () => {
    const fixture = createRepositoryFixture({
      framework: 'jest',
      ciSource: [
        'jobs:',
        '  test:',
        '    steps:',
        '      - run: npx jest --runTestsByPath test/example.test.js',
      ].join('\n'),
    })
    try {
      const manifest = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      })
      const ci = manifest.frameworks[0].ciWiring

      assert.deepStrictEqual(manifest.ciDiscovery.reviewTargets, ['.github/workflows/test.yml'])
      assert.strictEqual(ci.reviewComplete, false)
      assert.strictEqual(ci.initialization.status, 'unknown')
      assert.ok(ci.unresolved.length > 0)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('ranks test-named workflows ahead of alphabetically earlier ones', () => {
    const fixture = createRepositoryFixture({
      framework: 'jest',
      ciSource: ['jobs:', '  test:', '    steps:', '      - run: npx jest'].join('\n'),
    })
    try {
      const workflows = path.join(fixture.root, '.github', 'workflows')
      fs.writeFileSync(path.join(workflows, 'audit.yml'), 'jobs:\n  audit:\n    steps: []\n')
      fs.writeFileSync(path.join(workflows, 'release.yml'), 'jobs:\n  release:\n    steps: []\n')

      const manifest = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['jest']),
      })

      assert.deepStrictEqual(manifest.ciDiscovery.found, [
        '.github/workflows/audit.yml',
        '.github/workflows/release.yml',
        '.github/workflows/test.yml',
      ])
      assert.deepStrictEqual(manifest.ciDiscovery.reviewTargets, [
        '.github/workflows/test.yml',
        '.github/workflows/audit.yml',
        '.github/workflows/release.yml',
      ])
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('does not accept a runner that physically resolves outside the repository', () => {
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-external-runner-'))
    try {
      const packageRoot = path.dirname(path.dirname(fixture.runner))
      fs.rmSync(packageRoot, { force: true, recursive: true })
      fs.symlinkSync(external, packageRoot, 'dir')

      const framework = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
    } finally {
      removeFixture(fixture.root)
      fs.rmSync(external, { force: true, recursive: true })
    }
  })

  it('scopes approval commands to the selected check', () => {
    const fixture = createRepositoryFixture({ framework: 'mocha' })
    try {
      const manifest = createManifestScaffold({
        root: fixture.root,
        frameworks: new Set(['mocha']),
      })

      assert.deepStrictEqual(getManifestCommands(manifest, 'ci-wiring'), [])
      assert.deepStrictEqual(
        getManifestCommands(manifest, 'efd').map(([id]) => id),
        [`${manifest.frameworks[0].id}:basic-reporting`, `${manifest.frameworks[0].id}:generated:basic-pass`]
      )
      assert.strictEqual(getManifestCommands(manifest, 'basic-reporting').length, 1)
      assert.strictEqual(getManifestCommands(manifest).length, 4)
    } finally {
      removeFixture(fixture.root)
    }
  })

  it('writes only the selected generated scenario and required adapter support', async () => {
    const fixture = createRepositoryFixture({ framework: 'cucumber' })
    const manifest = createManifestScaffold({
      root: fixture.root,
      frameworks: new Set(['cucumber']),
    })
    const framework = manifest.frameworks[0]
    const selected = framework.generatedTestStrategy.scenarios[0]

    try {
      const written = writeGeneratedFiles(framework, selected)
      assert.ok(written.includes(selected.testIdentities[0].file))
      assert.ok(written.some(filename => filename.endsWith('dd-test-optimization-validation.steps.cjs')))
      for (const scenario of framework.generatedTestStrategy.scenarios.slice(1)) {
        assert.strictEqual(fs.existsSync(scenario.testIdentities[0].file), false)
      }
    } finally {
      await cleanupGeneratedFiles(manifest)
      removeFixture(fixture.root)
    }
  })
})
