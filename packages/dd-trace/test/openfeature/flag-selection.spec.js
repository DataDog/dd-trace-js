'use strict'

const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const { inspect } = require('node:util')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const VECTORS_PATH = path.join(__dirname, 'ffe-system-test-data', 'flag-selection', 'selection-vectors.json')
const DEFAULT_ENDPOINT =
  'https://ufc-server.ff-cdn.datadoghq.com/api/v2/feature-flagging/config/rules-based/server?dd_env=my+env'
const NOT_SENT = 'featureFlags.flagSelection was not sent (%s: %s). Loading the full flag configuration.'
const REMOTE_CONFIG_WARNING = 'featureFlags.flagSelection is not supported when flags are delivered through ' +
  'Remote Config. Loading the full flag configuration.'
const LIMITS = {
  malformed_selection: 'featureFlags.flagSelection must be an object with optional tags and keyPatterns string arrays',
  too_many_values: 'each list accepts at most 31 values',
  invalid_key_pattern: 'each key pattern is at most 200 UTF-8 bytes',
  invalid_tag: 'each tag is at most 200 UTF-8 bytes',
}
const URL_LIMIT = 'the request URL is at most 8192 bytes'
const UNRESERVED_OR_ESCAPED = /^(?:[\w.~-]|%[\dA-F]{2})*$/

/**
 * Reads the selection parameters exactly as sent, in request order.
 *
 * @param {URL} url
 */
function sentSelection (url) {
  const selection = { tags: [], keyPatterns: [] }
  for (const parameter of url.search.slice(1).split('&')) {
    const [name, value] = parameter.split('=')
    if (name !== 'selected_flag_tags' && name !== 'selected_flag_key_patterns') continue
    assert.match(value, UNRESERVED_OR_ESCAPED)
    const list = name === 'selected_flag_tags' ? selection.tags : selection.keyPatterns
    list.push(decodeURIComponent(value))
  }
  return selection
}

