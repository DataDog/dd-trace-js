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
      assert.strictEqual(command.env.TS_NODE_PROJECT, 'test/tsconfig.json')
      assert.ok(framework.project.configFiles.includes(path.join(fixture.root, 'test', 'tsconfig.json')))
      assert.ok(framework.project.configFiles.includes(fs.realpathSync(loader)))
    } finally {
      removeFixture(fixture.root)
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
      assert.strictEqual(getBasicCommand(framework).argv[1], fs.realpathSync(wrapper))
      assert.match(framework.notes.join(' '), /repository test wrapper/)
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

  it('keeps Jest suffixes and disables retained leak detection for generated checks', () => {
    const fixture = createRepositoryFixture({
      framework: 'jest',
      script: 'jest tests_jest --detectLeaks',
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
      assert.ok(command.argv.includes('--detectLeaks'))
      assert.ok(command.argv.includes('--detectLeaks=false'))
    } finally {
      removeFixture(fixture.root)
    }
  })

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
      assert.match(framework.generatedTestStrategy.scenarios[0].testIdentities[0].file, /\.test\.js$/)
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
