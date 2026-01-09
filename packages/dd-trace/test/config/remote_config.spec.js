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
      setBatchHandler: sinon.spy((products, handler) => {
        batchHandlers.set(products[0], handler)
      })
    }

    config = {
      service: 'test-service',
      env: 'test-env',
      setRemoteConfig: sinon.spy()
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
        RemoteConfigCapabilities.APM_TRACING_ENABLE_CODE_ORIGIN, true)
    })

    it('should register APM_TRACING batch handler', () => {
      enable(rc, config, onConfigUpdated)

      sinon.assert.calledOnceWithExactly(rc.setBatchHandler, ['APM_TRACING'], sinon.match.func)
    })

    describe('APM_TRACING handler', () => {
      it('should configure tracer on apply action', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')
        const libConfig = { service: 'test-service' }

        const transaction = createTransaction([
          { id: 'config-1', file: { lib_config: libConfig } }
        ])

        handler(transaction)

        sinon.assert.calledOnceWithExactly(config.setRemoteConfig, libConfig)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should reset config on unapply action', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')

        // First apply a config
        let transaction = createTransaction([
          { id: 'config-1', file: { lib_config: { service: 'test' } } }
        ])
        handler(transaction)

        config.setRemoteConfig.resetHistory()
        onConfigUpdated.resetHistory()

        // Then unapply it
        transaction = createTransaction([], [], [
          { id: 'config-1', file: {} }
        ])
        handler(transaction)

        // When all configs are removed, null is passed to reset
        sinon.assert.calledWithExactly(config.setRemoteConfig, null)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should call setRemoteConfig only once per batch', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')

        // Apply multiple configs in a single batch
        const transaction = createTransaction([
          { id: 'config-1', file: { lib_config: { tracing_sampling_rate: 0.5 } } },
          { id: 'config-2', file: { lib_config: { log_injection_enabled: true } } },
          { id: 'config-3', file: { lib_config: { tracing_enabled: true } } }
        ])

        handler(transaction)

        // Should be called exactly once, not three times
        sinon.assert.calledOnce(config.setRemoteConfig)
        sinon.assert.calledOnce(onConfigUpdated)
      })
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
            lib_config: { tracing_sampling_rate: 0.5 }
          }
        },
        {
          id: 'config-service',
          file: {
            service_target: { service: 'test-service', env: '*' },
            lib_config: { tracing_sampling_rate: 0.8 }
          }
        }
      ])

      handler(transaction)

      // Service config should win
      const lastCall = config.setRemoteConfig.lastCall
      sinon.assert.match(lastCall.args[0], { tracing_sampling_rate: 0.8 })
    })

    it('should handle config removal', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Add two configs
      let transaction = createTransaction([{
        id: 'config-1',
        file: {
          service_target: { service: '*', env: '*' },
          lib_config: { tracing_sampling_rate: 0.5 }
        }
      }, {
        id: 'config-2',
        file: {
          service_target: { service: 'test-service', env: '*' },
          lib_config: { tracing_sampling_rate: 0.8 }
        }
      }])
      handler(transaction)

      // Remove higher priority config
      transaction = createTransaction([], [], [
        { id: 'config-2', file: {} }
      ])
      handler(transaction)

      // Lower priority should now apply
      const lastCall = config.setRemoteConfig.lastCall
      sinon.assert.match(lastCall.args[0], { tracing_sampling_rate: 0.5 })
    })

    it('should filter configs by service/env', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply config for different service
      const transaction = createTransaction([{
        id: 'config-other',
        file: {
          service_target: { service: 'other-service', env: '*' },
          lib_config: { tracing_sampling_rate: 0.9 }
        }
      }])

      handler(transaction)

      // Should be ignored, so null is passed to reset all RC fields
      sinon.assert.calledWith(config.setRemoteConfig, null)
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
            log_injection_enabled: true
          }
        }
      }, {
        id: 'config-service',
        file: {
          service_target: { service: 'test-service', env: '*' },
          lib_config: {
            tracing_sampling_rate: 0.8
          }
        }
      }])

      handler(transaction)

      // Service config sampling rate should win, but log_injection should come from org
      const lastCall = config.setRemoteConfig.lastCall
      sinon.assert.match(lastCall.args[0], {
        tracing_sampling_rate: 0.8,
        log_injection_enabled: true
      })
    })

    it('should return null when configs have no lib_config field', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply a config that has lib_config set to null
      const transaction = createTransaction([
        { id: 'config-1', file: { service_target: { service: 'test-service', env: '*' }, lib_config: null } }
      ])

      handler(transaction)

      // Should pass null because no lib_config was found
      sinon.assert.calledWithExactly(config.setRemoteConfig, null)
      sinon.assert.calledOnce(onConfigUpdated)
    })
  })
})

function createTransaction (toApply = [], toModify = [], toUnapply = []) {
  const addDefaults = (item) => ({
    product: 'APM_TRACING',
    path: `datadog/1/APM_TRACING/${item.id}`,
    ...item
  })

  return {
    toApply: toApply.map(addDefaults),
    toModify: toModify.map(addDefaults),
    toUnapply: toUnapply.map(addDefaults),
    ack: () => {},
    error: () => {}
  }
}