describe('OpenFeature flag selection', () => {
  let AgentlessConfigurationSource
  let config
  let configurationSource
  let count
  let increment
  let log
  let namespace

  beforeEach(() => {
    config = {
      DD_API_KEY: 'test-api-key',
      featureFlags: {
        DD_FEATURE_FLAGS_ENABLED: true,
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL: undefined,
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS: 30,
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_REQUEST_TIMEOUT_SECONDS: 5,
      },
      site: 'datadoghq.com',
      env: 'my env',
    }
    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }
    increment = sinon.spy()
    count = sinon.spy(() => ({ inc: increment }))
    namespace = sinon.spy(() => ({ count }))
    AgentlessConfigurationSource = sinon.stub()

    const flagSelection = proxyquire('../../src/openfeature/flag-selection', {
      '../log': log,
      '../telemetry/metrics': { manager: { namespace } },
    })
    configurationSource = proxyquire('../../src/openfeature/configuration_source', {
      '../log': log,
      './agentless_configuration_source': AgentlessConfigurationSource,
      './flag-selection': flagSelection,
    })
  })

  /**
   * @param {unknown} flagSelection
   */
  function createSourceConfig (flagSelection) {
    config.featureFlags.flagSelection = flagSelection
    const source = configurationSource.create(config, sinon.spy())
    assert.ok(source instanceof AgentlessConfigurationSource)
    return AgentlessConfigurationSource.lastCall.args[0]
  }

  /**
   * @param {string} reason
   * @param {string} [limit]
   */
  function assertDropped (reason, limit = LIMITS[reason]) {
    sinon.assert.calledOnceWithExactly(log.error, NOT_SENT, reason, limit)
  }

  describe('shared selection vectors', () => {
    assert.ok(
      existsSync(VECTORS_PATH),
      'The ffe-system-test-data submodule is missing; run `git submodule update --init`'
    )
    const { cases } = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'))
    const sdkCases = cases.filter(vector => vector.sdk)

    it('skips only the raw query cases, which have no SDK expectation', () => {
      assert.ok(sdkCases.length > 0, 'Expected SDK cases in the shared vectors')
      for (const vector of cases) {
        assert.strictEqual(vector.sdk === undefined, vector.rawQuery !== undefined, vector.name)
      }
    })

    for (const vector of sdkCases) {
      it(vector.name, () => {
        const option = {}
        if (vector.query.selected_flag_tags) option.tags = vector.query.selected_flag_tags
        if (vector.query.selected_flag_key_patterns) option.keyPatterns = vector.query.selected_flag_key_patterns

        const resolved = createSourceConfig(option)
        const sent = sentSelection(resolved.endpoint)

        if (vector.sdk.dropped) {
          assert.deepStrictEqual(sent, { tags: [], keyPatterns: [] })
          assert.strictEqual(resolved.endpoint.toString(), DEFAULT_ENDPOINT)
          assert.strictEqual(resolved.flagSelectionSent, false)
          assertDropped(vector.sdk.dropped)
          return
        }

        assert.deepStrictEqual(sent, vector.sdk.selection)
        const empty = vector.sdk.selection.tags.length === 0 && vector.sdk.selection.keyPatterns.length === 0
        assert.strictEqual(resolved.flagSelectionSent, !empty)
        if (empty) assert.strictEqual(resolved.endpoint.toString(), DEFAULT_ENDPOINT)
        sinon.assert.notCalled(log.error)
      })
    }
  })

  describe('request', () => {
    it('loads flagging-core only once a selection is set', () => {
      const flaggingCorePath = require.resolve('../../../../vendor/dist/@datadog/flagging-core')
      delete require.cache[flaggingCorePath]

      createSourceConfig(undefined)
      createSourceConfig(null)
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'
      configurationSource.create(config, sinon.spy())

      assert.strictEqual(require.cache[flaggingCorePath], undefined)

      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'agentless'
      createSourceConfig({ tags: ['mobile'] })

      assert.ok(require.cache[flaggingCorePath], 'Expected flagging-core to load for a selection')
    })

    it('leaves the request unchanged without a selection', () => {
      for (const flagSelection of [undefined, null]) {
        const resolved = createSourceConfig(flagSelection)

        assert.strictEqual(resolved.endpoint.toString(), DEFAULT_ENDPOINT)
        assert.strictEqual(resolved.flagSelectionSent, false)
      }
      sinon.assert.notCalled(log.error)
      sinon.assert.notCalled(log.warn)
      sinon.assert.notCalled(count)
    })

    it('sends tags before key patterns with RFC 3986 percent-encoding', () => {
      const resolved = createSourceConfig({
        keyPatterns: ['checkout.*'],
        tags: ['dept:r&d+qa #1%/?=', "!'()*", 'é~'],
      })

      assert.strictEqual(
        resolved.endpoint.toString(),
        `${DEFAULT_ENDPOINT}` +
        '&selected_flag_tags=%21%27%28%29%2A' +
        '&selected_flag_tags=dept%3Ar%26d%2Bqa%20%231%25%2F%3F%3D' +
        '&selected_flag_tags=%C3%A9~' +
        '&selected_flag_key_patterns=checkout.%2A'
      )
      assert.strictEqual(resolved.flagSelectionSent, true)
      sinon.assert.notCalled(log.error)
    })

    it('merges the selection into the query of a custom endpoint', () => {
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
        'https://flags.example.test/custom/ufc?tenant=one'

      const resolved = createSourceConfig({ tags: ['mobile'] })

      assert.strictEqual(
        resolved.endpoint.toString(),
        'https://flags.example.test/custom/ufc?tenant=one&selected_flag_tags=mobile'
      )
      assert.strictEqual(resolved.flagSelectionSent, true)
    })

    it('adds a query to a custom endpoint without one', () => {
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = 'http://127.0.0.1:8080'

      const resolved = createSourceConfig({ keyPatterns: ['search.*'] })

      assert.strictEqual(
        resolved.endpoint.toString(),
        'http://127.0.0.1:8080/api/v2/feature-flagging/config/rules-based/server?selected_flag_key_patterns=search.%2A'
      )
    })

    it('never logs the values of a selection that is sent', () => {
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
        'https://flags.example.test/custom/ufc?tenant=one'

      const resolved = createSourceConfig({ tags: ['SENTINEL_TAG'], keyPatterns: ['SENTINEL_PATTERN.*'] })

      assert.strictEqual(resolved.flagSelectionSent, true)
      sinon.assert.called(log.debug)
      const calls = [log.debug, log.warn, log.error].flatMap(spy => spy.args)
        .map(args => args.map(arg => typeof arg === 'function' ? arg() : arg))
      assert.doesNotMatch(inspect(calls, { depth: null }), /SENTINEL/)
    })

    it('pins flagging-core to the version the vendored provider depends on', () => {
      const { dependencies } = require('../../../../vendor/package.json')
      const { packages } = require('../../../../vendor/package-lock.json')

      const installed = packages['node_modules/@datadog/flagging-core'].version
      assert.strictEqual(dependencies['@datadog/flagging-core'], installed)
      assert.strictEqual(
        packages['node_modules/@datadog/openfeature-node-server/node_modules/@datadog/flagging-core'],
        undefined
      )
    })

    it('treats a null list as absent and ignores unknown keys', () => {
      const resolved = createSourceConfig({ tags: null, keyPatterns: ['search.*'], keys: ['ignored'] })

      assert.deepStrictEqual(sentSelection(resolved.endpoint), { tags: [], keyPatterns: ['search.*'] })
      sinon.assert.notCalled(log.error)
    })

    it('sends a request URL of exactly 8192 bytes and drops the selection one byte over', () => {
      const base = 'https://flags.example.test/ufc?pad='
      const parameter = '&selected_flag_tags=mobile'

      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
        base + 'p'.repeat(8192 - base.length - parameter.length)
      const atLimit = createSourceConfig({ tags: ['mobile'] })

      assert.strictEqual(atLimit.endpoint.toString().length, 8192)
      assert.strictEqual(atLimit.flagSelectionSent, true)
      sinon.assert.notCalled(log.error)

      const overLimitUrl = base + 'p'.repeat(8193 - base.length - parameter.length)
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = overLimitUrl
      const overLimit = createSourceConfig({ tags: ['mobile'] })

      assert.strictEqual(overLimit.endpoint.toString(), overLimitUrl)
      assert.strictEqual(overLimit.flagSelectionSent, false)
      assertDropped('too_many_values', URL_LIMIT)
    })

    it('measures the percent-encoded URL against the 8192-byte limit', () => {
      const tags = Array.from({ length: 31 }, (_, index) => `${String(index).padStart(2, '0')}${'%'.repeat(98)}`)

      const resolved = createSourceConfig({ tags })

      assert.strictEqual(resolved.endpoint.toString(), DEFAULT_ENDPOINT)
      assert.strictEqual(resolved.flagSelectionSent, false)
      assertDropped('too_many_values', URL_LIMIT)
    })
  })

  describe('dropped selection', () => {
    const malformed = {
      'a string': 'payments',
      'an array': ['payments'],
      'a number': 42,
      'a list that is not an array': { tags: 'payments' },
      'a non-string entry': { tags: ['payments', 1] },
      'a null entry': { keyPatterns: [null] },
      'an unpaired surrogate': { tags: ['\uD800payments'] },
    }

    for (const [name, flagSelection] of Object.entries(malformed)) {
      it(`reports malformed_selection for ${name} without logging the value`, () => {
        const resolved = createSourceConfig(flagSelection)

        assert.strictEqual(resolved.endpoint.toString(), DEFAULT_ENDPOINT)
        assert.strictEqual(resolved.flagSelectionSent, false)
        assertDropped('malformed_selection')
        assert.doesNotMatch(JSON.stringify(log.error.args), /payments/)
      })
    }

    it('reports malformed_selection when reading the option throws', () => {
      const flagSelection = {
        get tags () {
          throw new Error('payments')
        },
      }

      const resolved = createSourceConfig(flagSelection)

      assert.strictEqual(resolved.flagSelectionSent, false)
      assertDropped('malformed_selection')
      assert.doesNotMatch(JSON.stringify(log.error.args), /payments/)
    })

    it('reports malformed_selection when a list yields an unpaired surrogate after validation', () => {
      const tags = ['payments']
      Object.defineProperty(tags, Symbol.iterator, { value: function * () { yield '\uD800' } })

      const resolved = createSourceConfig({ tags })

      assert.strictEqual(resolved.endpoint.toString(), DEFAULT_ENDPOINT)
      assert.strictEqual(resolved.flagSelectionSent, false)
      assertDropped('malformed_selection')
    })

    describe('when flagging-core cannot be loaded', () => {
      beforeEach(() => {
        const flagSelection = proxyquire('../../src/openfeature/flag-selection', {
          '../log': log,
          '../telemetry/metrics': { manager: { namespace } },
          '../../../../vendor/dist/@datadog/flagging-core': null,
        })
        configurationSource = proxyquire('../../src/openfeature/configuration_source', {
          '../log': log,
          './agentless_configuration_source': AgentlessConfigurationSource,
          './flag-selection': flagSelection,
        })
      })

      it('loads the full configuration through the agentless source', () => {
        const resolved = createSourceConfig({ tags: ['mobile'] })

        assert.strictEqual(resolved.endpoint.toString(), DEFAULT_ENDPOINT)
        assert.strictEqual(resolved.flagSelectionSent, false)
        assertDropped('malformed_selection')
      })

      it('does not throw for Remote Config delivery', () => {
        config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'
        config.remoteConfig = { DD_REMOTE_CONFIGURATION_ENABLED: true }
        config.featureFlags.flagSelection = { tags: ['mobile'] }

        assert.strictEqual(configurationSource.create(config, sinon.spy()), undefined)
        sinon.assert.calledOnceWithExactly(log.warn, REMOTE_CONFIG_WARNING)
        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(count)
      })
    })

    it('logs and counts the reason and limit, never the values', () => {
      const tags = Array.from({ length: 32 }, (_, index) => `secret-tag-${index}`)

      createSourceConfig({ tags })

      assertDropped('too_many_values')
      assert.doesNotMatch(JSON.stringify(log.error.args), /secret-tag/)
      sinon.assert.calledWithExactly(namespace, 'tracers')
      sinon.assert.calledOnceWithExactly(count, 'flag_selection.dropped', { reason: 'too_many_values' })
      sinon.assert.calledOnceWithExactly(increment)
    })

    it('logs once per provider initialization and counts once per process per reason', () => {
      const tooManyTags = { tags: Array.from({ length: 32 }, (_, index) => `t${index}`) }

      createSourceConfig(tooManyTags)
      createSourceConfig(tooManyTags)
      createSourceConfig({ tags: ['x'.repeat(201)] })

      assert.deepStrictEqual(log.error.args, [
        [NOT_SENT, 'too_many_values', LIMITS.too_many_values],
        [NOT_SENT, 'too_many_values', LIMITS.too_many_values],
        [NOT_SENT, 'invalid_tag', LIMITS.invalid_tag],
      ])
      assert.deepStrictEqual(count.args, [
        ['flag_selection.dropped', { reason: 'too_many_values' }],
        ['flag_selection.dropped', { reason: 'invalid_tag' }],
      ])
      sinon.assert.calledTwice(increment)
    })

    it('logs nothing for a selection that is empty after canonicalization', () => {
      const resolved = createSourceConfig({ tags: [' ', ''], keyPatterns: [] })

      assert.strictEqual(resolved.endpoint.toString(), DEFAULT_ENDPOINT)
      assert.strictEqual(resolved.flagSelectionSent, false)
      sinon.assert.notCalled(log.error)
      sinon.assert.notCalled(count)
    })
  })

  describe('Remote Config delivery', () => {
    beforeEach(() => {
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'
      config.remoteConfig = { DD_REMOTE_CONFIGURATION_ENABLED: true }
    })

    for (const [name, flagSelection] of Object.entries({
      'a valid selection': { tags: ['mobile'] },
      'a selection that would be dropped': { tags: ['x'.repeat(201)] },
      'a malformed selection': 'mobile',
    })) {
      it(`warns once for ${name} and loads the full configuration`, () => {
        config.featureFlags.flagSelection = flagSelection

        const source = configurationSource.create(config, sinon.spy())

        assert.strictEqual(source, undefined)
        sinon.assert.notCalled(AgentlessConfigurationSource)
        sinon.assert.calledOnceWithExactly(log.warn, REMOTE_CONFIG_WARNING)
        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(count)
      })
    }

    for (const [name, flagSelection] of Object.entries({
      'no selection': undefined,
      'a null selection': null,
      'an empty selection': { tags: [' '], keyPatterns: [] },
    })) {
      it(`does not warn for ${name}`, () => {
        config.featureFlags.flagSelection = flagSelection

        configurationSource.create(config, sinon.spy())

        sinon.assert.notCalled(log.warn)
        sinon.assert.notCalled(log.error)
      })
    }

    it('warns about the selection alongside disabled Remote Configuration', () => {
      config.remoteConfig.DD_REMOTE_CONFIGURATION_ENABLED = false
      config.featureFlags.flagSelection = { tags: ['mobile'] }

      configurationSource.create(config, sinon.spy())

      sinon.assert.calledTwice(log.warn)
      sinon.assert.calledWithExactly(log.warn, REMOTE_CONFIG_WARNING)
    })
  })
})
