'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

describe('Test Optimization initialization', () => {
  it('selects the agentless exporter when global agentless mode is enabled', () => {
    const tracer = {
      init: sinon.stub(),
      use: sinon.stub(),
    }
    const values = {
      DD_AGENTLESS_ENABLED: true,
      DD_API_KEY: 'api-key',
    }

    proxyquire('../../../../ci/init', {
      '../packages/dd-trace': tracer,
      '../packages/dd-trace/src/config/helper': {
        getEnvironmentVariable: name => values[name],
        getValueFromEnvSources: (name, skipDefault) => values[name] ?? skipDefault,
      },
      '../packages/dd-trace/src/log': { debug: sinon.stub() },
    })

    sinon.assert.calledOnceWithExactly(tracer.init, {
      startupLogs: false,
      isCiVisibility: true,
      flushInterval: 10_000,
      experimental: { exporter: 'datadog' },
    })
  })

  for (const configurationName of ['DD_AGENTLESS_ENABLED', 'DD_CIVISIBILITY_AGENTLESS_ENABLED']) {
    it(`does not initialize agentless mode without an API key for ${configurationName}`, () => {
      const tracer = {
        init: sinon.stub(),
        use: sinon.stub(),
      }
      const values = { [configurationName]: true }
      const consoleError = sinon.stub(console, 'error')

      try {
        proxyquire('../../../../ci/init', {
          '../packages/dd-trace': tracer,
          '../packages/dd-trace/src/config/helper': {
            getEnvironmentVariable: name => values[name],
            getValueFromEnvSources: (name, skipDefault) => values[name] ?? skipDefault,
          },
          '../packages/dd-trace/src/log': { debug: sinon.stub() },
        })

        sinon.assert.notCalled(tracer.init)
        sinon.assert.calledOnce(consoleError)
        assert.match(consoleError.firstCall.args[0], new RegExp(configurationName))
      } finally {
        consoleError.restore()
      }
    })
  }

  it('selects the agent-proxy exporter by default', () => {
    const tracer = {
      init: sinon.stub(),
      use: sinon.stub(),
    }

    proxyquire('../../../../ci/init', {
      '../packages/dd-trace': tracer,
      '../packages/dd-trace/src/config/helper': {
        getEnvironmentVariable: () => undefined,
        getValueFromEnvSources: (name, skipDefault) => skipDefault,
      },
      '../packages/dd-trace/src/log': { debug: sinon.stub() },
    })

    sinon.assert.calledOnceWithExactly(tracer.init, {
      startupLogs: false,
      isCiVisibility: true,
      flushInterval: 10_000,
      experimental: { exporter: 'agent_proxy' },
    })
  })

  it('preserves an explicit CI instruction to disable Test Optimization', () => {
    const tracer = {
      init: sinon.stub(),
      use: sinon.stub(),
    }

    proxyquire('../../../../ci/init', {
      '../packages/dd-trace': tracer,
      '../packages/dd-trace/src/config/helper': {
        getEnvironmentVariable: () => undefined,
        getValueFromEnvSources: name => name === 'DD_CIVISIBILITY_ENABLED' ? false : undefined,
      },
      '../packages/dd-trace/src/log': { debug: sinon.stub() },
    })

    sinon.assert.notCalled(tracer.init)
  })
})
