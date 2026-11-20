import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, it } from 'mocha'

const require = createRequire(import.meta.url)
const { check, readPluginId, toEnvName } = require('./check-plugin-enable-flags.js')

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const checkerPath = join(repositoryDirectory, 'scripts', 'check-plugin-enable-flags.js')

describe('check-plugin-enable-flags', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dd-trace-plugin-flags-'))
    mkdirSync(join(root, 'packages', 'dd-trace', 'src', 'plugins'), { recursive: true })
    mkdirSync(join(root, 'packages', 'dd-trace', 'src', 'config'), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * @param {string} packageName
   * @param {string} source
   */
  function addPlugin (packageName, source) {
    mkdirSync(join(root, 'packages', packageName, 'src'), { recursive: true })
    writeFileSync(join(root, 'packages', packageName, 'src', 'index.js'), source)
  }

  /**
   * @param {string[]} packageNames
   */
  function writeRegistry (packageNames) {
    const lines = packageNames.map(name => {
      return `  get ${name.replace('datadog-plugin-', '')} () { return require('../../../${name}/src') },`
    })
    writeFileSync(
      join(root, 'packages', 'dd-trace', 'src', 'plugins', 'index.js'),
      `const plugins = {\n${lines.join('\n')}\n}\n\nmodule.exports = plugins\n`
    )
  }

  /**
   * @param {Record<string, object[]>} supportedConfigurations
   */
  function writeSupportedConfigurations (supportedConfigurations) {
    writeFileSync(
      join(root, 'packages', 'dd-trace', 'src', 'config', 'supported-configurations.json'),
      JSON.stringify({ version: '2', supportedConfigurations })
    )
  }

  const booleanFlag = [{ implementation: 'A', type: 'boolean', default: 'true' }]

  it('passes when every registered plugin has its enable flag', () => {
    addPlugin('datadog-plugin-foo', "class Foo { static id = 'foo' }\n")
    writeRegistry(['datadog-plugin-foo'])
    writeSupportedConfigurations({ DD_TRACE_FOO_ENABLED: booleanFlag })

    assert.deepEqual(check(root), [])
  })

  it('reports a registered plugin whose enable flag is missing', () => {
    addPlugin('datadog-plugin-foo', "class Foo { static id = 'foo' }\n")
    addPlugin('datadog-plugin-bar', "class Bar { static id = 'bar' }\n")
    writeRegistry(['datadog-plugin-foo', 'datadog-plugin-bar'])
    writeSupportedConfigurations({ DD_TRACE_FOO_ENABLED: booleanFlag })

    const violations = check(root)

    assert.equal(violations.length, 1)
    assert.match(violations[0], /^datadog-plugin-bar: DD_TRACE_BAR_ENABLED is missing from /)
  })

  it('accepts a flag that is only listed as an alias', () => {
    addPlugin('datadog-plugin-foo', "class Foo { static id = 'foo' }\n")
    writeRegistry(['datadog-plugin-foo'])
    writeSupportedConfigurations({
      DD_TRACE_OTHER_ENABLED: [
        { implementation: 'A', type: 'boolean', default: 'true', aliases: ['DD_TRACE_FOO_ENABLED'] },
      ],
    })

    assert.deepEqual(check(root), [])
  })

  it('normalizes scoped and dashed plugin ids the way PluginManager does', () => {
    addPlugin('datadog-plugin-dash-case', "class DashCase { static id = 'dash-case' }\n")
    writeRegistry(['datadog-plugin-dash-case'])
    writeSupportedConfigurations({ DD_TRACE_DASH_CASE_ENABLED: booleanFlag })

    assert.deepEqual(check(root), [])
  })

  it('skips plugins that are intentionally without an enable flag', () => {
    addPlugin('datadog-plugin-dd-trace-api', "class Api { static id = 'dd-trace-api' }\n")
    writeRegistry(['datadog-plugin-dd-trace-api'])
    writeSupportedConfigurations({})

    assert.deepEqual(check(root), [])
  })

  it('reports a registered plugin whose entry point is missing', () => {
    writeRegistry(['datadog-plugin-ghost'])
    writeSupportedConfigurations({})

    const violations = check(root)

    assert.equal(violations.length, 1)
    assert.match(violations[0], /^datadog-plugin-ghost: listed in .* is missing\.$/)
  })

  it('reports a registered plugin whose id cannot be read', () => {
    addPlugin('datadog-plugin-foo', 'module.exports = class Foo {}\n')
    writeRegistry(['datadog-plugin-foo'])
    writeSupportedConfigurations({})

    const violations = check(root)

    assert.equal(violations.length, 1)
    assert.match(violations[0], /could not read the plugin id/)
  })

  describe('readPluginId', () => {
    it('reads the supported id declarations', () => {
      assert.equal(readPluginId("class A { static id = 'a' }"), 'a')
      assert.equal(readPluginId('class A { static id = "b" }'), 'b')
      assert.equal(readPluginId("class A { static get id () { return 'c' } }"), 'c')
      assert.equal(readPluginId("class A {}\nA.id = 'd'\n"), 'd')
      assert.equal(readPluginId('class A {}'), undefined)
    })
  })

  describe('toEnvName', () => {
    it('upper-cases and replaces non-alphanumeric characters', () => {
      assert.equal(toEnvName('aws-lambda'), 'DD_TRACE_AWS_LAMBDA_ENABLED')
      assert.equal(toEnvName('openai'), 'DD_TRACE_OPENAI_ENABLED')
    })
  })

  it('exits with a failure status and prints the violation when run as a script', () => {
    addPlugin('datadog-plugin-foo', "class Foo { static id = 'foo' }\n")
    writeRegistry(['datadog-plugin-foo'])
    writeSupportedConfigurations({})

    const result = spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: 'utf8' })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /DD_TRACE_FOO_ENABLED is missing/)
  })

  it('exits successfully when run as a script against a consistent tree', () => {
    addPlugin('datadog-plugin-foo', "class Foo { static id = 'foo' }\n")
    writeRegistry(['datadog-plugin-foo'])
    writeSupportedConfigurations({ DD_TRACE_FOO_ENABLED: booleanFlag })

    const result = spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: 'utf8' })

    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
  })
})
