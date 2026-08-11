'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createServer } = require('node:http')

const { describe, it, before, beforeEach, afterEach } = require('mocha')

require('../setup/core')
const Capabilities = require('../../src/remote_config/capabilities')
const { ACKNOWLEDGED, ERROR } = require('../../src/remote_config/apply_states')
const RemoteConfig = require('../../src/remote_config')

const ASM_FEATURES_PATH = 'datadog/2/ASM_FEATURES/asm-features-1/config'
const APM_TRACING_PATH = 'employee/APM_TRACING/apm-tracing-1/config'

/**
 * Builds a `/v0.7/config` response body for the given configs, matching what the agent sends:
 * a base64 encoded TUF-like `targets` document plus the base64 encoded files themselves.
 *
 * @param {Array<{path: string, file: object, version: number}>} configs
 * @param {number} targetsVersion
 */
function agentResponse (configs, targetsVersion) {
  const targets = {}
  const targetFiles = []

  for (const { path, file, version } of configs) {
    const raw = Buffer.from(JSON.stringify(file), 'utf8')
    targets[path] = {
      custom: { v: version },
      hashes: { sha256: createHash('sha256').update(raw).digest('hex') },
      length: raw.length,
    }
    targetFiles.push({ path, raw: raw.toString('base64') })
  }

  const signed = {
    _type: 'targets',
    custom: {
      agent_refresh_interval: 5,
      opaque_backend_state: `backend-state-${targetsVersion}`,
    },
    expires: '2100-01-01T00:00:00.000000000Z',
    spec_version: '1.0.0',
    targets,
    version: targetsVersion,
  }

  return JSON.stringify({
    client_configs: configs.map(({ path }) => path),
    targets: Buffer.from(JSON.stringify({ signatures: [], signed }), 'utf8').toString('base64'),
    target_files: targetFiles,
  })
}

/**
 * `Client.capabilities` and `ClientState.backend_client_state` are protobuf `bytes` fields, which
 * libdatadog serializes as JSON arrays of octets rather than base64 strings. Both encodings are
 * accepted by the agent.
 *
 * @param {number[]} octets
 */
