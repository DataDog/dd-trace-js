'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

const prepareManifest = require('../../src/config/prepare-core-manifest')

const sourcePath = require.resolve('../../src/config/supported-configurations.json')

function prepare (major) {
  return prepareManifest(JSON.parse(readFileSync(sourcePath, 'utf8')), major)
}

describe('prepare the libdatadog configuration manifest', () => {
  it('applies the major-specific defaults and names before compiling', () => {
    const v5 = prepare(5).manifest.supportedConfigurations
    const v6 = prepare(6).manifest.supportedConfigurations
    const v7 = prepare(7).manifest.supportedConfigurations
    assert.strictEqual(v5.DD_TRACE_STARTUP_LOGS[0].default, 'false')
    assert.strictEqual(v6.DD_TRACE_ELECTRON_ENABLED[0].default, 'true')
    assert.strictEqual(v7.DD_TRACE_ELECTRON_ENABLED[0].default, 'false')
    assert.ok(v5.DD_IAST_SECURITY_CONTROLS_CONFIGURATION[0].configurationNames
      .includes('experimental.iast.securityControlsConfiguration'))
    assert.ok(!v6.DD_IAST_SECURITY_CONTROLS_CONFIGURATION[0].configurationNames
      ?.includes('experimental.iast.securityControlsConfiguration'))
  })

  it('preserves regexp validation for the IAST sampling default', () => {
    const { manifest } = prepare(6)
    const [rule] = manifest.supportedConfigurations.DD_IAST_REQUEST_SAMPLING
    assert.strictEqual(rule.default, '30')
    assert.strictEqual(rule.transform, undefined)
    assert.deepStrictEqual(rule.allowed, { pattern: '(?i-u:100|[1-9]?\\d)', validateDefault: true })
  })

  it('binds each host transformer with its input type', () => {
    const { manifest, hostTransforms } = prepare(6)
    const [rule] = manifest.supportedConfigurations.DD_SPAN_SAMPLING_RULES_FILE
    const binding = hostTransforms.find(({ name }) => name === rule.transform)
    assert.strictEqual(binding.input, rule.type)
    assert.strictEqual(binding.output, 'host')
    assert.strictEqual(binding.transform, 'readFilePath')
    assert.strictEqual(new Set(hostTransforms.map(({ slot }) => slot)).size, hostTransforms.length)
  })

  it('binds JavaScript regexp syntax as a host transform', () => {
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
    const allowed = '(?=prod)[a-z]+'
    source.supportedConfigurations.DD_ENV[0].allowed = allowed
    const { manifest, hostTransforms } = prepareManifest(source, 7)
    const [rule] = manifest.supportedConfigurations.DD_ENV
    const binding = hostTransforms.find(({ name }) => name === rule.transform)
    assert.strictEqual(rule.allowed, undefined)
    assert.strictEqual(binding.input, 'string')
    assert.strictEqual(binding.allowed, allowed)
  })

  it('prepares the packaged manifest when optional dependencies are omitted', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dd-trace-prepare-config-'))
    const root = resolve(__dirname, '../../../..')
    const script = 'scripts/release/prepare-core-config.js'
    const configDirectory = 'packages/dd-trace/src/config'
    const files = [
      'package.json',
      'version.js',
      script,
      ...['major-overrides.js', 'prepare-core-manifest.js', 'startup.js', 'supported-configurations.json']
        .map(name => join(configDirectory, name)),
    ]
    try {
      for (const file of files) {
        const target = join(fixture, file)
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(join(root, file), target)
      }

      const runPrepack = () => spawnSync(process.execPath, [script], { cwd: fixture, encoding: 'utf8' })
      const withoutAddon = runPrepack()
      assert.strictEqual(withoutAddon.status, 0, withoutAddon.stderr)
      const metadata = JSON.parse(readFileSync(join(fixture, configDirectory, 'core-config-transforms.json'), 'utf8'))
      assert.strictEqual(Object.hasOwn(metadata, 'defaults'), false)
      const manifestPath = join(fixture, configDirectory, 'supported-configurations.prepared.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      assert.strictEqual(manifest.version, '2')

      const extras = join(fixture, 'node_modules', '@datadog', 'libdatadog-extras')
      mkdirSync(extras, { recursive: true })
      const entry = join(extras, 'index.js')
      writeFileSync(entry, 'exports.maybeLoad = () => undefined')
      const withoutNative = runPrepack()
      assert.strictEqual(withoutNative.status, 0, withoutNative.stderr)

      writeFileSync(entry, 'throw new Error("invalid installed package")')
      const brokenAddon = runPrepack()
      assert.strictEqual(brokenAddon.status, 1)
      assert.match(brokenAddon.stderr, /invalid installed package/)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
