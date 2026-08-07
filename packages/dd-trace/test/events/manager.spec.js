'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')

const integrations = require('../../src/events/integrations')
const EventIntegrationManager = require('../../src/events/manager')

describe('EventIntegrationManager', () => {
  afterEach(() => {
    delete integrations.test
  })

  it('routes integration configuration without constructing a Plugin', () => {
    const configurations = []
    class TestIntegration {
      configure (tracerConfig, integrationConfig) {
        configurations.push({ tracerConfig, integrationConfig })
      }
    }
    integrations.test = TestIntegration
    const manager = new EventIntegrationManager({})
    const tracerConfig = { plugins: true }

    assert.strictEqual(manager.configureIntegration('test', { service: 'custom' }), true)
    manager.configure(tracerConfig)

    assert.deepStrictEqual(configurations, [{
      tracerConfig,
      integrationConfig: { enabled: true, service: 'custom' },
    }])
  })

  it('leaves unknown integrations with the plugin manager', () => {
    const manager = new EventIntegrationManager({})

    assert.strictEqual(manager.configureIntegration('unknown', true), false)
  })
})
