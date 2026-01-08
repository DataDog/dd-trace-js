'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

const RemoteConfigCapabilities = require('../../src/remote_config/capabilities')
const { enable } = require('../../src/config/remote_config')

require('../setup/core')

describe('Tracing Remote Config', () => {
  let rc
  let config
  let enableOrDisableTracing
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
      configure: sinon.spy()
    }

    enableOrDisableTracing = sinon.spy()
  })

  describe('enable', () => {
    it('should register all APM tracing capabilities', () => {
      enable(rc, config, enableOrDisableTracing)

      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_CUSTOM_TAGS, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_HTTP_HEADER_TAGS, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_LOGS_INJECTION, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_SAMPLE_RATE, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_ENABLED, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_SAMPLE_RULES, true)
    })

    it('should register APM_TRACING product handler', () => {
      enable(rc, config, enableOrDisableTracing)

      sinon.assert.calledOnceWithExactly(rc.setProductHandler, 'APM_TRACING', sinon.match.func)
    })

    describe('APM_TRACING handler', () => {
      it('should configure tracer on apply action', () => {
        enable(rc, config, enableOrDisableTracing)

        const handler = handlers.get('APM_TRACING')
        const libConfig = { service: 'test-service' }

        handler('apply', { lib_config: libConfig })

        sinon.assert.calledOnceWithExactly(config.configure, libConfig, true)
        sinon.assert.calledOnceWithExactly(enableOrDisableTracing, config, rc)
      })

      it('should reset config on unapply action', () => {
        enable(rc, config, enableOrDisableTracing)

        const handler = handlers.get('APM_TRACING')

        handler('unapply', {})

        sinon.assert.calledOnceWithExactly(config.configure, {}, true)
        sinon.assert.calledOnceWithExactly(enableOrDisableTracing, config, rc)
      })
    })
  })
})
