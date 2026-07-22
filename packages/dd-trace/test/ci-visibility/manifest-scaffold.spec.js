'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const jsonSchema = require('../../../../ci/test-optimization-validation-manifest.schema.json')
const { getCommandSuitabilityError } = require('../../../../ci/test-optimization-validation/command-suitability')
const { createManifestScaffold } = require('../../../../ci/test-optimization-validation/manifest-scaffold')
const { validateManifest } = require('../../../../ci/test-optimization-validation/manifest-schema')

describe('test optimization validation manifest scaffold', () => {
  it('creates a schema-valid Mocha scaffold without executing project code', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-'))
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const mochaRoot = path.dirname(require.resolve('mocha/package.json'))
    const marker = path.join(root, 'project-command-ran')
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(root, 'test'))
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
    fs.symlinkSync(mochaRoot, path.join(root, 'node_modules', 'mocha'), 'dir')
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'jobs: {}\n')
    fs.writeFileSync(path.join(root, 'test', 'unit.spec.js'), 'describe("suite", () => { it("unit", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'scaffold-project',
      devDependencies: { mocha: require('mocha/package.json').version },
      scripts: {
        pretest: `node -e "require('node:fs').writeFileSync('${marker}', 'ran')"`,
        test: 'mocha',
      },
    }))

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const manifest = createManifestScaffold({ root })

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(manifest.environment.os, 'windows')
      assert.ok(jsonSchema.$defs.environment.properties.os.enum.includes(manifest.environment.os))
      assert.strictEqual(manifest.repository.workspaceManager, 'pnpm')
      assert.ok(jsonSchema.$defs.repository.properties.workspaceManager.enum.includes(
        manifest.repository.workspaceManager
      ))
      assert.strictEqual(fs.existsSync(marker), false)
      assert.deepStrictEqual(manifest.ciDiscovery.found, ['.github/workflows/test.yml'])
      assert.deepStrictEqual(manifest.ciDiscovery.reviewTargets, ['.github/workflows/test.yml'])
      assert.strictEqual(manifest.ciDiscovery.reviewRequired, false)
      assert.strictEqual(manifest.frameworks.length, 1)
      assert.strictEqual(manifest.frameworks[0].framework, 'mocha')
      assert.strictEqual(manifest.frameworks[0].preflight.status, 'pending')
      assert.strictEqual(manifest.frameworks[0].preflight.maxTestCount, 150)
      assert.strictEqual(manifest.frameworks[0].localTestCandidates.length, 1)
      assert.strictEqual(manifest.frameworks[0].ciWiring.initialization.status, 'not_configured')
      assert.match(manifest.frameworks[0].ciWiring.initialization.evidence[0], /found no reference/)
      assert.strictEqual(manifest.frameworks[0].ciWiring.provider, 'github-actions')
      assert.strictEqual(
        manifest.frameworks[0].ciWiring.configFile,
        path.join(root, '.github', 'workflows', 'test.yml')
      )
      assert.match(manifest.frameworks[0].ciWiring.diagnosis, /No additional CI-file review is required/)
      assert.strictEqual(manifest.frameworks[0].existingTestCommand.argv[0], process.execPath)
      assert.match(manifest.frameworks[0].existingTestCommand.argv[1], /mocha/)
      assert.doesNotMatch(manifest.frameworks[0].existingTestCommand.argv.join(' '), /pnpm/)
      assert.deepStrictEqual(
        manifest.frameworks[0].generatedTestStrategy.scenarios.map(scenario => scenario.id),
        ['basic-pass', 'atr-fail-once', 'test-management-target']
      )
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps CI initialization unknown when a discovered workflow contains the preload', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-ci-init-'))
    const mochaRoot = path.dirname(require.resolve('mocha/package.json'))
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(root, 'test'))
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
    fs.symlinkSync(mochaRoot, path.join(root, 'node_modules', 'mocha'), 'dir')
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'test.yml'), [
      'jobs:',
      '  test:',
      '    steps:',
      '      - run: npm test',
      '        env:',
      '          NODE_OPTIONS: -r dd-trace/ci/init',
    ].join('\n'))
    fs.writeFileSync(path.join(root, 'test', 'unit.spec.js'), 'describe("suite", () => { it("unit", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'configured-project',
      devDependencies: { mocha: require('mocha/package.json').version },
      scripts: { test: 'mocha' },
    }))

    try {
      const manifest = createManifestScaffold({ root })

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.deepStrictEqual(manifest.ciDiscovery.reviewTargets, ['.github/workflows/test.yml'])
      assert.strictEqual(manifest.ciDiscovery.reviewRequired, true)
      assert.deepStrictEqual(manifest.frameworks[0].ciWiring.initialization, {
        status: 'unknown',
        evidence: [],
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the installed Vitest runner directly instead of bootstrapping the pinned pnpm version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-direct-vitest-'))
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    const representative = path.join(root, 'test', 'unit.test.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '4.0.5',
      bin: { vitest: 'bin.js' },
    }))
    fs.writeFileSync(representative, [
      'const fixture = "test(\\"string fixture\\", () => {})"',
      'const template = `test("template fixture", () => {})`',
      '// test("stale comment", () => {})',
      'test("unit", () => {})',
    ].join('\n'))
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'pnpm-vitest-project',
      packageManager: 'pnpm@10.20.0',
      devDependencies: { vitest: '4.0.5' },
      scripts: { test: 'vitest run' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.deepStrictEqual(framework.existingTestCommand.argv, [
        process.execPath,
        fs.realpathSync(path.join(runnerRoot, 'bin.js')),
        'run',
        representative,
      ])
      assert.ok(framework.generatedTestStrategy.scenarios.every(scenario => {
        return scenario.runCommand.argv[0] === process.execPath &&
          scenario.runCommand.argv[1] === fs.realpathSync(path.join(runnerRoot, 'bin.js'))
      }))
      assert.doesNotMatch(JSON.stringify(framework.existingTestCommand), /pnpm/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers the package matching the repository identity over an auxiliary package', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-primary-'))
    const root = path.join(parent, 'redux-toolkit')
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    const toolkitRoot = path.join(root, 'packages', 'toolkit')
    const codemodsRoot = path.join(root, 'packages', 'rtk-codemods')

    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.join(toolkitRoot, 'src'), { recursive: true })
    fs.mkdirSync(path.join(codemodsRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '4.0.5',
      bin: { vitest: 'bin.js' },
    }))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'rtk-monorepo',
      private: true,
      workspaces: ['packages/*'],
    }))
    fs.writeFileSync(path.join(toolkitRoot, 'package.json'), JSON.stringify({
      name: '@reduxjs/toolkit',
      devDependencies: { vitest: '4.0.5' },
      scripts: { test: 'vitest --typecheck --run' },
    }))
    fs.writeFileSync(path.join(codemodsRoot, 'package.json'), JSON.stringify({
      name: '@reduxjs/rtk-codemods',
      devDependencies: { vitest: '4.0.5' },
      scripts: { test: 'vitest --run' },
    }))
    fs.writeFileSync(path.join(toolkitRoot, 'vitest.config.mts'), [
      'export default {',
      "  test: { include: ['./src/**/*.(spec|test).[jt]s?(x)'] },",
      '}',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(toolkitRoot, 'src', 'toolkit.test.ts'), [
      "import { configureStore } from '@reduxjs/toolkit'",
      'test("toolkit", () => configureStore)',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(toolkitRoot, 'src', 'utils.spec.ts'), 'test("utils", () => {})\n')
    fs.writeFileSync(path.join(codemodsRoot, 'src', 'codemods.test.ts'), 'test("codemods", () => {})\n')

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks.find(entry => entry.framework === 'vitest')

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(framework.project.name, '@reduxjs/toolkit')
      assert.strictEqual(framework.project.root, toolkitRoot)
      assert.strictEqual(framework.localTestCandidates[0].sourceFile,
        path.join(toolkitRoot, 'src', 'utils.spec.ts'))
      assert.strictEqual(framework.existingTestCommand.argv[0], process.execPath)
      assert.doesNotMatch(framework.existingTestCommand.argv.join(' '), /yarn|typecheck/)
      assert.ok(framework.generatedTestStrategy.files.every(file => file.path.endsWith('.spec.ts')))
      for (const scenario of framework.generatedTestStrategy.scenarios) {
        assert.strictEqual(getCommandSuitabilityError({
          command: scenario.runCommand,
          framework,
          label: `the ${scenario.id} advanced-feature command`,
          repositoryRoot: root,
        }), undefined)
      }
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('uses the installed runner directly in a Yarn Classic project without a package script', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-yarn-classic-'))
    const runnerRoot = path.join(root, 'node_modules', 'mocha')
    const representative = path.join(root, 'test', 'unit.spec.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'mocha',
      version: '11.7.5',
      bin: { mocha: 'bin.js' },
    }))
    fs.writeFileSync(representative, 'describe("suite", () => { it("unit", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'yarn.lock'), '')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'yarn-classic-mocha-project',
      devDependencies: { mocha: '11.7.5' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.deepStrictEqual(framework.existingTestCommand.argv, [
        process.execPath,
        fs.realpathSync(path.join(runnerRoot, 'bin.js')),
        representative,
      ])
      assert.doesNotMatch(JSON.stringify(framework.existingTestCommand), /yarn exec/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the installed runner while preserving supported runner flags', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-runner-flags-'))
    const runnerRoot = path.join(root, 'node_modules', 'jest')
    const representative = path.join(root, 'test', 'unit.test.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'jest',
      version: '29.7.0',
      bin: { jest: 'bin.js' },
    }))
    fs.writeFileSync(representative, 'test("unit", () => {})\n')
    fs.writeFileSync(path.join(root, 'jest.validation.config.js'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'configured-jest-project',
      devDependencies: { jest: '29.7.0' },
      scripts: { test: 'jest --config ./jest.validation.config.js --env=jsdom' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.deepStrictEqual(framework.existingTestCommand.argv.slice(0, 6), [
        process.execPath,
        fs.realpathSync(path.join(runnerRoot, 'bin.js')),
        '--config',
        './jest.validation.config.js',
        '--env=jsdom',
        '--runTestsByPath',
      ])
      assert.ok(framework.existingTestCommand.argv.includes(representative))
      assert.ok(framework.generatedTestStrategy.scenarios.every(scenario => {
        return scenario.runCommand.argv[0] === process.execPath &&
          scenario.runCommand.argv[1] === fs.realpathSync(path.join(runnerRoot, 'bin.js')) &&
          scenario.runCommand.argv.includes('--env=jsdom') &&
          scenario.runCommand.argv.includes(scenario.testIdentities[0].file)
      }))
      assert.match(framework.notes.join('\n'), /invokes the installed jest runner directly/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces a broad wrapped Mocha glob with one file while preserving runner setup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-wrapped-mocha-'))
    const runnerRoot = path.join(root, 'node_modules', 'mocha')
    const representative = path.join(root, 'spec', 'unit.spec.ts')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'mocha',
      version: '11.7.5',
      bin: { mocha: 'bin.js' },
    }))
    fs.writeFileSync(representative, 'describe("suite", () => { it("unit", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'wrapped-mocha-project',
      devDependencies: { mocha: '11.7.5' },
      scripts: {
        test: 'cross-env TS_NODE_PROJECT=spec/tsconfig.json mocha -r ts-node/register "spec/**/*.spec.ts" -R dot',
      },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]
      const runner = fs.realpathSync(path.join(runnerRoot, 'bin.js'))

      assert.deepStrictEqual(framework.existingTestCommand.argv, [
        process.execPath,
        runner,
        '-r',
        'ts-node/register',
        representative,
      ])
      assert.deepStrictEqual(framework.existingTestCommand.env, { TS_NODE_PROJECT: 'spec/tsconfig.json' })
      assert.doesNotMatch(framework.existingTestCommand.argv.join(' '), /\*\*/)
      assert.ok(framework.generatedTestStrategy.scenarios.every(scenario => {
        return scenario.runCommand.argv[0] === process.execPath &&
          scenario.runCommand.argv[1] === runner &&
          scenario.runCommand.argv.includes('ts-node/register') &&
          scenario.runCommand.env.TS_NODE_PROJECT === 'spec/tsconfig.json'
      }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('unwraps c8 and replaces a broad Mocha glob while preserving Mocha behavior', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-c8-mocha-'))
    const runnerRoot = path.join(root, 'node_modules', 'mocha')
    const representative = path.join(root, 'test', 'unit.mjs')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'mocha',
      version: '11.7.6',
      bin: { mocha: 'bin.js' },
    }))
    fs.writeFileSync(representative, 'describe("suite", () => { it("unit", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'c8-mocha-project',
      devDependencies: { c8: '11.0.0', mocha: '11.7.6' },
      scripts: {
        test: 'c8 mocha --enable-source-maps ./test/*.mjs --require ./test/before.mjs ' +
          '--timeout=24000 --check-leaks',
      },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]
      const runner = fs.realpathSync(path.join(runnerRoot, 'bin.js'))

      assert.deepStrictEqual(framework.existingTestCommand.argv, [
        process.execPath,
        runner,
        '--enable-source-maps',
        '--require',
        './test/before.mjs',
        '--timeout=24000',
        '--check-leaks',
        representative,
      ])
      assert.ok(!framework.existingTestCommand.argv.includes('c8'))
      assert.doesNotMatch(framework.existingTestCommand.argv.join(' '), /\*/)
      assert.ok(framework.generatedTestStrategy.scenarios.every(scenario => {
        return scenario.runCommand.argv[0] === process.execPath &&
          scenario.runCommand.argv[1] === runner &&
          scenario.runCommand.argv.includes('--enable-source-maps') &&
          scenario.runCommand.argv.includes('./test/before.mjs') &&
          scenario.runCommand.argv.includes('--check-leaks')
      }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('selects conventional Mocha files inside a test directory without a spec suffix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-conventional-mocha-'))
    const runnerRoot = path.join(root, 'node_modules', 'mocha')
    const representative = path.join(root, 'test', 'body-parser.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'mocha',
      version: '11.7.5',
      bin: { mocha: 'bin.js' },
    }))
    fs.writeFileSync(representative, 'describe("suite", () => { it("unit", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'test', 'utils.js'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'conventional-mocha-project',
      devDependencies: { mocha: '11.7.5' },
      scripts: { test: 'mocha --reporter spec --check-leaks test/' },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.strictEqual(framework.localTestCandidates[0].sourceFile, representative)
      assert.ok(framework.existingTestCommand.argv.includes(representative))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not execute a nested package script whose pretest installs and removes dependencies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-lifecycle-setup-'))
    const runnerRoot = path.join(root, 'node_modules', 'jest')
    const nestedRoot = path.join(root, 'examples', 'node-jest')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(nestedRoot, { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'jest',
      version: '29.7.0',
      bin: { jest: 'bin.js' },
    }))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'nested-example-project',
      devDependencies: { jest: '29.7.0' },
      scripts: { 'examples:node:jest:test': 'cd examples/node-jest && npm test' },
    }))
    fs.writeFileSync(path.join(nestedRoot, 'package.json'), JSON.stringify({
      name: 'nested-jest-example',
      scripts: {
        pretest: 'rm -fr node_modules && npm install --no-package-lock',
        test: 'jest',
      },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes.join('\n'), /dependency install or recursive file removal/)
      assert.match(framework.notes.join('\n'), /Review and approve the setup separately/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses source-adjacent TSX tests as the generated-test convention', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-tsx-'))
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    const representative = path.join(root, 'src', 'App.test.tsx')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '4.0.5',
      bin: { vitest: 'bin.js' },
    }))
    fs.writeFileSync(representative, 'test("tsx", () => {})\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'tsx-vitest-project',
      devDependencies: { vitest: '4.0.5' },
      scripts: { test: 'vitest run' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(framework.language, 'typescript')
      assert.ok(framework.existingTestCommand.argv.includes(representative))
      assert.strictEqual(framework.generatedTestStrategy.fileExtension, '.test.tsx')
      assert.strictEqual(framework.generatedTestStrategy.testDirectory, path.dirname(representative))
      assert.ok(framework.generatedTestStrategy.files.every(file => file.path.endsWith('.test.tsx')))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('records unsupported runners explicitly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-'))
    const mochaRoot = path.dirname(require.resolve('mocha/package.json'))
    const karmaRoot = path.join(root, 'node_modules', 'karma')
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(root, 'test'))
    fs.mkdirSync(karmaRoot)
    fs.symlinkSync(mochaRoot, path.join(root, 'node_modules', 'mocha'), 'dir')
    fs.writeFileSync(path.join(karmaRoot, 'package.json'), JSON.stringify({
      name: 'karma',
      version: '6.4.4',
    }))
    fs.writeFileSync(path.join(root, 'test', 'unit.spec.js'), 'describe("suite", () => { it("unit", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'mixed-runner-project',
      devDependencies: {
        karma: '^6.4.4',
        mocha: require('mocha/package.json').version,
      },
      scripts: {
        'test-spec': 'mocha test/unit.spec.js',
        'test-karma': 'karma start',
        test: 'npm run test-spec',
      },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const mocha = manifest.frameworks.find(framework => framework.framework === 'mocha')
      const karma = manifest.frameworks.find(framework => framework.framework === 'karma')

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(karma.status, 'unsupported_by_validator')
      assert.strictEqual(karma.frameworkVersion, '6.4.4')
      assert.match(karma.notes[0], /not supported by this Test Optimization validator/)
      assert.strictEqual(mocha.ciWiring.initialization.status, 'unknown')
      assert.deepStrictEqual(manifest.omitted, [])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates a runnable Cucumber scaffold with isolated feature and step definitions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-cucumber-'))
    const runnerRoot = path.join(root, 'node_modules', '@cucumber', 'cucumber')
    const representative = path.join(root, 'features', 'unit.feature')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative), { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: '@cucumber/cucumber',
      version: '12.0.0',
      bin: { 'cucumber-js': 'bin.js' },
    }))
    fs.writeFileSync(path.join(root, 'cucumber.js'), 'module.exports = {}\n')
    fs.writeFileSync(representative, [
      'Feature: Unit',
      '  Scenario: unit',
      '    Given the unit is ready',
    ].join('\n'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'cucumber-project',
      devDependencies: { '@cucumber/cucumber': '12.0.0' },
      scripts: { test: 'cucumber-js' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]
      const strategy = framework.generatedTestStrategy
      const generatedSteps = strategy.files.find(file => file.role === 'steps')

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(framework.status, 'runnable')
      assert.strictEqual(framework.supportLevel, 'validator_supported')
      assert.deepStrictEqual(framework.project.configFiles, [path.join(root, 'cucumber.js')])
      assert.deepStrictEqual(framework.existingTestCommand.argv, [
        process.execPath,
        path.join(fs.realpathSync(runnerRoot), 'bin.js'),
        representative,
        '--format',
        'progress',
      ])
      assert.deepStrictEqual(framework.existingTestCommand.env, { CUCUMBER_PUBLISH_ENABLED: 'false' })
      assert.strictEqual(strategy.adapter, 'cucumber')
      assert.strictEqual(strategy.fileExtension, '.feature')
      assert.strictEqual(strategy.files.length, 4)
      assert.strictEqual(strategy.files.filter(file => file.role === 'feature').length, 3)
      assert.strictEqual(strategy.cleanupPaths.length, 4)
      assert.match(generatedSteps.contentLines.join('\n'), /atrAttempt\+\+/)
      assert.ok(strategy.scenarios.every(scenario => {
        return scenario.runCommand.cwd === path.dirname(representative) &&
          scenario.runCommand.argv.includes(generatedSteps.path) &&
          scenario.runCommand.argv.includes(scenario.testIdentities[0].file)
      }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not select Cucumber step definitions as Vitest representatives', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-cucumber-vitest-'))
    const vitestRoot = path.join(root, 'node_modules', 'vitest')
    const stepDefinitions = path.join(root, 'test', 'integration', 'features', 'step_definitions')
    const sourceTest = path.join(root, 'src', 'unit.test.js')
    fs.mkdirSync(vitestRoot, { recursive: true })
    fs.mkdirSync(stepDefinitions, { recursive: true })
    fs.mkdirSync(path.dirname(sourceTest), { recursive: true })
    fs.writeFileSync(path.join(vitestRoot, 'vitest.mjs'), '')
    fs.writeFileSync(path.join(vitestRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '4.0.0',
      bin: { vitest: 'vitest.mjs' },
    }))
    fs.writeFileSync(path.join(stepDefinitions, 'steps.js'), [
      "import { Before } from '@cucumber/cucumber'",
      'let test',
      'Before(() => { test() })',
    ].join('\n'))
    fs.writeFileSync(sourceTest, "import { test } from 'vitest'; test('unit', () => {})\n")
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'mixed-project',
      devDependencies: { vitest: '4.0.0' },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks.find(entry => entry.framework === 'vitest')

      assert.strictEqual(framework.status, 'runnable')
      assert.strictEqual(framework.localTestCandidates[0].sourceFile, sourceTest)
      assert.ok(framework.project.evidence.some(evidence => evidence.includes('Detected vitest')))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps installed runners runnable when a nested detected runner is unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-'))
    const mochaRoot = path.dirname(require.resolve('mocha/package.json'))
    const nestedJestRoot = path.join(root, 'examples', 'jest-example')
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(root, 'test'))
    fs.mkdirSync(nestedJestRoot, { recursive: true })
    fs.symlinkSync(mochaRoot, path.join(root, 'node_modules', 'mocha'), 'dir')
    fs.writeFileSync(path.join(root, 'test', 'unit.spec.js'), 'describe("suite", () => { it("unit", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'scaffold-project',
      devDependencies: { mocha: require('mocha/package.json').version },
      scripts: { test: 'mocha test/unit.spec.js' },
    }))
    fs.writeFileSync(path.join(nestedJestRoot, 'package.json'), JSON.stringify({
      name: 'jest-example',
      devDependencies: { jest: '29.7.0' },
      scripts: { test: 'jest' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const jest = manifest.frameworks.find(framework => framework.framework === 'jest')
      const mocha = manifest.frameworks.find(framework => framework.framework === 'mocha')

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(jest.status, 'requires_manual_setup')
      assert.match(jest.notes[0], /executable package could not be resolved/)
      assert.match(jest.notes[0], /package-local dependency setup/)
      assert.strictEqual(mocha.status, 'runnable')
      assert.strictEqual(mocha.generatedTestStrategy.status, 'planned')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves custom Jest wrappers and generates tests in an established test directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-custom-jest-'))
    const runnerRoot = path.join(root, 'node_modules', 'jest')
    const sourceRoot = path.join(root, 'packages', 'app', 'src')
    const independentRoot = path.join(root, 'packages', 'a-independent')
    const testRoot = path.join(sourceRoot, '__tests__')
    const auxiliaryTestRoot = path.join(root, 'compiler', 'src', '__tests__')
    const wrapper = path.join(root, 'scripts', 'jest-cli.js')
    const representative = path.join(testRoot, 'App-test.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.join(independentRoot, '__tests__'), { recursive: true })
    fs.mkdirSync(path.join(sourceRoot, 'forks'), { recursive: true })
    fs.mkdirSync(testRoot)
    fs.mkdirSync(auxiliaryTestRoot, { recursive: true })
    fs.mkdirSync(path.dirname(wrapper), { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'jest',
      version: '29.7.0',
      bin: { jest: 'bin.js' },
    }))
    fs.writeFileSync(wrapper, '')
    fs.writeFileSync(path.join(independentRoot, '__tests__', 'Independent-test.js'), '')
    fs.writeFileSync(path.join(independentRoot, 'package.json'), JSON.stringify({
      scripts: { test: 'jest' },
    }))
    fs.writeFileSync(path.join(sourceRoot, 'forks', 'HostConfig.test.js'), '')
    fs.writeFileSync(representative, 'test("app", () => {})\n')
    fs.writeFileSync(path.join(auxiliaryTestRoot, 'Compiler-test.js'), '')
    fs.writeFileSync(path.join(root, 'yarn.lock'), '')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'custom-jest-project',
      devDependencies: { jest: '29.7.0' },
      jest: { testRegex: '/__tests__/[^/]*\\.js$' },
      scripts: { test: 'node ./scripts/jest-cli.js' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]
      const strategy = framework.generatedTestStrategy

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(strategy.testDirectory, testRoot)
      assert.deepStrictEqual(framework.existingTestCommand.argv, [
        process.execPath,
        wrapper,
        '--runTestsByPath',
        representative,
        '--runInBand',
        '--no-watchman',
      ])
      for (const scenario of strategy.scenarios) {
        assert.deepStrictEqual(scenario.runCommand.argv.slice(0, 2), [process.execPath, wrapper])
        assert.ok(scenario.runCommand.argv.includes(scenario.testIdentities[0].file))
        assert.ok(!scenario.runCommand.argv.includes('--silent'))
        assert.doesNotMatch(scenario.runCommand.argv.join(' '), /node_modules[\\/]jest[\\/]bin/)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('scaffolds a repository-level Jest wrapper around the package matching the repository identity', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-react-'))
    const root = path.join(parent, 'react')
    const runnerRoot = path.join(root, 'node_modules', 'jest')
    const reactRoot = path.join(root, 'packages', 'react')
    const reactTests = path.join(reactRoot, 'src', '__tests__')
    const compilerRoot = path.join(root, 'compiler', 'packages', 'babel-plugin-react-compiler')
    const compilerTests = path.join(compilerRoot, 'src', '__tests__')
    const wrapper = path.join(root, 'scripts', 'jest', 'jest-cli.js')
    const config = path.join(root, 'scripts', 'jest', 'config.base.js')
    const representative = path.join(reactTests, 'ReactVersion-test.js')

    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(reactTests, { recursive: true })
    fs.mkdirSync(compilerTests, { recursive: true })
    fs.mkdirSync(path.dirname(wrapper), { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'jest',
      version: '29.7.0',
      bin: { jest: 'bin.js' },
    }))
    fs.writeFileSync(wrapper, '')
    fs.writeFileSync(config, [
      'module.exports = {',
      '  rootDir: process.cwd(),',
      "  testRegex: '/__tests__/[^/]*-test\\\\.js$',",
      '}',
      '',
    ].join('\n'))
    fs.writeFileSync(representative, 'test("version", () => {})\n')
    fs.writeFileSync(path.join(reactRoot, 'package.json'), JSON.stringify({ name: 'react' }))
    fs.writeFileSync(path.join(compilerTests, 'Compiler-test.js'), 'test("compiler", () => {})\n')
    fs.writeFileSync(path.join(compilerRoot, 'package.json'), JSON.stringify({
      name: 'babel-plugin-react-compiler',
      devDependencies: { jest: '29.7.0' },
      scripts: { test: 'jest' },
    }))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: { jest: '29.7.0' },
      jest: { testRegex: 'dont-run-jest-directly' },
      scripts: { test: 'node ./scripts/jest/jest-cli.js' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks.find(entry => entry.framework === 'jest')

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(framework.id, 'jest:react')
      assert.strictEqual(framework.project.root, root)
      assert.strictEqual(framework.project.configFiles[0], config)
      assert.strictEqual(framework.localTestCandidates[0].sourceFile, representative)
      assert.deepStrictEqual(framework.existingTestCommand.argv.slice(0, 2), [process.execPath, wrapper])
      assert.ok(framework.generatedTestStrategy.files.every(file => file.path.startsWith(`${reactTests}${path.sep}`)))
      for (const scenario of framework.generatedTestStrategy.scenarios) {
        assert.strictEqual(getCommandSuitabilityError({
          command: scenario.runCommand,
          framework,
          label: `the ${scenario.id} advanced-feature command`,
          repositoryRoot: root,
        }), undefined)
      }
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  for (const definition of [
    {
      framework: 'jest',
      version: '29.7.0',
      command: 'jest',
      testFilename: 'unit.test.js',
      expectedModuleSystem: 'commonjs',
    },
    {
      framework: 'vitest',
      version: '2.1.9',
      command: 'vitest run',
      packageType: 'module',
      testFilename: 'unit.test.js',
      expectedModuleSystem: 'esm',
    },
    {
      framework: 'jest',
      version: '29.7.0',
      command: 'jest',
      testFilename: 'unit.test.mjs',
      expectedModuleSystem: 'esm',
    },
    {
      framework: 'jest',
      version: '29.7.0',
      command: 'jest',
      packageType: 'module',
      testFilename: 'unit.test.cjs',
      expectedModuleSystem: 'commonjs',
    },
    {
      framework: 'vitest',
      version: '2.1.9',
      command: 'vitest run',
      packageType: 'module',
      testFilename: 'unit.test.cjs',
      expectedModuleSystem: 'commonjs',
    },
    {
      framework: 'vitest',
      version: '2.1.9',
      command: 'vitest run',
      packageType: 'module',
      testFilename: 'unit.test.cts',
      expectedModuleSystem: 'commonjs',
    },
  ]) {
    it(`creates ${definition.expectedModuleSystem} scenarios for ${definition.framework} ` +
      `from ${definition.testFilename}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-'))
      const runnerRoot = path.join(root, 'node_modules', definition.framework)
      fs.mkdirSync(runnerRoot, { recursive: true })
      fs.mkdirSync(path.join(root, 'test'))
      fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
      fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
        name: definition.framework,
        version: definition.version,
        bin: { [definition.framework]: 'bin.js' },
      }))
      fs.writeFileSync(
        path.join(root, 'test', definition.testFilename),
        'describe("suite", () => { it("unit", () => {}) })\n'
      )
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: `${definition.framework}-project`,
        type: definition.packageType,
        devDependencies: { [definition.framework]: definition.version },
        scripts: { test: definition.command },
      }))

      try {
        const manifest = createManifestScaffold({ root })
        const framework = manifest.frameworks[0]

        assert.deepStrictEqual(validateManifest(manifest), [])
        assert.strictEqual(framework.framework, definition.framework)
        assert.strictEqual(framework.generatedTestStrategy.moduleSystem, definition.expectedModuleSystem)
        assert.deepStrictEqual(
          framework.generatedTestStrategy.scenarios.map(scenario => scenario.id),
          ['basic-pass', 'atr-fail-once', 'test-management-target']
        )
        assert.ok(framework.generatedTestStrategy.scenarios.every(scenario => {
          return scenario.runCommand.argv[0] === process.execPath
        }))
        if (definition.framework === 'jest') {
          assert.ok(framework.generatedTestStrategy.scenarios.every(scenario => {
            return scenario.runCommand.argv.includes('--silent')
          }))
        }
        assert.strictEqual(new Set(framework.generatedTestStrategy.files.map(file => file.path)).size, 3)
        assert.ok(framework.generatedTestStrategy.files.every(file => file.contentLines.at(-1) !== ''))
        const atrFile = framework.generatedTestStrategy.files.find(file => file.path.includes('atr-fail-once'))
        const atrSource = atrFile.contentLines.join('\n')
        const stateFile = path.join(path.dirname(atrFile.path), '.dd-test-optimization-validation-atr-state')
        assert.ok(atrSource.includes(JSON.stringify(stateFile)))
        assert.doesNotMatch(atrSource, /import\.meta|__dirname/)
        if (definition.expectedModuleSystem === 'esm') {
          assert.match(atrSource, /import \{ existsSync, writeFileSync \} from 'node:fs'/)
          if (definition.framework === 'vitest') {
            assert.match(atrSource, /import \{ describe, expect, it \} from 'vitest'/)
            assert.ok(framework.generatedTestStrategy.scenarios.every(scenario => {
              return !scenario.runCommand.argv.includes('--globals')
            }))
          }
        } else {
          assert.match(atrSource, /const fs = require\('node:fs'\)/)
          if (definition.framework === 'vitest') {
            assert.doesNotMatch(atrSource, /(?:import|require).*vitest/)
            assert.ok(framework.generatedTestStrategy.scenarios.every(scenario => {
              return scenario.runCommand.argv.includes('--globals')
            }))
          }
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('uses the nearest package module type for generated tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-'))
    const mochaRoot = path.dirname(require.resolve('mocha/package.json'))
    const testRoot = path.join(root, 'test', 'scripts')
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.mkdirSync(testRoot, { recursive: true })
    fs.symlinkSync(mochaRoot, path.join(root, 'node_modules', 'mocha'), 'dir')
    fs.writeFileSync(path.join(testRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }))
    fs.writeFileSync(path.join(testRoot, 'unit.spec.js'), 'describe("suite", () => { it("unit", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'nested-commonjs-tests',
      type: 'module',
      devDependencies: { mocha: require('mocha/package.json').version },
      scripts: { test: 'mocha test/scripts/unit.spec.js' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const strategy = manifest.frameworks[0].generatedTestStrategy
      const atrSource = strategy.files.find(file => file.path.includes('atr-fail-once')).contentLines.join('\n')

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(strategy.testDirectory, testRoot)
      assert.strictEqual(strategy.moduleSystem, 'commonjs')
      assert.match(atrSource, /const fs = require\('node:fs'\)/)
      assert.doesNotMatch(atrSource, /import \{ existsSync/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses JavaScript files in an established __tests__ directory as representatives', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-'))
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    const testRoot = path.join(root, '__tests__')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(testRoot)
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '2.1.9',
      bin: { vitest: 'bin.js' },
    }))
    fs.writeFileSync(path.join(testRoot, 'base.js'), 'test("base", () => {})\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'vitest-tests-directory',
      devDependencies: { vitest: '2.1.9' },
      scripts: { test: 'vitest run' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const strategy = manifest.frameworks[0].generatedTestStrategy

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(strategy.testDirectory, testRoot)
      assert.ok(strategy.files.every(file => path.dirname(file.path) === testRoot))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves an exact test.ts Vitest file convention', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-'))
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    const sourceRoot = path.join(root, 'src')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.join(sourceRoot, 'add'), { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '2.1.9',
      bin: { vitest: 'bin.js' },
    }))
    fs.writeFileSync(
      path.join(sourceRoot, 'add', 'test.ts'),
      'describe("add", () => { test("adds", () => {}) })\n'
    )
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'vitest-exact-test-project',
      type: 'module',
      devDependencies: { vitest: '2.1.9' },
      scripts: { test: 'vitest run' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const strategy = manifest.frameworks[0].generatedTestStrategy
      const generatedPaths = strategy.files.map(file => path.relative(root, file.path).split(path.sep).join('/'))

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(strategy.testDirectory, sourceRoot)
      assert.deepStrictEqual(generatedPaths, [
        'src/dd-test-optimization-validation-basic-pass/test.ts',
        'src/dd-test-optimization-validation-atr-fail-once/test.ts',
        'src/dd-test-optimization-validation-test-management-target/test.ts',
      ])
      assert.ok(strategy.cleanupPaths.includes(
        path.join(sourceRoot, 'dd-test-optimization-validation-atr-fail-once',
          '.dd-test-optimization-validation-atr-state')
      ))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps generated exact-name tests inside a project with a root test.ts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-'))
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '2.1.9',
      bin: { vitest: 'bin.js' },
    }))
    fs.writeFileSync(path.join(root, 'test.ts'), 'describe("root", () => { test("works", () => {}) })\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'vitest-root-test-project',
      type: 'module',
      devDependencies: { vitest: '2.1.9' },
      scripts: { test: 'vitest run' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const strategy = manifest.frameworks[0].generatedTestStrategy

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(strategy.testDirectory, root)
      assert.ok(strategy.files.every(file => file.path.startsWith(`${root}${path.sep}`)))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('records a detected supported family with an unsupported installed version without commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-old-jest-'))
    const runnerRoot = path.join(root, 'node_modules', 'jest')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.join(root, 'test'))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'jest',
      version: '24.9.0',
      bin: { jest: 'bin.js' },
    }))
    fs.writeFileSync(path.join(root, 'test', 'unit.test.js'), 'test("unit", () => {})\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'old-jest-project',
      devDependencies: { jest: '24.9.0' },
      scripts: { test: 'jest' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(framework.framework, 'jest')
      assert.strictEqual(framework.frameworkVersion, '24.9.0')
      assert.strictEqual(framework.status, 'detected_not_runnable')
      assert.strictEqual(framework.existingTestCommand, undefined)
      assert.match(framework.notes[0], /supports >=28\.0\.0/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates a runnable Cypress scaffold with isolated native scenarios', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-cypress-'))
    const runnerRoot = path.join(root, 'node_modules', 'cypress')
    const representative = path.join(root, 'cypress', 'e2e', 'unit.cy.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative), { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'cypress',
      version: '14.0.0',
      bin: { cypress: 'bin.js' },
    }))
    fs.writeFileSync(path.join(root, 'cypress.config.js'), 'module.exports = {}\n')
    fs.writeFileSync(representative, "describe('suite', () => { it('unit', () => expect(true).to.equal(true)) })\n")
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'cypress-project',
      devDependencies: { cypress: '14.0.0' },
      scripts: { test: 'cypress run' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(framework.status, 'runnable')
      assert.strictEqual(framework.supportLevel, 'validator_supported')
      assert.deepStrictEqual(framework.project.configFiles, [path.join(root, 'cypress.config.js')])
      assert.deepStrictEqual(framework.existingTestCommand.argv, [
        process.execPath,
        path.join(fs.realpathSync(runnerRoot), 'bin.js'),
        'run',
        '--spec',
        representative,
      ])
      assert.strictEqual(framework.generatedTestStrategy.adapter, 'cypress')
      assert.strictEqual(framework.generatedTestStrategy.files.length, 3)
      assert.ok(framework.generatedTestStrategy.files.every(file => file.path.endsWith('.cy.js')))
      assert.strictEqual(framework.generatedTestStrategy.cleanupPaths.length, 3)
      const atr = framework.generatedTestStrategy.scenarios.find(scenario => scenario.id === 'atr-fail-once')
      const atrFile = framework.generatedTestStrategy.files.find(file => file.path === atr.testIdentities[0].file)
      assert.match(atrFile.contentLines.join('\n'), /expect\(attempt\+\+\)\.to\.equal\(1\)/)
      assert.ok(atr.runCommand.argv.includes('video=false,screenshotOnRunFailure=false,retries=0'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to an installed Cypress runner without a package script', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-cypress-direct-'))
    const runnerRoot = path.join(root, 'node_modules', 'cypress')
    const representative = path.join(root, 'cypress', 'e2e', 'unit.cy.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative), { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'cypress',
      version: '14.0.0',
      bin: { cypress: 'bin.js' },
    }))
    fs.writeFileSync(representative, "it('unit', () => expect(true).to.equal(true))\n")
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'cypress-project',
      devDependencies: { cypress: '14.0.0' },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.ok(framework.existingTestCommand.argv.includes(representative))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates a runnable Playwright scaffold with isolated browser-free scenarios', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-playwright-'))
    const runnerRoot = path.join(root, 'node_modules', '@playwright', 'test')
    const representative = path.join(root, 'tests', 'unit.spec.ts')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative), { recursive: true })
    fs.writeFileSync(path.join(runnerRoot, 'cli.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: '@playwright/test',
      version: '1.50.0',
      bin: { playwright: 'cli.js' },
    }))
    fs.writeFileSync(path.join(root, 'playwright.config.ts'), 'export default { testDir: "./tests" }\n')
    fs.writeFileSync(representative, "import { test } from '@playwright/test'; test('unit', async () => {})\n")
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'playwright-project',
      devDependencies: { '@playwright/test': '1.50.0' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]
      const strategy = framework.generatedTestStrategy
      const generatedConfig = strategy.files.find(file => file.role === 'config')

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.strictEqual(framework.status, 'runnable')
      assert.strictEqual(framework.supportLevel, 'validator_supported')
      assert.deepStrictEqual(framework.project.configFiles, [path.join(root, 'playwright.config.ts')])
      assert.deepStrictEqual(framework.existingTestCommand.argv, [
        process.execPath,
        path.join(fs.realpathSync(runnerRoot), 'cli.js'),
        'test',
        representative,
        '--reporter=line',
        '--workers=1',
      ])
      assert.strictEqual(strategy.adapter, 'playwright')
      assert.strictEqual(strategy.files.filter(file => file.role === 'test').length, 3)
      assert.strictEqual(strategy.cleanupPaths.length, 4)
      assert.match(generatedConfig.path, /dd-test-optimization-validation\.playwright\.config\.cjs$/)
      assert.match(generatedConfig.contentLines.join('\n'), /workers: 1/)
      assert.ok(strategy.scenarios.every(scenario => scenario.runCommand.argv.includes(generatedConfig.path)))
      const atr = strategy.scenarios.find(scenario => scenario.id === 'atr-fail-once')
      const atrFile = strategy.files.find(file => file.path === atr.testIdentities[0].file)
      assert.match(atrFile.contentLines.join('\n'), /test\.info\(\)\.retry/)
      assert.ok(!strategy.cleanupPaths.some(filename => filename.endsWith('atr-state')))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to an installed Vitest runner when every matching script is ineligible', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-vitest-bench-'))
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    const representative = path.join(root, 'test', 'unit.test.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '4.0.5',
      bin: { vitest: 'bin.js' },
    }))
    fs.writeFileSync(representative, 'test("unit", () => {})\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'vitest-benchmark-project',
      devDependencies: { vitest: '4.0.5' },
      scripts: { benchmark: 'vitest bench' },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.deepStrictEqual(framework.existingTestCommand.argv, [
        process.execPath,
        fs.realpathSync(path.join(runnerRoot, 'bin.js')),
        'run',
        representative,
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not select a test owned by a different runner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-mixed-runner-'))
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.join(root, 'test'))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '4.0.5',
      bin: { vitest: 'bin.js' },
    }))
    fs.writeFileSync(
      path.join(root, 'test', 'unit.test.js'),
      "const { test } = require('node:test'); test('unit', () => {})\n"
    )
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'mixed-runner-project',
      devDependencies: { vitest: '4.0.5' },
      scripts: { test: 'vitest run' },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]

      assert.strictEqual(framework.status, 'requires_manual_setup')
      assert.match(framework.notes[0], /imports another runner/)
      assert.strictEqual(framework.existingTestCommand, undefined)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores runner imports in comments and unrelated strings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-runner-comments-'))
    const runnerRoot = path.join(root, 'node_modules', 'jest')
    const representative = path.join(root, 'test', 'unit.test.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(representative))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'jest',
      version: '29.7.0',
      bin: { jest: 'bin.js' },
    }))
    fs.writeFileSync(representative, [
      "// import { test } from 'vitest'",
      'const fixture = "require(\'node:test\')"',
      "test('unit', () => fixture)",
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'jest-runner-comments-project',
      devDependencies: { jest: '29.7.0' },
      scripts: { test: 'jest' },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]

      assert.strictEqual(framework.status, 'runnable')
      assert.ok(framework.existingTestCommand.argv.includes(representative))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers a process-local Jest test and preserves its dash-test collection convention', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-listener-rank-'))
    const runnerRoot = path.join(root, 'node_modules', 'jest')
    const listenerTest = path.join(root, 'test', 'listener-test.js')
    const unitTest = path.join(root, 'test', 'unit-test.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(listenerTest))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'jest',
      version: '29.7.0',
      bin: { jest: 'bin.js' },
    }))
    fs.writeFileSync(listenerTest, "const request = require('supertest')\ntest('listener', () => request)\n")
    fs.writeFileSync(unitTest, "test('unit', () => {})\n")
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'listener-project',
      devDependencies: { jest: '29.7.0' },
      scripts: { test: 'jest' },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]

      assert.ok(framework.existingTestCommand.argv.includes(unitTest))
      assert.strictEqual(framework.localSocketRequired, false)
      assert.ok(framework.generatedTestStrategy.files.every(file => /-test\.js$/.test(file.path)))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('records when every safe representative appears to need a localhost listener', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-listener-only-'))
    const runnerRoot = path.join(root, 'node_modules', 'mocha')
    const listenerTest = path.join(root, 'test', 'listener.test.js')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.dirname(listenerTest))
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'mocha',
      version: '11.7.5',
      bin: { mocha: 'bin.js' },
    }))
    fs.writeFileSync(listenerTest, "describe('suite', () => { it('listener', () => app.listen(0)) })\n")
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'listener-only-project',
      devDependencies: { mocha: '11.7.5' },
      scripts: { test: 'mocha' },
    }))

    try {
      const framework = createManifestScaffold({ root }).frameworks[0]

      assert.strictEqual(framework.localSocketRequired, true)
      assert.match(framework.notes.join('\n'), /Every safe representative test found appears to open a local listener/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('selects a bounded whole test file without parsing parameterized test names', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-'))
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(path.join(root, 'test'))
    fs.writeFileSync(path.join(runnerRoot, 'vitest.mjs'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '4.1.0',
      bin: { vitest: 'vitest.mjs' },
    }))
    fs.writeFileSync(path.join(root, 'test', 'dynamic.test.ts'), `
      for (const implementation of ['node', 'browser']) {
        it('works', () => implementation)
      }
    `)
    fs.writeFileSync(path.join(root, 'test', 'unit.test.ts'), "it('one bounded test', () => {})\n")
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'loop-generated-tests',
      type: 'module',
      devDependencies: { vitest: '4.1.0' },
      scripts: { test: 'vitest run' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const command = manifest.frameworks[0].existingTestCommand

      assert.ok(command.argv.includes(path.join(root, 'test', 'dynamic.test.ts')))
      assert.ok(!command.argv.includes('--testNamePattern'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('proposes at most three whole-file fallback candidates without test-name filters', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-manifest-scaffold-candidates-'))
    const runnerRoot = path.join(root, 'node_modules', 'vitest')
    const testRoot = path.join(root, 'test')
    fs.mkdirSync(runnerRoot, { recursive: true })
    fs.mkdirSync(testRoot)
    fs.writeFileSync(path.join(runnerRoot, 'bin.js'), '')
    fs.writeFileSync(path.join(runnerRoot, 'package.json'), JSON.stringify({
      name: 'vitest',
      version: '4.0.5',
      bin: { vitest: 'bin.js' },
    }))
    for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
      fs.writeFileSync(path.join(testRoot, `${name}.test.js`), `test(${JSON.stringify(name)}, () => {})\n`)
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'candidate-project',
      devDependencies: { vitest: '4.0.5' },
      scripts: { test: 'vitest run' },
    }))

    try {
      const manifest = createManifestScaffold({ root })
      const framework = manifest.frameworks[0]

      assert.deepStrictEqual(validateManifest(manifest), [])
      assert.deepStrictEqual(framework.localTestCandidates.map(candidate => path.basename(candidate.sourceFile)), [
        'alpha.test.js',
        'bravo.test.js',
        'charlie.test.js',
      ])
      assert.ok(framework.localTestCandidates.every(candidate => {
        const command = candidate.command.argv.join(' ')
        return !command.includes('--testNamePattern') && !command.includes('-t ')
      }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
