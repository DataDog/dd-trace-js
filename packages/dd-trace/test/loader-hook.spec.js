'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const repositoryRoot = join(__dirname, '..', '..', '..')
const loaderHookUrl = pathToFileURL(join(repositoryRoot, 'loader-hook.mjs')).href
const configDefaultsPath = join(repositoryRoot, 'packages', 'dd-trace', 'src', 'config', 'defaults.js')

const securityControls = 'SANITIZER:COMMAND_INJECTION:sanitizer/index.js:sanitize'
const sanitizerUrl = 'file:///app/sanitizer/index.js'

describe('loader hook', () => {
  let temporaryDirectory
  let localConfigPath

  beforeEach(() => {
    // os.tmpdir() could return a falsy value on Windows, if process.env.TEMP or process.env.TMP are malformed.
    temporaryDirectory = mkdtempSync(join(tmpdir() || 'C:\\Windows\\Temp', 'loader-hook-'))
    localConfigPath = join(temporaryDirectory, 'local.yaml')
  })

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true })
  })

  function initializeLoaderHook (env) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { createRequire } from 'node:module'

      const require = createRequire(${JSON.stringify(join(repositoryRoot, 'index.js'))})
      const { initialize } = await import(${JSON.stringify(loaderHookUrl)})
      const data = {}

      await initialize(data)

      console.log(JSON.stringify({
        loadedConfigDefaults: require.cache[${JSON.stringify(configDefaultsPath)}] !== undefined,
        includesSecurityControl: data.shouldInclude(${JSON.stringify(sanitizerUrl)}, './sanitizer/index.js'),
      }))
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DD_IAST_SECURITY_CONTROLS_CONFIGURATION: undefined,
        DD_TEST_LOCAL_CONFIG_PATH: localConfigPath,
        DD_TEST_FLEET_CONFIG_PATH: join(temporaryDirectory, 'fleet.yaml'),
        ...env,
      },
    })

    assert.strictEqual(result.status, 0, result.stderr)

    return JSON.parse(result.stdout)
  }

  it('does not load the configuration defaults when no security controls are configured', () => {
    assert.deepStrictEqual(initializeLoaderHook(), {
      loadedConfigDefaults: false,
      includesSecurityControl: false,
    })
  })

  it('applies security controls from the environment', () => {
    const result = initializeLoaderHook({ DD_IAST_SECURITY_CONTROLS_CONFIGURATION: securityControls })

    assert.strictEqual(result.includesSecurityControl, true)
  })

  it('applies security controls from the PM2 environment', () => {
    const result = initializeLoaderHook({
      pm2_env: JSON.stringify({ DD_IAST_SECURITY_CONTROLS_CONFIGURATION: securityControls }),
    })

    assert.strictEqual(result.includesSecurityControl, true)
  })

  it('applies security controls from stable config', () => {
    writeFileSync(
      localConfigPath,
      `apm_configuration_default:\n  DD_IAST_SECURITY_CONTROLS_CONFIGURATION: "${securityControls}"\n`
    )

    assert.strictEqual(initializeLoaderHook().includesSecurityControl, true)
  })
})
