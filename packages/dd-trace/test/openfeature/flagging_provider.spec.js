'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('FlaggingProvider', () => {
  const fixtureRoot = path.join(__dirname, 'ffe-system-test-data')
  const fixtureCaseDir = path.join(fixtureRoot, 'evaluation-cases')

  let FlaggingProvider
  let mockTracer
  let mockConfig
  let mockChannel
  let log
  let channelStub
  let configurationSource
  let mockEvalMetricsHook
  let mockEvalMetricsHookClass
  let mockSpanEnrichmentHook
  let mockSpanEnrichmentHookClass

  beforeEach(() => {
    mockTracer = {
      _config: { service: 'test-service' },
    }

    mockConfig = {
      service: 'test-service',
      version: '1.0.0',
      env: 'test',
      experimental: {
        flaggingProvider: {
          enabled: true,
          initializationTimeoutMs: 30_000,
          spanEnrichment: {
            enabled: true,
          },
        },
      },
    }

    mockChannel = {
      publish: sinon.spy(),
    }

    channelStub = sinon.stub().returns(mockChannel)
    configurationSource = {
      create: sinon.stub(),
    }

    log = {
      debug: sinon.spy(),
      info: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }

    mockEvalMetricsHook = {
      record: sinon.spy(),
    }
    mockEvalMetricsHookClass = sinon.stub().returns(mockEvalMetricsHook)

    mockSpanEnrichmentHook = {
      destroy: sinon.spy(),
    }
    mockSpanEnrichmentHookClass = sinon.stub().returns(mockSpanEnrichmentHook)

    FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      'dc-polyfill': {
        channel: channelStub,
      },
      '../log': log,
      './configuration_source': configurationSource,
      './eval-metrics-hook': mockEvalMetricsHookClass,
      './span-enrichment-hook': mockSpanEnrichmentHookClass,
      '../../../../vendor/dist/@datadog/openfeature-node-server': { DatadogNodeServerProvider },
    })
  })

  describe('constructor', () => {
    it('should create exposure channel', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider)
      sinon.assert.calledWith(channelStub, 'ffe:exposure:submit')
    })

    it('should log debug message on creation', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider)
      sinon.assert.calledWith(log.debug, '%s created with timeout: %dms', 'FlaggingProvider', 30000)
    })
  })

  describe('hooks', () => {
    it('should create EvalMetricsHook with config', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledOnceWithExactly(mockEvalMetricsHookClass, mockConfig)
    })

    it('should create SpanEnrichmentHook with tracer when span enrichment is enabled', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledOnceWithExactly(mockSpanEnrichmentHookClass, mockTracer)
    })

    it('should not create SpanEnrichmentHook when span enrichment is disabled', () => {
      mockConfig.experimental.flaggingProvider.spanEnrichment.enabled = false
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.notCalled(mockSpanEnrichmentHookClass)
    })

    it('should not create SpanEnrichmentHook when spanEnrichment config is missing', () => {
      delete mockConfig.experimental.flaggingProvider.spanEnrichment
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.notCalled(mockSpanEnrichmentHookClass)
    })

    it('should register EvalMetricsHook and SpanEnrichmentHook as hooks when enabled', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.strictEqual(provider.hooks.length, 2)
      assert.strictEqual(provider.hooks[0], mockEvalMetricsHook)
      assert.strictEqual(provider.hooks[1], mockSpanEnrichmentHook)
    })

    it('should only register EvalMetricsHook when span enrichment is disabled', () => {
      mockConfig.experimental.flaggingProvider.spanEnrichment.enabled = false
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.strictEqual(provider.hooks.length, 1)
      assert.strictEqual(provider.hooks[0], mockEvalMetricsHook)
    })

    it('should log info message when span enrichment is enabled', () => {
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledWith(log.info, '%s span enrichment enabled', 'FlaggingProvider')
    })

    it('should log info message when span enrichment is disabled', () => {
      mockConfig.experimental.flaggingProvider.spanEnrichment.enabled = false
      new FlaggingProvider(mockTracer, mockConfig) // eslint-disable-line no-new

      sinon.assert.calledWith(log.info, '%s span enrichment disabled', 'FlaggingProvider')
    })
  })

  describe('onClose', () => {
    it('should call destroy on SpanEnrichmentHook when enabled', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider.onClose()

      sinon.assert.calledOnce(mockSpanEnrichmentHook.destroy)
    })

    it('should not throw when span enrichment is disabled', () => {
      mockConfig.experimental.flaggingProvider.spanEnrichment.enabled = false
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider.onClose()

      sinon.assert.notCalled(mockSpanEnrichmentHook.destroy)
    })

    it('stops the attached configuration source', () => {
      const source = { start: sinon.spy(), stop: sinon.spy() }
      configurationSource.create.returns(source)
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider.onClose()

      sinon.assert.calledOnce(source.start)
      sinon.assert.calledOnce(source.stop)
    })

    it('applies source configurations through the provider boundary', () => {
      const source = { start: sinon.spy(), stop: sinon.spy() }
      configurationSource.create.returns(source)
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const ufc = { flags: {} }
      const applyConfiguration = configurationSource.create.firstCall.args[1]

      applyConfiguration(ufc)

      assert.strictEqual(provider.getConfiguration(), ufc)
    })

    it('closes owned resources only once', () => {
      const source = { start: sinon.spy(), stop: sinon.spy() }
      configurationSource.create.returns(source)
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      provider.onClose()
      provider.onClose()

      sinon.assert.calledOnce(source.stop)
      sinon.assert.calledOnce(mockSpanEnrichmentHook.destroy)
    })
  })

  describe('inheritance', () => {
    it('should extend DatadogNodeServerProvider', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.ok(provider instanceof DatadogNodeServerProvider)
    })
  })
  describe('canonical FFE fixtures', () => {
    const fixtureCases = loadFixtureCases()

    for (const { fileName, index, testCase } of fixtureCases) {
      it(`should evaluate ${fileName}[${index}]`, async () => {
        const provider = new FlaggingProvider(mockTracer, mockConfig)
        provider.setConfiguration(loadUfc())

        const details = await evaluateDetails(provider, testCase)

        assert.deepStrictEqual(details.value, testCase.result.value)
        assert.strictEqual(details.reason, testCase.result.reason)
        if ('variant' in testCase.result) {
          assert.strictEqual(details.variant, testCase.result.variant)
        }
      })
    }
  })

  describe('targeting regex conformance', () => {
    const fixtureFile = path.join(fixtureRoot, 'regex-conformance', 'targeting-regex-conformance.json')
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'))
    const regexCases = fixture.cases

    assert.strictEqual(fixture.schema, 'datadog.ffe.targeting-regex-conformance/v1')
    assert.strictEqual(fixture.schemaVersion, 1)
    assert.strictEqual(fixture.contractVersion, 'targeting-regex-v2')
    assert.strictEqual(regexCases.length, 75)
    assert.strictEqual(new Set(regexCases.map(regexCase => regexCase.id)).size, 75)
    assert.strictEqual(regexCases.filter(regexCase => regexCase.contract === 'accepted').length, 30)
    assert.strictEqual(regexCases.filter(regexCase => regexCase.contract === 'rejected').length, 45)

    for (const regexCase of regexCases) {
      it(`should evaluate ${regexCase.id}`, async () => {
        const expectedCompile = regexCase.expectedCompile
        const expectedMatch = regexCase.expectedMatch
        const provider = new FlaggingProvider(mockTracer, mockConfig)

        if (regexCase.contract === 'accepted') {
          assert.strictEqual(expectedCompile, true)
          assert.strictEqual(typeof expectedMatch, 'boolean')
        } else {
          assert.strictEqual(regexCase.contract, 'rejected')
        }

        provider.setConfiguration(createRegexConfiguration(regexCase.normalizedPattern))

        const details = await provider.resolveBooleanEvaluation(
          'regex-conformance',
          false,
          { targetingKey: regexCase.id, input: regexCase.input },
          { error () {}, warn () {}, info () {}, debug () {} }
        )

        if (regexCase.contract === 'accepted') {
          assert.strictEqual(details.reason, 'TARGETING_MATCH')
          assert.strictEqual(details.value, expectedMatch)
        }
      })
    }
  })

  function loadUfc () {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'ufc-config.json'), 'utf8'))
  }

  function loadFixtureCases () {
    const fixtureFiles = fs.readdirSync(fixtureCaseDir).filter(file => file.endsWith('.json')).sort()
    assert.ok(fixtureFiles.length > 0, 'FFE fixture submodule is missing or empty')
    return fixtureFiles.flatMap(fileName => {
      const testCases = JSON.parse(fs.readFileSync(path.join(fixtureCaseDir, fileName), 'utf8'))
      return testCases.map((testCase, index) => ({ fileName, index, testCase }))
    })
  }

  async function evaluateDetails (provider, testCase) {
    const context = { targetingKey: testCase.targetingKey, ...testCase.attributes }
    const logger = { error () {}, warn () {}, info () {}, debug () {} }

    if (testCase.variationType === 'BOOLEAN') {
      return provider.resolveBooleanEvaluation(testCase.flag, testCase.defaultValue, context, logger)
    }
    if (testCase.variationType === 'STRING') {
      return provider.resolveStringEvaluation(testCase.flag, testCase.defaultValue, context, logger)
    }
    if (testCase.variationType === 'INTEGER' || testCase.variationType === 'NUMERIC') {
      return provider.resolveNumberEvaluation(testCase.flag, testCase.defaultValue, context, logger)
    }
    if (testCase.variationType === 'JSON') {
      return provider.resolveObjectEvaluation(testCase.flag, testCase.defaultValue, context, logger)
    }
    throw new Error(`Unsupported variation type: ${testCase.variationType}`)
  }

  function createRegexConfiguration (pattern) {
    return {
      flags: {
        'regex-conformance': {
          key: 'regex-conformance',
          enabled: true,
          variationType: 'BOOLEAN',
          variations: {
            matched: { key: 'matched', value: true },
            'not-matched': { key: 'not-matched', value: false },
          },
          allocations: [
            createRegexAllocation('matched', 'MATCHES', pattern),
            createRegexAllocation('not-matched', 'NOT_MATCHES', pattern),
          ],
        },
      },
    }
  }

  function createRegexAllocation (key, operator, pattern) {
    return {
      key,
      rules: [{ conditions: [{ attribute: 'input', operator, value: pattern }] }],
      splits: [{ variationKey: key, shards: [] }],
      doLog: false,
    }
  }
})
