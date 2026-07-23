'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

const RemoteConfigCapabilities = require('../../src/remote_config/capabilities')
const { enable } = require('../../src/config/remote_config')

require('../setup/core')

describe('Tracing Remote Config', () => {
  let rc
  let config
  let onConfigUpdated
  let batchHandlers

  beforeEach(() => {
    batchHandlers = new Map()

    rc = {
      updateCapabilities: sinon.spy(),
      subscribeProducts: sinon.spy(),
      setBatchHandler: sinon.spy((products, handler) => {
        batchHandlers.set(products[0], handler)
      }),
    }

    config = {
      service: 'test-service',
      env: 'test-env',
      setRemoteConfigFromLibConfig: sinon.spy(),
      setRemoteConfigFromSdkConfig: sinon.spy(),
    }

    onConfigUpdated = sinon.spy()
  })

  describe('enable', () => {
    it('should register all APM tracing capabilities', () => {
      enable(rc, config, onConfigUpdated)

      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_CUSTOM_TAGS, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_HTTP_HEADER_TAGS, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_LOGS_INJECTION, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_SAMPLE_RATE, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_ENABLED, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_SAMPLE_RULES, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_MULTICONFIG, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities,
        RemoteConfigCapabilities.APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities,
        RemoteConfigCapabilities.APM_TRACING_ENABLE_LIVE_DEBUGGING, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities,
        RemoteConfigCapabilities.APM_TRACING_ENABLE_CODE_ORIGIN, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities,
        RemoteConfigCapabilities.SDK_CONFIGURATION, true)
    })

    it('should register a single APM_TRACING batch handler', () => {
      enable(rc, config, onConfigUpdated)

      // SDK_CONFIGURATION has no RC product of its own - it's a distinct config object (a flat
      // `sdk_config` map) delivered under the same APM_TRACING product as the legacy `lib_config`
      // object, so there's exactly one subscription and one batch handler.
      sinon.assert.calledOnceWithExactly(rc.subscribeProducts, 'APM_TRACING')
      sinon.assert.calledOnceWithExactly(rc.setBatchHandler, ['APM_TRACING'], sinon.match.func)
    })

    describe('APM_TRACING handler', () => {
      it('should configure tracer on apply action', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')
        const libConfig = { service: 'test-service' }

        const transaction = createTransaction([
          { id: 'config-1', file: { lib_config: libConfig } },
        ])

        handler(transaction)

        sinon.assert.calledOnceWithExactly(config.setRemoteConfigFromLibConfig, libConfig)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should reset config on unapply action', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')

        // First apply a config
        let transaction = createTransaction([
          { id: 'config-1', file: { lib_config: { service: 'test' } } },
        ])
        handler(transaction)

        config.setRemoteConfigFromLibConfig.resetHistory()
        onConfigUpdated.resetHistory()

        // Then unapply it
        transaction = createTransaction([], [], [
          { id: 'config-1', file: { lib_config: { service: 'test' } } },
        ])
        handler(transaction)

        // When all configs are removed, null is passed to reset
        sinon.assert.calledWithExactly(config.setRemoteConfigFromLibConfig, null)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should call setRemoteConfigFromLibConfig only once per batch', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')

        // Apply multiple configs in a single batch
        const transaction = createTransaction([
          { id: 'config-1', file: { lib_config: { tracing_sampling_rate: 0.5 } } },
          { id: 'config-2', file: { lib_config: { log_injection_enabled: true } } },
          { id: 'config-3', file: { lib_config: { tracing_enabled: true } } },
        ])

        handler(transaction)

        // Should be called exactly once, not three times
        sinon.assert.calledOnce(config.setRemoteConfigFromLibConfig)
        sinon.assert.calledOnce(onConfigUpdated)
      })
    })

    describe('SDK_CONFIGURATION handler', () => {
      it('should configure tracer on apply action', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')
        const sdkConfig = { DD_TRACE_SAMPLE_RATE: '0.5' }

        const transaction = createTransaction([
          { id: 'config-1', file: { sdk_config: sdkConfig } },
        ])

        handler(transaction)

        sinon.assert.calledOnceWithExactly(config.setRemoteConfigFromSdkConfig, sdkConfig)
        sinon.assert.notCalled(config.setRemoteConfigFromLibConfig)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should reset config on unapply action', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')

        // First apply a config
        let transaction = createTransaction([
          { id: 'config-1', file: { sdk_config: { DD_TRACE_ENABLED: 'true' } } },
        ])
        handler(transaction)

        config.setRemoteConfigFromSdkConfig.resetHistory()
        onConfigUpdated.resetHistory()

        // Then unapply it (routing on unapply also keys off the shape of the previously-applied file)
        transaction = createTransaction([], [], [
          { id: 'config-1', file: { sdk_config: { DD_TRACE_ENABLED: 'true' } } },
        ])
        handler(transaction)

        // When all configs are removed, the handler falls back to the legacy path, which is
        // also empty, so it resets via setRemoteConfigFromLibConfig(null) instead
        sinon.assert.notCalled(config.setRemoteConfigFromSdkConfig)
        sinon.assert.calledWithExactly(config.setRemoteConfigFromLibConfig, null)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should call setRemoteConfigFromSdkConfig only once per batch', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')

        // Apply multiple configs in a single batch
        const transaction = createTransaction([
          { id: 'config-1', file: { sdk_config: { DD_TRACE_SAMPLE_RATE: '0.5' } } },
          { id: 'config-2', file: { sdk_config: { DD_LOGS_INJECTION: 'true' } } },
          { id: 'config-3', file: { sdk_config: { DD_TRACE_ENABLED: 'true' } } },
        ])

        handler(transaction)

        // Should be called exactly once, not three times
        sinon.assert.calledOnce(config.setRemoteConfigFromSdkConfig)
        sinon.assert.calledOnce(onConfigUpdated)
      })
    })
  })

  describe('SDK_CONFIGURATION multiconfig', () => {
    it('should merge multiple configs by priority', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply both an org-level and a service-level config in one batch
      const transaction = createTransaction([
        {
          id: 'config-org',
          file: {
            service_target: { service: '*', env: '*' },
            sdk_config: { DD_TRACE_SAMPLE_RATE: '0.5' },
          },
        },
        {
          id: 'config-service',
          file: {
            service_target: { service: 'test-service', env: '*' },
            sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' },
          },
        },
      ])

      handler(transaction)

      // Service config should win
      sinon.assert.calledOnceWithExactly(config.setRemoteConfigFromSdkConfig, { DD_TRACE_SAMPLE_RATE: '0.8' })
    })

    it('should handle config removal', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Add two configs
      let transaction = createTransaction([{
        id: 'config-1',
        file: {
          service_target: { service: '*', env: '*' },
          sdk_config: { DD_TRACE_SAMPLE_RATE: '0.5' },
        },
      }, {
        id: 'config-2',
        file: {
          service_target: { service: 'test-service', env: '*' },
          sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' },
        },
      }])
      handler(transaction)

      config.setRemoteConfigFromSdkConfig.resetHistory()

      // Remove higher priority config
      transaction = createTransaction([], [], [
        {
          id: 'config-2',
          file: {
            service_target: { service: 'test-service', env: '*' },
            sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' },
          },
        },
      ])
      handler(transaction)

      // Lower priority should now apply
      sinon.assert.calledOnceWithExactly(config.setRemoteConfigFromSdkConfig, { DD_TRACE_SAMPLE_RATE: '0.5' })
    })

    it('should filter configs by service/env', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply config for different service
      const transaction = createTransaction([{
        id: 'config-other',
        file: {
          service_target: { service: 'other-service', env: '*' },
          sdk_config: { DD_TRACE_SAMPLE_RATE: '0.9' },
        },
      }])

      handler(transaction)

      // Should be ignored: no SDK_CONFIGURATION, so the handler falls back to the legacy path,
      // which is also empty, resetting via setRemoteConfigFromLibConfig(null)
      sinon.assert.notCalled(config.setRemoteConfigFromSdkConfig)
      sinon.assert.calledWith(config.setRemoteConfigFromLibConfig, null)
    })

    it('should return null when configs have no sdk_config field', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply a config that has sdk_config set to null
      const transaction = createTransaction([
        {
          id: 'config-1',
          file: {
            service_target: { service: 'test-service', env: '*' },
            sdk_config: null,
          },
        },
      ])

      handler(transaction)

      // Should fall back to the legacy path because no SDK_CONFIGURATION config was found
      sinon.assert.notCalled(config.setRemoteConfigFromSdkConfig)
      sinon.assert.calledWithExactly(config.setRemoteConfigFromLibConfig, null)
      sinon.assert.calledOnce(onConfigUpdated)
    })
  })

  describe('precedence between SDK_CONFIGURATION and APM_TRACING', () => {
    it('should apply SDK_CONFIGURATION and skip the legacy path when both are active', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      const transaction = createTransaction([
        { id: 'apm-config', file: { lib_config: { tracing_sampling_rate: 0.5 } } },
        { id: 'sdk-config', file: { sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' } } },
      ])

      handler(transaction)

      sinon.assert.calledOnceWithExactly(config.setRemoteConfigFromSdkConfig, { DD_TRACE_SAMPLE_RATE: '0.8' })
      sinon.assert.notCalled(config.setRemoteConfigFromLibConfig)
    })

    it('should fall back to the legacy path when only APM_TRACING is active', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      const transaction = createTransaction([
        { id: 'apm-config', file: { lib_config: { tracing_sampling_rate: 0.5 } } },
      ])

      handler(transaction)

      sinon.assert.notCalled(config.setRemoteConfigFromSdkConfig)
      sinon.assert.calledOnce(config.setRemoteConfigFromLibConfig)
    })

    it('should fall back to the legacy path once SDK_CONFIGURATION is removed', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Both active: SDK_CONFIGURATION wins
      let transaction = createTransaction([
        { id: 'apm-config', file: { lib_config: { tracing_sampling_rate: 0.5 } } },
        { id: 'sdk-config', file: { sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' } } },
      ])
      handler(transaction)

      config.setRemoteConfigFromSdkConfig.resetHistory()
      config.setRemoteConfigFromLibConfig.resetHistory()

      // SDK_CONFIGURATION removed, APM_TRACING still active
      transaction = createTransaction([], [], [
        { id: 'sdk-config', file: { sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' } } },
      ])
      handler(transaction)

      sinon.assert.notCalled(config.setRemoteConfigFromSdkConfig)
      sinon.assert.calledOnceWithExactly(config.setRemoteConfigFromLibConfig, { sampleRate: 0.5 })
    })

    it('should call exactly one of the two Config methods per transaction', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      const transaction = createTransaction([
        { id: 'apm-config', file: { lib_config: { tracing_sampling_rate: 0.5 } } },
        { id: 'sdk-config', file: { sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' } } },
      ])

      handler(transaction)

      const sdkCalls = config.setRemoteConfigFromSdkConfig.callCount
      const libCalls = config.setRemoteConfigFromLibConfig.callCount
      sinon.assert.match(sdkCalls + libCalls, 1)
    })
  })

  describe('APM_TRACING multiconfig', () => {
    it('should merge multiple configs by priority', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply both an org-level and a service-level config in one batch
      const transaction = createTransaction([
        {
          id: 'config-org',
          file: {
            service_target: { service: '*', env: '*' },
            lib_config: { tracing_sampling_rate: 0.5 },
          },
        },
        {
          id: 'config-service',
          file: {
            service_target: { service: 'test-service', env: '*' },
            lib_config: { tracing_sampling_rate: 0.8 },
          },
        },
      ])

      handler(transaction)

      // Service config should win
      const lastCall = config.setRemoteConfigFromLibConfig.lastCall
      sinon.assert.match(lastCall.args[0], { sampleRate: 0.8 })
    })

    it('should handle config removal', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Add two configs
      let transaction = createTransaction([{
        id: 'config-1',
        file: {
          service_target: { service: '*', env: '*' },
          lib_config: { tracing_sampling_rate: 0.5 },
        },
      }, {
        id: 'config-2',
        file: {
          service_target: { service: 'test-service', env: '*' },
          lib_config: { tracing_sampling_rate: 0.8 },
        },
      }])
      handler(transaction)

      // Remove higher priority config
      transaction = createTransaction([], [], [
        {
          id: 'config-2',
          file: {
            service_target: { service: 'test-service', env: '*' },
            lib_config: { tracing_sampling_rate: 0.8 },
          },
        },
      ])
      handler(transaction)

      // Lower priority should now apply
      const lastCall = config.setRemoteConfigFromLibConfig.lastCall
      sinon.assert.match(lastCall.args[0], { sampleRate: 0.5 })
    })

    it('should filter configs by service/env', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply config for different service
      const transaction = createTransaction([{
        id: 'config-other',
        file: {
          service_target: { service: 'other-service', env: '*' },
          lib_config: { tracing_sampling_rate: 0.9 },
        },
      }])

      handler(transaction)

      // Should be ignored, so null is passed to reset all RC fields
      sinon.assert.calledWith(config.setRemoteConfigFromLibConfig, null)
    })

    it('should merge fields from multiple configs', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply both an org-level and a service-level config in one batch
      const transaction = createTransaction([{
        id: 'config-org',
        file: {
          service_target: { service: '*', env: '*' },
          lib_config: {
            tracing_sampling_rate: 0.5,
            log_injection_enabled: true,
          },
        },
      }, {
        id: 'config-service',
        file: {
          service_target: { service: 'test-service', env: '*' },
          lib_config: {
            tracing_sampling_rate: 0.8,
          },
        },
      }])

      handler(transaction)

      // Service config sampling rate should win, but log_injection should come from org
      const lastCall = config.setRemoteConfigFromLibConfig.lastCall
      sinon.assert.match(lastCall.args[0], {
        sampleRate: 0.8,
        logInjection: true,
      })
    })

    it('should return null when configs have no lib_config field', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply a config that has lib_config set to null
      const transaction = createTransaction([
        { id: 'config-1', file: { service_target: { service: 'test-service', env: '*' }, lib_config: null } },
      ])

      handler(transaction)

      // Should pass null because no lib_config was found
      sinon.assert.calledWithExactly(config.setRemoteConfigFromLibConfig, null)
      sinon.assert.calledOnce(onConfigUpdated)
    })
  })
})

function createTransaction (toApply = [], toModify = [], toUnapply = []) {
  const addDefaults = (item) => ({
    product: 'APM_TRACING',
    path: `datadog/1/APM_TRACING/${item.id}`,
    ...item,
  })

  return {
    toApply: toApply.map(addDefaults),
    toModify: toModify.map(addDefaults),
    toUnapply: toUnapply.map(addDefaults),
    ack: () => {},
    error: () => {},
  }
}
