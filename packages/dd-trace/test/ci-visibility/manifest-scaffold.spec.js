'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const jsonSchema = require('../../../../ci/test-optimization-validation-manifest.schema.json')
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
    fs.writeFileSync(path.join(root, 'test', 'unit.spec.js'), 'describe("unit", () => {})\n')
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'scaffold-project',
      devDependencies: { mocha: require('mocha/package.json').version },
      scripts: {
        test: `mocha test/unit.spec.js && node -e "require('node:fs').writeFileSync('${marker}', 'ran')"`,
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
      assert.strictEqual(manifest.frameworks.length, 1)
      assert.strictEqual(manifest.frameworks[0].framework, 'mocha')
      assert.strictEqual(manifest.frameworks[0].preflight.status, 'pending')
      assert.strictEqual(manifest.frameworks[0].ciWiring.initialization.status, 'unknown')
      assert.deepStrictEqual(
        manifest.frameworks[0].generatedTestStrategy.scenarios.map(scenario => scenario.id),
        ['basic-pass', 'atr-fail-once', 'test-management-target']
      )
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
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
    fs.writeFileSync(path.join(root, 'test', 'unit.spec.js'), 'describe("unit", () => {})\n')
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
      assert.strictEqual(mocha.status, 'runnable')
      assert.strictEqual(mocha.generatedTestStrategy.status, 'planned')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const definition of [
    {
      framework: 'jest',
      version: '29.7.0',
      command: 'jest --runInBand',
      testFilename: 'unit.test.js',
      expectedModuleSystem: 'commonjs',
    },
    {
      framework: 'vitest',
      version: '2.1.9',
      command: 'vitest run',
      packageType: 'module',
      testFilename: 'unit.test.js',
      expectedModuleSystem: 'module',
    },
    {
      framework: 'jest',
      version: '29.7.0',
      command: 'jest --runInBand',
      testFilename: 'unit.test.mjs',
      expectedModuleSystem: 'module',
    },
    {
      framework: 'jest',
      version: '29.7.0',
      command: 'jest --runInBand',
      packageType: 'module',
      testFilename: 'unit.test.cjs',
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
      fs.writeFileSync(path.join(root, 'test', definition.testFilename), 'describe("unit", () => {})\n')
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
        assert.strictEqual(new Set(framework.generatedTestStrategy.files.map(file => file.path)).size, 3)
        const atrFile = framework.generatedTestStrategy.files.find(file => file.path.includes('atr-fail-once'))
        const atrSource = atrFile.contentLines.join('\n')
        if (definition.expectedModuleSystem === 'module') {
          assert.match(atrSource, /import \{ existsSync, writeFileSync \} from 'node:fs'/)
        } else {
          assert.match(atrSource, /const fs = require\('node:fs'\)/)
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

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
    fs.writeFileSync(path.join(sourceRoot, 'add', 'test.ts'), 'describe("add", () => {})\n')
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
    fs.writeFileSync(path.join(root, 'test.ts'), 'describe("root", () => {})\n')
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
})
