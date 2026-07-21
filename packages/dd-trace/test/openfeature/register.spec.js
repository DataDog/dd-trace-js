'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('OpenFeature register', () => {
  let config
  let feature
  let FlaggingProvider
  let openfeatureModule
  let openfeatureRemoteConfig
  let proxy
  let registerFeature

  function NoopFlaggingProvider () {}

  beforeEach(() => {
    /** @param {object} registeredFeature */
    const register = (registeredFeature) => {
      feature = registeredFeature
    }
    registerFeature = sinon.spy(register)
    openfeatureModule = {
      enable: sinon.spy(),
      disable: sinon.spy(),
    }
    openfeatureRemoteConfig = {
      enable: sinon.spy(),
    }
    FlaggingProvider = function () {}

    delete require.cache[require.resolve('../../src/openfeature/register')]
    proxyquire('../../src/openfeature/register', {
      '../feature-registry': { registerFeature },
      './flagging_provider': FlaggingProvider,
      './remote_config': openfeatureRemoteConfig,
      './index': openfeatureModule,
      './noop': NoopFlaggingProvider,
    })

    config = {
      featureFlags: {
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
        DD_FEATURE_FLAGS_ENABLED: true,
      },
    }
    proxy = { openfeature: feature.noop }
  })

  it('registers the OpenFeature feature boundaries', () => {
    sinon.assert.calledOnce(registerFeature)

    assert.strictEqual(feature.name, 'openfeature')
    assert.ok(feature.noop instanceof NoopFlaggingProvider)
    assert.strictEqual(feature.factory(), openfeatureModule)
    assert.strictEqual(feature.provider(), FlaggingProvider)
  })

  it('does not load active OpenFeature modules before application access', () => {
    const packagePath = path.join(__dirname, '../..')
    const script = `
      const tracer = require(${JSON.stringify(packagePath)})
      tracer.init()
      const modules = [
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/index'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/writers/exposures'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/flagging_provider'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/require-provider'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/configuration_source'))}),
        require.resolve(${JSON.stringify(path.join(packagePath, 'src/openfeature/agentless_configuration_source'))}),
        require.resolve('@datadog/openfeature-node-server'),
        require.resolve('@openfeature/server-sdk'),
        require.resolve('@openfeature/core')
      ]
      process.stdout.write(JSON.stringify(modules.map(module => require.cache[module] !== undefined)))
    `
    for (const featureFlagsEnabled of ['false', 'true']) {
      for (const remoteConfigurationEnabled of ['false', 'true']) {
        const result = spawnSync(process.execPath, ['-e', script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            DD_FEATURE_FLAGS_ENABLED: featureFlagsEnabled,
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
            DD_REMOTE_CONFIGURATION_ENABLED: remoteConfigurationEnabled,
            DD_TRACE_STARTUP_LOGS: 'false',
          },
        })

        assert.strictEqual(result.status, 0, result.stderr)
        assert.deepStrictEqual(JSON.parse(result.stdout), Array(9).fill(false))
      }
    }
  })

  it('selects the provider from the calculated Feature Flags state', () => {
    assert.strictEqual(feature.isEnabled(config), true)

    config.featureFlags.DD_FEATURE_FLAGS_ENABLED = false

    assert.strictEqual(feature.isEnabled(config), false)
  })

  it('installs Remote Config delivery when selected', () => {
    const rc = {}
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'

    feature.remoteConfig(rc, config, proxy)

    sinon.assert.calledOnceWithExactly(openfeatureRemoteConfig.enable, rc, sinon.match.func, true)
  })

  it('does not install Remote Config delivery when disabled', () => {
    const rc = {}
    config.featureFlags.DD_FEATURE_FLAGS_ENABLED = false

    feature.remoteConfig(rc, config, proxy)

    sinon.assert.calledOnceWithExactly(openfeatureRemoteConfig.enable, rc, sinon.match.func, false)
  })

  it('does not install Remote Config delivery for the default agentless source', () => {
    const rc = {}

    feature.remoteConfig(rc, config, proxy)

    sinon.assert.calledOnceWithExactly(openfeatureRemoteConfig.enable, rc, sinon.match.func, false)
  })
})
