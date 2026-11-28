'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it } = require('mocha')

const { files, scripts } = require('../../package.json')

const root = path.join(__dirname, '..', '..')
const schemaPath = 'packages/dd-trace/src/config/supported-configurations.json'
const source = readFileSync(path.join(root, schemaPath), 'utf8')
const isWindows = process.platform === 'win32'
const prepare = scripts.prepare.split(' && ').find(command => command.includes('apply-config-overrides.js'))
assert.ok(prepare)

/**
 * @param {string} directory
 * @param {string[]} args
 */
function runNpm (directory, args) {
  return execFileSync(isWindows ? 'npm.cmd' : 'npm', args, {
    cwd: directory,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      npm_config_cache: path.join(directory, '.npm-cache'),
      npm_config_ignore_scripts: 'false',
      npm_config_offline: 'true',
    },
    shell: isWindows,
  })
}

/**
 * @param {number} major
 * @param {(directory: string) => void} test
 * @param {Record<string, string>} [hooks]
 */
function withFixture (major, test, hooks) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dd-trace-config-pack-'))
  try {
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      name: 'dd-trace-config-fixture',
      version: major + '.0.0',
      files,
      scripts: hooks ?? { prepack: scripts.prepack },
    }))
    for (const file of [
      'index.d.ts',
      'index.d.v5.ts',
      'scripts/release/apply-config-overrides.js',
      'scripts/release/config-overrides-v5.json',
      'scripts/release/config-overrides-v7.json',
      'scripts/release/swap-v5-types.js',
      'version.js',
    ]) {
      const destination = path.join(directory, file)
      mkdirSync(path.dirname(destination), { recursive: true })
      copyFileSync(path.join(root, file), destination)
    }

    const filename = path.join(directory, schemaPath)
    mkdirSync(path.dirname(filename), { recursive: true })
    writeFileSync(filename, source)
    test(directory)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

/**
 * @param {string} data
 * @param {number} major
 */
function assertVersionedSchema (data, major) {
  const { supportedConfigurations: schema } = JSON.parse(data)
  // eslint-disable-next-line eslint-rules/eslint-env-aliases -- Assert the literal alias shipped to v5.
  const legacyCpuAlias = 'DD_PROFILING_EXPERIMENTAL_CPU_ENABLED'

  assert.strictEqual(schema.DD_TRACE_ELECTRON_ENABLED[0].default, String(major < 7))
  assert.strictEqual(schema.DD_TRACE_STARTUP_LOGS[0].default, String(major >= 6))
  assert.strictEqual(Object.hasOwn(schema, 'DD_TRACE_EXPERIMENTAL_B3_ENABLED'), major === 5)
  assert.strictEqual(Object.hasOwn(schema, legacyCpuAlias), major === 5)

  if (major === 5) {
    assert.deepStrictEqual(schema.DD_IAST_SECURITY_CONTROLS_CONFIGURATION[0].configurationNames, [
      'iast.securityControlsConfiguration',
      'experimental.iast.securityControlsConfiguration',
    ])
    assert.ok(schema.DD_PROFILING_CPU_ENABLED[0].aliases.includes(legacyCpuAlias))
  } else {
    assert.strictEqual(schema.DD_IAST_SECURITY_CONTROLS_CONFIGURATION[0].configurationNames, undefined)
    assert.ok(!schema.DD_PROFILING_CPU_ENABLED[0].aliases?.includes(legacyCpuAlias))
  }
}

describe('release config schema', function () {
  this.timeout(30_000)

  for (const major of [5, 6, 7]) {
    it('packs the v' + major + ' schema and declarations', () => {
      withFixture(major, directory => {
        const [pack] = JSON.parse(runNpm(directory, ['pack', '--json']))
        const { filename } = pack
        const tarball = path.join(directory, filename)
        const config = execFileSync('tar', ['-xOzf', tarball, 'package/' + schemaPath], { encoding: 'utf8' })
        const types = execFileSync('tar', ['-xOzf', tarball, 'package/index.d.ts'], { encoding: 'utf8' })

        const schemas = pack.files.filter(file => file.path.endsWith('/supported-configurations.json'))
        assert.deepStrictEqual(schemas.map(file => file.path), [schemaPath])
        assertVersionedSchema(config, major)
        assert.strictEqual(types, readFileSync(path.join(root, major === 5 ? 'index.d.v5.ts' : 'index.d.ts'), 'utf8'))

        if (major === 6) {
          assert.strictEqual(config, source)
        }
      })
    })
  }

  it('applies the schema when npm packs a directory using only prepare', () => {
    withFixture(5, directory => {
      const [pack] = JSON.parse(runNpm(directory, ['pack', '--ignore-scripts', '--json', directory]))
      const tarball = path.join(directory, pack.filename)
      const config = execFileSync('tar', ['-xOzf', tarball, 'package/' + schemaPath], { encoding: 'utf8' })
      assertVersionedSchema(config, 5)
    }, { prepare })
  })

  it('leaves the source registry intact during ordinary prepare', () => {
    withFixture(7, directory => {
      runNpm(directory, ['run', 'prepare'])
      assert.strictEqual(readFileSync(path.join(directory, schemaPath), 'utf8'), source)
    }, { prepare })
  })

  it('keeps Electron opt-in for later majors', () => {
    withFixture(8, directory => {
      execFileSync(process.execPath, ['scripts/release/apply-config-overrides.js'], { cwd: directory })
      assertVersionedSchema(readFileSync(path.join(directory, schemaPath), 'utf8'), 8)
    })
  })
})
