'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it } = require('mocha')

const { files, scripts } = require('../../package.json')
const { DD_MAJOR } = require('../../version')
const applyConfigOverrides = require('./apply-config-overrides')

const root = path.join(__dirname, '..', '..')
const schemaPath = 'packages/dd-trace/src/config/supported-configurations.json'
const source = readFileSync(path.join(root, schemaPath), 'utf8')
const isWindows = process.platform === 'win32'

/**
 * @param {string} directory
 * @param {string[]} args
 */
function runNpm (directory, args) {
  return execFileSync(isWindows ? 'npm.cmd' : 'npm', args, {
    cwd: directory,
    encoding: 'utf8',
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
 */
function withFixture (major, test) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dd-trace-config-pack-'))
  try {
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      name: 'dd-trace-config-fixture',
      version: major + '.0.0',
      files,
      scripts: { prepack: scripts.prepack },
    }))
    for (const file of [
      'index.d.ts',
      'index.d.v5.ts',
      'scripts/release/apply-config-overrides.js',
      'scripts/release/config-overrides-v5.json',
      'scripts/release/config-overrides-v6.json',
      'scripts/release/swap-v5-types.js',
      'version.js',
    ]) {
      const destination = path.join(directory, file)
      mkdirSync(path.dirname(destination), { recursive: true })
      copyFileSync(path.join(root, file), destination)
    }

    const schema = JSON.parse(source)
    applyConfigOverrides(schema.supportedConfigurations, major === 5 ? 7 : major - 1)
    const filename = path.join(directory, schemaPath)
    mkdirSync(path.dirname(filename), { recursive: true })
    writeFileSync(filename, JSON.stringify(schema, null, 2) + '\n')
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

  assert.strictEqual(schema.DD_TRACE_ELECTRON_ENABLED[0].default, String(major < 7))
  assert.strictEqual(schema.DD_TRACE_STARTUP_LOGS[0].default, String(major >= 6))
  assert.strictEqual(Object.hasOwn(schema, 'DD_TRACE_EXPERIMENTAL_B3_ENABLED'), major === 5)
  assert.strictEqual(Object.hasOwn(schema, 'DD_PROFILING_EXPERIMENTAL_CPU_ENABLED'), major === 5)

  if (major === 5) {
    assert.deepStrictEqual(schema.DD_IAST_SECURITY_CONTROLS_CONFIGURATION[0].configurationNames, [
      'iast.securityControlsConfiguration',
      'experimental.iast.securityControlsConfiguration',
    ])
    assert.ok(schema.DD_PROFILING_CPU_ENABLED[0].aliases.includes('DD_PROFILING_EXPERIMENTAL_CPU_ENABLED'))
  } else {
    assert.strictEqual(schema.DD_IAST_SECURITY_CONTROLS_CONFIGURATION[0].configurationNames, undefined)
    assert.ok(!schema.DD_PROFILING_CPU_ENABLED[0].aliases?.includes('DD_PROFILING_EXPERIMENTAL_CPU_ENABLED'))
  }
}

describe('release config schema', () => {
  for (const major of [5, 6, 7]) {
    it('packs the v' + major + ' schema and declarations', () => {
      withFixture(major, directory => {
        const { filename, integrity } = JSON.parse(runNpm(directory, ['pack', '--json']))[0]
        const tarball = path.join(directory, filename)
        const config = execFileSync('tar', ['-xOzf', tarball, 'package/' + schemaPath], { encoding: 'utf8' })
        const types = execFileSync('tar', ['-xOzf', tarball, 'package/index.d.ts'], { encoding: 'utf8' })

        assertVersionedSchema(config, major)
        assert.strictEqual(types, readFileSync(path.join(root, major === 5 ? 'index.d.v5.ts' : 'index.d.ts'), 'utf8'))

        if (major === 5) {
          assert.strictEqual(JSON.parse(runNpm(directory, ['pack', '--json']))[0].integrity, integrity)
        } else if (major === 7 && DD_MAJOR === 7) {
          assert.strictEqual(config, source)
        }
      })
    })
  }

  it('prepares the schema in a v5 source checkout', () => {
    withFixture(5, directory => {
      const manifest = path.join(directory, 'package.json')
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      pkg.scripts.prepare = scripts.prepare
      pkg.scripts['prepare:dependencies'] = 'node --version'
      writeFileSync(manifest, JSON.stringify(pkg))

      runNpm(directory, ['run', 'prepare', '--silent'])

      assertVersionedSchema(readFileSync(path.join(directory, schemaPath), 'utf8'), 5)
    })
  })
})
