'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

const RemoteConfigCapabilities = require('../../src/remote_config/capabilities')
const { enable } = require('../../src/config/remote_config')

require('../setup/core')

describe('Tracing Remote Config', () => {
  let rc
  let config
  let updateTracing
  let updateDebugger
  let handlers

  beforeEach(() => {
    handlers = new Map()

    rc = {
      updateCapabilities: sinon.spy(),
      setProductHandler: sinon.spy((product, handler) => {
        handlers.set(product, handler)
      })
    }

    config = {
      service: 'test-service',
      env: 'test-env',
      updateRemoteConfig: sinon.spy()
    }

    updateTracing = sinon.spy()
    updateDebugger = sinon.spy()
  })

  describe('enable', () => {
    it('should register all APM tracing capabilities', () => {
      enable(rc, config, updateTracing, updateDebugger)

      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_CUSTOM_TAGS, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_HTTP_HEADER_TAGS, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_LOGS_INJECTION, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_SAMPLE_RATE, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_ENABLED, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_SAMPLE_RULES, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_MULTICONFIG, true)
    })

    it('should register APM_TRACING product handler', () => {
      enable(rc, config, updateTracing, updateDebugger)

      sinon.assert.calledOnceWithExactly(rc.setProductHandler, 'APM_TRACING', sinon.match.func)
    })

    describe('APM_TRACING handler', () => {
      it('should configure tracer on apply action', () => {
        enable(rc, config, updateTracing, updateDebugger)

        const handler = handlers.get('APM_TRACING')
        const libConfig = { service: 'test-service' }

        handler('apply', { lib_config: libConfig }, 'config-1')

        sinon.assert.calledOnceWithExactly(config.updateRemoteConfig, libConfig)
        sinon.assert.calledWithExactly(updateTracing, config, rc)
      })

      it('should reset config on unapply action', () => {
        enable(rc, config, updateTracing, updateDebugger)

        const handler = handlers.get('APM_TRACING')

        handler('apply', { lib_config: { service: 'test' } }, 'config-1')
        config.updateRemoteConfig.resetHistory()
        updateTracing.resetHistory()

        handler('unapply', {}, 'config-1')

        // When all configs are removed, null is passed to reset
        sinon.assert.calledWithExactly(config.updateRemoteConfig, null)
        sinon.assert.calledWithExactly(updateTracing, config, rc)
      })
    })
  })

  describe('APM_TRACING multiconfig', () => {
    it('should merge multiple configs by priority', () => {
      enable(rc, config, updateTracing, updateDebugger)
      const handler = handlers.get('APM_TRACING')

      // Apply org-level config
      handler('apply', {
        service_target: { service: '*', env: '*' },
        lib_config: { tracing_sampling_rate: 0.5 }
      }, 'config-org')

      // Apply service-specific config (higher priority)
      handler('apply', {
        service_target: { service: 'test-service', env: '*' },
        lib_config: { tracing_sampling_rate: 0.8 }
      }, 'config-service')

      // Service config should win
      const lastCall = config.updateRemoteConfig.lastCall
      sinon.assert.match(lastCall.args[0], { tracing_sampling_rate: 0.8 })
    })

    it('should handle config removal', () => {
      enable(rc, config, updateTracing, updateDebugger)
      const handler = handlers.get('APM_TRACING')

      // Add two configs
      handler('apply', {
        service_target: { service: '*', env: '*' },
        lib_config: { tracing_sampling_rate: 0.5 }
      }, 'config-1')

      handler('apply', {
        service_target: { service: 'test-service', env: '*' },
        lib_config: { tracing_sampling_rate: 0.8 }
      }, 'config-2')

      // Remove higher priority config
      handler('unapply', {}, 'config-2')

      // Lower priority should now apply
      const lastCall = config.updateRemoteConfig.lastCall
      sinon.assert.match(lastCall.args[0], { tracing_sampling_rate: 0.5 })
    })

    it('should filter configs by service/env', () => {
      enable(rc, config, updateTracing, updateDebugger)
      const handler = handlers.get('APM_TRACING')

      // Apply config for different service
      handler('apply', {
        service_target: { service: 'other-service', env: '*' },
        lib_config: { tracing_sampling_rate: 0.9 }
      }, 'config-other')

      // Should be ignored, so null is passed to reset all RC fields
      sinon.assert.calledWith(config.updateRemoteConfig, null)
    })

    it('should merge fields from multiple configs', () => {
      enable(rc, config, updateTracing, updateDebugger)
      const handler = handlers.get('APM_TRACING')

      // Apply org-level config with sampling rate
      handler('apply', {
        service_target: { service: '*', env: '*' },
        lib_config: {
          tracing_sampling_rate: 0.5,
          log_injection_enabled: true
        }
      }, 'config-org')

      // Apply service-specific config with only sampling rate (higher priority)
      handler('apply', {
        service_target: { service: 'test-service', env: '*' },
        lib_config: {
          tracing_sampling_rate: 0.8
        }
      }, 'config-service')

      // Service config sampling rate should win, but log_injection should come from org
      const lastCall = config.updateRemoteConfig.lastCall
      sinon.assert.match(lastCall.args[0], {
        tracing_sampling_rate: 0.8,
        log_injection_enabled: true
      })
    })

    it('should call updateDebugger', () => {
      enable(rc, config, updateTracing, updateDebugger)
      const handler = handlers.get('APM_TRACING')

      handler('apply', { lib_config: {} }, 'config-1')

      sinon.assert.calledOnceWithExactly(updateDebugger, config, rc)
    })
  })
})