function toBigInt (octets) {
  let value = 0n
  for (const octet of octets) {
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

describe('the product and capability names the tracer sends', () => {
  before(function () {
    try {
      require('@datadog/libdatadog').load('remote_config')
    } catch {
      this.skip()
    }
  })

  // Every product the tracer subscribes to, across config/remote_config.js, appsec/remote_config.js,
  // openfeature/remote_config.js, debugger/index.js and proxy.js.
  const products = [
    'AGENT_CONFIG',
    'AGENT_TASK',
    'APM_TRACING',
    'ASM',
    'ASM_DATA',
    'ASM_DD',
    'ASM_FEATURES',
    'FFE_FLAGS',
    'LIVE_DEBUGGING',
  ]

  it('should all be recognized by libdatadog', () => {
    // These names cross a repo boundary: the keys of `capabilities.js` have to match libdatadog's
    // `RemoteConfigCapabilities` variants, and the products above its `RemoteConfigProduct`
    // variants. A mismatch is silent until a poll, where it degrades that product or capability, so
    // pin the whole set rather than the two or three a behavioural test happens to touch.
    const { RemoteConfigFetcher } = require('@datadog/libdatadog').load('remote_config')
    const capabilities = Object.keys(Capabilities)

    assert.ok(capabilities.length > 30, `expected the full capability list, got ${capabilities.length}`)

    const fetcher = new RemoteConfigFetcher({
      clientId: 'client-id',
      runtimeId: 'runtime-id',
      service: 'service',
      env: 'env',
      appVersion: '1.0.0',
      tags: [],
      processTags: [],
      language: 'node',
      tracerVersion: '1.2.3',
      url: 'http://127.0.0.1:8126',
      timeoutMs: 2000,
    })

    assert.deepStrictEqual(fetcher.setProductCapabilities(products, capabilities), [])
  })
})

describe('RemoteConfig with the libdatadog wasm client', () => {
  let server
  let requests
  let responses
  let rc
  let config
  let events

  before(function () {
    try {
      require('@datadog/libdatadog').load('remote_config')
    } catch {
      // The `remote_config` wasm module is only present in a `@datadog/libdatadog` build that ships it.
      this.skip()
    }
    require('../../src/process-tags').initialize()
  })

  beforeEach(async () => {
    requests = []
    responses = []
    events = []

    server = createServer((req, res) => {
      const chunks = []
      req
        .on('data', (chunk) => chunks.push(chunk))
        .on('end', () => {
          requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
          const response = responses.shift()
          res.writeHead(response === undefined ? 404 : 200, { 'content-type': 'application/json' })
          res.end(response ?? '')
        })
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

    config = {
      url: new URL(`http://127.0.0.1:${server.address().port}`),
      tags: { 'runtime-id': 'runtime-id-1' },
      service: 'native-rc-service',
      env: 'native-rc-env',
      version: '1.2.3',
      remoteConfig: { pollInterval: 5 },
    }

    rc = new RemoteConfig(config)
  })

  afterEach(async () => {
    rc.scheduler.stop()
    await new Promise((resolve) => server.close(resolve))
  })

  const poll = () => new Promise((resolve) => rc.poll(resolve))

  const recordEvents = (action, file, id) => {
    events.push({ action, file, id })
  }

  /**
   * Subscribing starts the scheduler, but the tests drive `poll()` themselves so that every
   * response is observed deterministically.
   *
   * @param {string} product
   * @param {(action: string, file: unknown, id: string) => void} [handler]
   */
  const handleProduct = (product, handler = recordEvents) => {
    rc.setProductHandler(product, handler)
    rc.scheduler.stop()
  }

  it('sends the tracer identity and the subscribed products and capabilities', async () => {
    handleProduct('ASM_FEATURES')
    rc.updateCapabilities(Capabilities.ASM_ACTIVATION, true)
    rc.updateCapabilities(Capabilities.ASM_IP_BLOCKING, true)

    responses.push('{}')
    await poll()

    assert.strictEqual(requests.length, 1)
    assert.strictEqual(requests[0].path, '/v0.7/config')

    const { client } = requests[0].body

    assert.strictEqual(client.is_tracer, true)
    assert.deepStrictEqual(client.products, ['ASM_FEATURES'])
    assert.strictEqual(client.client_tracer.language, 'node')
    assert.strictEqual(client.client_tracer.service, 'native-rc-service')
    assert.strictEqual(client.client_tracer.env, 'native-rc-env')
    assert.strictEqual(client.client_tracer.app_version, '1.2.3')
    assert.strictEqual(client.client_tracer.runtime_id, 'runtime-id-1')
    assert.ok(client.client_tracer.tags.includes(`_dd.rc.client_id:${client.id}`))
    assert.ok(client.client_tracer.process_tags.includes('entrypoint.type:script'))

    assert.strictEqual(
      toBigInt(client.capabilities),
      Capabilities.ASM_ACTIVATION | Capabilities.ASM_IP_BLOCKING
    )

    assert.deepStrictEqual(client.state, {
      root_version: 1,
      targets_version: 0,
      config_states: [],
      has_error: false,
      error: '',
      backend_client_state: [],
    })
  })

  it('applies, modifies and unapplies configs, and acknowledges them to the agent', async () => {
    handleProduct('ASM_FEATURES')

    responses.push(agentResponse([{ path: ASM_FEATURES_PATH, file: { asm: { enabled: true } }, version: 1 }], 1))
    await poll()

    assert.deepStrictEqual(events, [
      { action: 'apply', file: { asm: { enabled: true } }, id: 'asm-features-1' },
    ])
    assert.strictEqual(rc.appliedConfigs.get(ASM_FEATURES_PATH).apply_state, ACKNOWLEDGED)

    responses.push(agentResponse([{ path: ASM_FEATURES_PATH, file: { asm: { enabled: false } }, version: 2 }], 2))
    await poll()

    assert.deepStrictEqual(events.at(-1), {
      action: 'modify',
      file: { asm: { enabled: false } },
      id: 'asm-features-1',
    })

    // The second request must report the first config as acknowledged, and advertise it as cached
    // so the agent can skip resending it.
    const { client, cached_target_files: cachedTargetFiles } = requests[1].body

    assert.strictEqual(client.state.targets_version, 1)
    assert.deepStrictEqual(
      Buffer.from(client.state.backend_client_state).toString('utf8'),
      'backend-state-1'
    )
    assert.deepStrictEqual(client.state.config_states, [{
      id: 'asm-features-1',
      version: 1,
      product: 'ASM_FEATURES',
      apply_state: ACKNOWLEDGED,
      apply_error: '',
    }])
    assert.strictEqual(cachedTargetFiles.length, 1)
    assert.strictEqual(cachedTargetFiles[0].path, ASM_FEATURES_PATH)

    responses.push(agentResponse([], 3))
    await poll()

    assert.deepStrictEqual(events.at(-1), {
      action: 'unapply',
      file: { asm: { enabled: false } },
      id: 'asm-features-1',
    })
    assert.strictEqual(rc.appliedConfigs.size, 0)

    // Version 2 is what the third request reported, so the config is gone from the fourth one.
    assert.deepStrictEqual(requests[2].body.client.state.config_states, [{
      id: 'asm-features-1',
      version: 2,
      product: 'ASM_FEATURES',
      apply_state: ACKNOWLEDGED,
      apply_error: '',
    }])

    responses.push('{}')
    await poll()

    assert.deepStrictEqual(requests[3].body.client.state.config_states, [])
    assert.deepStrictEqual(requests[3].body.cached_target_files, [])
  })

  it('reports a handler failure back to the agent', async () => {
    handleProduct('ASM_FEATURES', () => {
      throw new Error('handler failed')
    })

    responses.push(agentResponse([{ path: ASM_FEATURES_PATH, file: { asm: { enabled: true } }, version: 1 }], 1))
    await poll()

    responses.push('{}')
    await poll()

    assert.deepStrictEqual(requests[1].body.client.state.config_states, [{
      id: 'asm-features-1',
      version: 1,
      product: 'ASM_FEATURES',
      apply_state: ERROR,
      apply_error: 'Error: handler failed',
    }])
  })

  it('dispatches configs of the employee source to their product handler', async () => {
    const file = { lib_config: { tracing_enabled: false } }

    handleProduct('APM_TRACING')

    responses.push(agentResponse([{ path: APM_TRACING_PATH, file, version: 7 }], 1))
    await poll()

    assert.deepStrictEqual(events, [{ action: 'apply', file, id: 'apm-tracing-1' }])
  })

  it('keeps polling after the agent reports remote config as inactive', async () => {
    handleProduct('ASM_FEATURES')

    // No queued response, so the fake agent answers 404, which means remote config is not enabled.
    await poll()
    assert.strictEqual(requests.length, 1)

    responses.push(agentResponse([{ path: ASM_FEATURES_PATH, file: { asm: { enabled: true } }, version: 1 }], 1))
    await poll()

    assert.deepStrictEqual(events, [
      { action: 'apply', file: { asm: { enabled: true } }, id: 'asm-features-1' },
    ])
  })

  it('re-applies configs after the agent reports remote config as inactive', async () => {
    handleProduct('ASM_FEATURES')

    responses.push(agentResponse([{ path: ASM_FEATURES_PATH, file: { asm: { enabled: true } }, version: 1 }], 1))
    await poll()
    assert.strictEqual(rc.appliedConfigs.size, 1)

    // 404 means remote config is off, so every config is unapplied. It also has to invalidate the
    // cached state, or the agent answers "you are up to date" below and the configs are never
    // delivered again.
    await poll()
    assert.deepStrictEqual(events.at(-1), {
      action: 'unapply',
      file: { asm: { enabled: true } },
      id: 'asm-features-1',
    })
    assert.strictEqual(rc.appliedConfigs.size, 0)

    // Same targets version the client already saw before the 404.
    responses.push(agentResponse([{ path: ASM_FEATURES_PATH, file: { asm: { enabled: true } }, version: 1 }], 1))
    await poll()

    assert.deepStrictEqual(events.at(-1), {
      action: 'apply',
      file: { asm: { enabled: true } },
      id: 'asm-features-1',
    })
    assert.strictEqual(rc.appliedConfigs.size, 1)
  })

  it('reports extra services discovered at runtime', async () => {
    const { registerExtraService, clear } = require('../../src/service-naming/extra-services')

    try {
      handleProduct('ASM_FEATURES')

      responses.push('{}')
      await poll()
      assert.deepStrictEqual(requests[0].body.client.client_tracer.extra_services, [])

      registerExtraService('discovered-service')

      responses.push('{}')
      await poll()
      assert.deepStrictEqual(requests[1].body.client.client_tracer.extra_services, ['discovered-service'])
    } finally {
      clear()
    }
  })
})
