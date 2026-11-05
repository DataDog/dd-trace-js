'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { describe, it } = require('mocha')

const {
  configurationToString,
  ConfigurationFetchError,
  fetchRulesConfiguration,
} = require('../../../../openfeature/rules-based')
const { configurationFromString } = require('../../../../vendor/dist/@datadog/openfeature-node-server/rules-based')
// Shared portable-wire fixture from openfeature-js-client's browser interoperability tests.
const fixture = require('./fixtures/rules-wire.json')

const repoRoot = path.resolve(__dirname, '../../../..')
const bytes = Buffer.from(fixture.rules.response, 'base64')

describe('standalone OpenFeature configuration helpers', () => {
  for (const distributionChannel of ['client', 'server']) {
    it(`fetches ${distributionChannel} rules and round-trips portable configuration`, async () => {
      let requests = 0
      const options = distributionChannel === 'client'
        ? { distributionChannel, clientToken: 'test-client-token' }
        : { apiKey: 'test-api-key' }
      const configuration = await fetchRulesConfiguration({
        ...options,
        env: 'production',
        fetch: async (url, request) => {
          requests++
          const endpoint = new URL(url)
          assert.strictEqual(endpoint.pathname, `/api/v2/feature-flagging/config/rules-based/${distributionChannel}`)
          assert.strictEqual(endpoint.searchParams.get('dd_env'), 'production')
          assert.strictEqual(request.headers.Accept, 'application/protobuf')
          assert.strictEqual(request.headers['dd-client-token'], options.clientToken)
          assert.strictEqual(request.headers['dd-api-key'], options.apiKey)
          assert.strictEqual(request.redirect, 'manual')
          return new Response(bytes, {
            headers: { 'Content-Type': 'application/protobuf', ETag: fixture.rules.etag },
          })
        },
      })

      const wire = configurationToString(configuration)
      assert.strictEqual(typeof wire, 'string')
      const restored = configurationFromString(wire)
      const expected = configurationFromString(JSON.stringify(fixture))
      assert.deepStrictEqual(restored.rules.response, expected.rules.response)
      assert.strictEqual(restored.rules.etag, fixture.rules.etag)
      assert.strictEqual(restored.rules.fetchedAt, configuration.rules.fetchedAt)
      assert.strictEqual(requests, 1)
    })
  }

  it('serializes the configuration from the browser SDK wire fixture', () => {
    const configuration = configurationFromString(JSON.stringify(fixture))
    assert.deepStrictEqual(configurationFromString(configurationToString(configuration)), configuration)
  })

  for (const { name, response, code, status } of [
    { name: 'HTTP failure', response: () => new Response(null, { status: 403 }), code: 'http', status: 403 },
    {
      name: 'invalid protobuf',
      response: () => new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/protobuf' } }),
      code: 'decode',
      status: undefined,
    },
  ]) {
    it(`preserves typed errors for ${name}`, async () => {
      await assert.rejects(fetchRulesConfiguration({
        distributionChannel: 'client',
        clientToken: 'test-token',
        env: 'test',
        fetch: async () => response(),
      }), error => {
        assert.ok(error instanceof ConfigurationFetchError)
        assert.strictEqual(error.code, code)
        assert.strictEqual(error.status, status)
        return true
      })
    })
  }

  it('rejects incompatible credentials without fetching', async () => {
    await assert.rejects(fetchRulesConfiguration({
      clientToken: 'test-token',
      env: 'test',
      fetch: async () => assert.fail('Invalid options must not make a request'),
    }), { name: 'ConfigurationFetchError', code: 'invalid_options' })
  })

  for (const format of ['commonjs', 'module']) {
    for (const entry of ['openfeature.js', 'openfeature/rules-based.js']) {
      it(`loads ${entry} as ${format} with isolated dependencies`, () => {
        const entrypoint = path.join(repoRoot, entry)
        const isRulesBased = entry === 'openfeature/rules-based.js'
        const load = format === 'module'
          ? `import * as helpers from ${JSON.stringify(pathToFileURL(entrypoint).href)};
            import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`
          : `const helpers = require(${JSON.stringify(entrypoint)});`
        const result = spawnSync(process.execPath, [`--input-type=${format}`, '-e', `
        ${load}
        const assert = require('node:assert/strict')
        const expectedType = ${JSON.stringify(isRulesBased ? 'function' : 'undefined')}
        for (const name of ${JSON.stringify([
          'configurationToString', 'ConfigurationFetchError', 'fetchRulesConfiguration',
        ])}) assert.strictEqual(typeof helpers[name], expectedType, name)
        assert.strictEqual(helpers.configurationFromString, undefined)
        assert.strictEqual(helpers.configurationFromRulesBinary, undefined)
        const rulesBundle = require.resolve(${JSON.stringify(
          path.join(repoRoot, 'vendor/dist/@datadog/openfeature-node-server/rules-based')
        )})
        assert.strictEqual(require.cache[rulesBundle] !== undefined, ${isRulesBased})
        assert.strictEqual(globalThis[Symbol.for('dd-trace')], undefined)
        const loaded = Object.keys(require.cache).map(file => file.replaceAll('\\\\', '/'))
        assert.ok(!loaded.some(file =>
          file.includes('packages/dd-trace/src') || file.includes('node_modules/@openfeature/')))
      `], { cwd: repoRoot, encoding: 'utf8', timeout: 5000 })
        assert.ifError(result.error)
        assert.strictEqual(result.status, 0, result.stderr)
      })
    }
  }
})
