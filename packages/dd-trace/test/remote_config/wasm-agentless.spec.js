'use strict'

const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { format } = require('node:util')
const { gzipSync } = require('node:zlib')

const { describe, it } = require('mocha')
const nock = require('nock')
const proxyquire = require('proxyquire')

require('../setup/core')
const { enable } = require('../../src/config/remote_config')
const processTags = require('../../src/process-tags')
const WasmClient = require('../../src/remote_config/wasm-client')

const wasmPath = process.env.DD_RC_TEST_WASM
const fixturePath = process.env.DD_RC_TEST_AGENTLESS_FIXTURE
const suite = wasmPath === undefined || fixturePath === undefined ? describe.skip : describe

suite('RemoteConfig WASI Agentless host', () => {
  it('keeps the installed APM value through verification and transport failures', async () => {
    const { agentlessFixture } = await import(pathToFileURL(resolve(fixturePath)).href)
    const refreshSeconds = 21
    const fixture = agentlessFixture('datadog/2/APM_TRACING/signed/config', version => ({
      sdk_config: { config: { DD_TRACE_SAMPLE_RATE: String(version / 10) } },
    }), refreshSeconds)
    const { configRoot, directorRoot, apiKey } = fixture.options

    /** @param {ConstructorParameters<typeof WasmClient>} args */
    function fixtureClient (...args) {
      const [artifact, options, agentUrl, watch] = args
      const testOptions = { ...options, configRoot, directorRoot }
      return new WasmClient(artifact, testOptions, agentUrl, watch)
    }

    const originalEnv = process.env
    process.env = {
      ...originalEnv,
      _DD_REMOTE_CONFIG_WASM_PATH: wasmPath,
      DD_AGENTLESS_ENABLED: 'true',
      DD_API_KEY: apiKey,
      DD_SITE: 'test.invalid',
      DD_SERVICE: 'wasm-agentless',
      no_proxy: '*',
    }
    nock.disableNetConnect()
    let rc
    try {
      const errors = []
      const isolatedChannels = { channel: () => ({ subscribe () {}, publish () {} }) }
      const RemoteConfig = proxyquire('../../src/remote_config', {
        'dc-polyfill': isolatedChannels,
        './wasm-client': fixtureClient,
        '../log': {
          errorWithoutTelemetry: (...args) => errors.push(format(...args)),
        },
      })
      const createFixtureConfig = proxyquire('../../src/config', { 'dc-polyfill': isolatedChannels })
      const config = createFixtureConfig()
      const initialRate = config.sampleRate
      processTags.initialize(config)
      rc = new RemoteConfig(config)
      const installed = []
      enable(rc, config, () => installed.push(config.sampleRate))
      rc.scheduler.stop()

      const authority = 'https://config.test.invalid'
      const reqheaders = { 'dd-api-key': apiKey, 'content-type': 'application/x-protobuf' }
      const protobuf = { 'content-type': 'application/x-protobuf' }

      /**
       * @param {Buffer} reply
       * @param {{ organization?: boolean, gzip?: boolean }} [options]
       */
      async function receive (reply, { organization = false, gzip = false } = {}) {
        const intake = nock(authority, { reqheaders })
        if (organization) {
          intake.get('/api/v0.1/org').reply(200, fixture.org, protobuf)
        }
        const headers = gzip ? { ...protobuf, 'content-encoding': 'gzip' } : protobuf
        intake.post('/api/v0.1/configurations').reply(200, gzip ? gzipSync(reply) : reply, headers)
        const minimumDelay = await new Promise(resolve => rc.poll(resolve))
        intake.done()
        return minimumDelay
      }

      await receive(fixture.response(1, 'signature').protobuf, { organization: true })
      assert.match(errors.shift(), /signature threshold/i)
      assert.deepEqual(installed, [])
      assert.equal(config.sampleRate, initialRate)

      const acceptedDelay = await receive(fixture.response(1).protobuf, { organization: true, gzip: true })
      assert.deepEqual(errors, [])
      assert.deepEqual(installed, [0.1])
      assert.equal(acceptedDelay, refreshSeconds * 1000)

      const rejectedDelay = await receive(fixture.response(2, 'hash').protobuf)
      assert.match(errors.shift(), /hash/i)
      assert.deepEqual(installed, [0.1])
      assert.equal(config.sampleRate, 0.1)
      assert.ok(rejectedDelay >= 30_000 && rejectedDelay <= 60_000, `Unexpected backoff: ${rejectedDelay}`)

      const recoveredDelay = await receive(fixture.response(2).protobuf, { organization: true })
      assert.deepEqual(errors, [])
      assert.deepEqual(installed, [0.1, 0.2])
      assert.equal(config.sampleRate, 0.2)
      assert.equal(recoveredDelay, acceptedDelay)

      const disconnected = nock(authority, { reqheaders }).post('/api/v0.1/configurations')
        .replyWithError(Object.assign(new Error('Remote Config connection reset'), { code: 'ECONNRESET' }))
      const disconnectedDelay = await new Promise(resolve => rc.poll(resolve))
      disconnected.done()
      assert.match(errors.shift(), /Remote Config connection reset/)
      assert.deepEqual(installed, [0.1, 0.2])
      assert.equal(config.sampleRate, 0.2)
      assert.ok(disconnectedDelay >= 30_000 && disconnectedDelay <= 60_000, `Unexpected backoff: ${disconnectedDelay}`)

      assert.equal(await receive(fixture.response(3).protobuf), acceptedDelay)
      assert.deepEqual(errors, [])
      assert.deepEqual(installed, [0.1, 0.2, 0.3])
      assert.equal(config.sampleRate, 0.3)
    } finally {
      rc?.scheduler.stop()
      nock.cleanAll()
      nock.enableNetConnect()
      process.env = originalEnv
    }
  })
})
