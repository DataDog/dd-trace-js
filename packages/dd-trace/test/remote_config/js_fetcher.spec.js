'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createServer } = require('node:http')

const { describe, it, beforeEach, afterEach } = require('mocha')

require('../setup/core')
const { UNACKNOWLEDGED, ACKNOWLEDGED, ERROR } = require('../../src/remote_config/apply_states')
const Capabilities = require('../../src/remote_config/capabilities')
const JsRemoteConfigFetcher = require('../../src/remote_config/js_fetcher')

const ASM_PATH = 'datadog/42/ASM_FEATURES/asm-1/config'
const APM_PATH = 'employee/APM_TRACING/apm-1/config'

/**
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

  return JSON.stringify({
    client_configs: configs.map(({ path }) => path),
    targets: Buffer.from(JSON.stringify({
      signed: { custom: { opaque_backend_state: `state-${targetsVersion}` }, targets, version: targetsVersion },
    }), 'utf8').toString('base64'),
    target_files: targetFiles,
  })
}

describe('JsRemoteConfigFetcher', () => {
  let server
  let requests
  let responses
  let fetcher

  beforeEach(async () => {
    requests = []
    responses = []

    server = createServer((req, res) => {
      const chunks = []
      req
        .on('data', (chunk) => chunks.push(chunk))
        .on('end', () => {
          requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
          // A queued entry is either a body (answered 200) or an explicit {status, body}. With
          // nothing queued the agent answers 404, which is how it reports remote config as off.
          const response = responses.shift() ?? { status: 404, body: '' }
          res.writeHead(response.status ?? 200, { 'content-type': 'application/json' })
          res.end(response.body ?? response)
        })
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

    fetcher = new JsRemoteConfigFetcher({
      clientId: 'client-id-1',
      runtimeId: 'runtime-id-1',
      service: 'js-service',
      env: 'js-env',
      appVersion: '1.2.3',
      tags: ['runtime-id:runtime-id-1'],
      processTags: ['entrypoint.type:script'],
      language: 'node',
      tracerVersion: '9.9.9',
      url: `http://127.0.0.1:${server.address().port}`,
      timeoutMs: 5000,
    })
  })

  afterEach(async () => {
    // The fetcher polls through dd-trace's shared exporter agent, which is `keepAlive: true`, so
    // the pooled socket outlives the test and `close` alone would wait out the server's 5s
    // keep-alive timeout -- the same 5s as mocha's hook timeout.
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  it('should report the client identity, products and capabilities', async () => {
    assert.deepStrictEqual(fetcher.setProductCapabilities(['ASM_FEATURES', 'ASM_DD'], ['ASM_ACTIVATION']), [])
    fetcher.setExtraServices(['other-service'])

    responses.push('{}')
    assert.deepStrictEqual(await fetchChanges(), [])

    assert.strictEqual(requests[0].path, '/v0.7/config')

    const { client, cached_target_files: cachedTargetFiles } = requests[0].body

    assert.strictEqual(client.id, 'client-id-1')
    assert.strictEqual(client.is_tracer, true)
    assert.deepStrictEqual(client.products, ['ASM_FEATURES', 'ASM_DD'])
    // ASM_ACTIVATION is bit 1, so a single 0x02 octet.
    assert.strictEqual(client.capabilities, Buffer.from([Number(Capabilities.ASM_ACTIVATION)]).toString('base64'))
    assert.deepStrictEqual(client.client_tracer, {
      runtime_id: 'runtime-id-1',
      language: 'node',
      tracer_version: '9.9.9',
      service: 'js-service',
      env: 'js-env',
      app_version: '1.2.3',
      extra_services: ['other-service'],
      tags: ['runtime-id:runtime-id-1'],
      process_tags: ['entrypoint.type:script'],
    })
    assert.deepStrictEqual(client.state, {
      root_version: 1,
      targets_version: 0,
      config_states: [],
      has_error: false,
      error: '',
      backend_client_state: '',
    })
    assert.deepStrictEqual(cachedTargetFiles, [])
  })

  it('should return the capability names it does not recognize', () => {
    assert.deepStrictEqual(fetcher.setProductCapabilities([], ['ASM_ACTIVATION', 'NOT_A_CAPABILITY']), [
      'NOT_A_CAPABILITY',
    ])
  })

  it('should diff successive polls into add, update and remove changes', async () => {
    responses.push(agentResponse([{ path: ASM_PATH, file: { asm: { enabled: true } }, version: 1 }], 1))

    assert.deepStrictEqual(await fetchChanges(), [{
      kind: 'add',
      path: ASM_PATH,
      product: 'ASM_FEATURES',
      configId: 'asm-1',
      name: 'config',
      version: 1,
      contents: '{"asm":{"enabled":true}}',
    }])

    // An unchanged config is not reported again.
    responses.push(agentResponse([{ path: ASM_PATH, file: { asm: { enabled: true } }, version: 1 }], 2))
    assert.deepStrictEqual(await fetchChanges(), [])

    responses.push(agentResponse([{ path: ASM_PATH, file: { asm: { enabled: false } }, version: 2 }], 3))
    const updated = await fetchChanges()
    assert.strictEqual(updated.length, 1)
    assert.strictEqual(updated[0].kind, 'update')
    assert.strictEqual(updated[0].version, 2)
    assert.strictEqual(updated[0].contents, '{"asm":{"enabled":false}}')

    responses.push(agentResponse([], 4))
    assert.deepStrictEqual(await fetchChanges(), [{
      kind: 'remove',
      path: ASM_PATH,
      product: 'ASM_FEATURES',
      configId: 'asm-1',
      name: 'config',
      version: 2,
    }])
  })

  it('should report removals before additions', async () => {
    responses.push(agentResponse([{ path: ASM_PATH, file: {}, version: 1 }], 1))
    await fetchChanges()

    responses.push(agentResponse([{ path: APM_PATH, file: {}, version: 1 }], 2))
    const changes = await fetchChanges()

    assert.deepStrictEqual(changes.map((change) => [change.kind, change.path]), [
      ['remove', ASM_PATH],
      ['add', APM_PATH],
    ])
  })

  it('should advertise cached files and the apply state set for each config', async () => {
    responses.push(agentResponse([{ path: ASM_PATH, file: { asm: { enabled: true } }, version: 1 }], 1))
    await fetchChanges()

    responses.push('{}')
    await fetchChanges()

    const raw = Buffer.from('{"asm":{"enabled":true}}', 'utf8')

    // Unacknowledged until the consumer reports otherwise.
    assert.deepStrictEqual(requests[1].body.client.state.config_states, [{
      id: 'asm-1',
      version: 1,
      product: 'ASM_FEATURES',
      apply_state: UNACKNOWLEDGED,
      apply_error: '',
    }])
    assert.deepStrictEqual(requests[1].body.cached_target_files, [{
      path: ASM_PATH,
      length: raw.length,
      hashes: [{ algorithm: 'sha256', hash: createHash('sha256').update(raw).digest('hex') }],
    }])
    assert.strictEqual(requests[1].body.client.state.targets_version, 1)
    assert.strictEqual(requests[1].body.client.state.backend_client_state, 'state-1')

    fetcher.setConfigState(ASM_PATH, ERROR, 'Error: could not apply')

    responses.push('{}')
    await fetchChanges()

    assert.deepStrictEqual(requests[2].body.client.state.config_states, [{
      id: 'asm-1',
      version: 1,
      product: 'ASM_FEATURES',
      apply_state: ERROR,
      apply_error: 'Error: could not apply',
    }])

    fetcher.setConfigState(ASM_PATH, ACKNOWLEDGED, '')

    responses.push('{}')
    await fetchChanges()

    assert.strictEqual(requests[3].body.client.state.config_states[0].apply_state, ACKNOWLEDGED)
  })

  it('should ignore an apply state for a config it does not know', () => {
    fetcher.setConfigState(ASM_PATH, ACKNOWLEDGED, '')
  })

  it('should treat a 404 as no changes, leaving the applied configs in place', async () => {
    responses.push(agentResponse([{ path: ASM_PATH, file: {}, version: 1 }], 1))
    await fetchChanges()

    // No queued response, so the agent answers 404: remote config is not enabled.
    assert.deepStrictEqual(await fetchChanges(), [])

    // The config is still advertised as cached, so a later poll does not re-add it.
    responses.push('{}')
    await fetchChanges()
    assert.strictEqual(requests[2].body.cached_target_files.length, 1)
  })

  it('should remove every config when the response omits client_configs', async () => {
    responses.push(agentResponse([{ path: ASM_PATH, file: {}, version: 1 }], 1))
    await fetchChanges()

    // The agent may leave empty fields out entirely rather than sending empty arrays.
    responses.push(JSON.stringify({
      targets: Buffer.from(JSON.stringify({
        signed: { custom: { opaque_backend_state: 's' }, targets: {}, version: 2 },
      }), 'utf8').toString('base64'),
    }))

    assert.deepStrictEqual(await fetchChanges(), [{
      kind: 'remove',
      path: ASM_PATH,
      product: 'ASM_FEATURES',
      configId: 'asm-1',
      name: 'config',
      version: 1,
    }])
  })

  it('should reject when the agent rejects the request', async () => {
    responses.push({ status: 500, body: 'no thanks' })

    await assert.rejects(fetchChanges(), { status: 500 })
  })

  it('should treat an empty response body as no changes', async () => {
    responses.push('')

    assert.deepStrictEqual(await fetchChanges(), [])
  })

  it('should treat an empty targets field as no changes', async () => {
    responses.push(JSON.stringify({ targets: '' }))

    assert.deepStrictEqual(await fetchChanges(), [])
  })

  it('should treat an empty config file as empty contents', async () => {
    const raw = Buffer.alloc(0)
    responses.push(JSON.stringify({
      client_configs: [ASM_PATH],
      targets: Buffer.from(JSON.stringify({
        signed: {
          custom: { opaque_backend_state: 's' },
          targets: {
            [ASM_PATH]: {
              custom: { v: 1 },
              hashes: { sha256: createHash('sha256').update(raw).digest('hex') },
              length: 0,
            },
          },
          version: 1,
        },
      }), 'utf8').toString('base64'),
      target_files: [{ path: ASM_PATH, raw: '' }],
    }))

    const changes = await fetchChanges()

    assert.strictEqual(changes.length, 1)
    assert.strictEqual(changes[0].contents, '')
  })

  it('should advertise every hash algorithm the index provides', async () => {
    const raw = Buffer.from('{}', 'utf8')
    responses.push(JSON.stringify({
      client_configs: [ASM_PATH],
      targets: Buffer.from(JSON.stringify({
        signed: {
          custom: { opaque_backend_state: 's' },
          targets: {
            [ASM_PATH]: {
              custom: { v: 1 },
              hashes: {
                sha256: createHash('sha256').update(raw).digest('hex'),
                sha512: createHash('sha512').update(raw).digest('hex'),
              },
              length: raw.length,
            },
          },
          version: 1,
        },
      }), 'utf8').toString('base64'),
      target_files: [{ path: ASM_PATH, raw: raw.toString('base64') }],
    }))
    await fetchChanges()

    responses.push('{}')
    await fetchChanges()

    assert.deepStrictEqual(requests[1].body.cached_target_files[0].hashes.map((hash) => hash.algorithm), [
      'sha256',
      'sha512',
    ])
  })

  it('should reject and report a target missing from the index', async () => {
    responses.push(JSON.stringify({
      client_configs: [ASM_PATH],
      targets: Buffer.from(JSON.stringify({
        signed: { custom: { opaque_backend_state: 's' }, targets: {}, version: 1 },
      }), 'utf8').toString('base64'),
      target_files: [],
    }))

    await assert.rejects(fetchChanges(), { message: `Unable to find target for path ${ASM_PATH}` })

    // The failure is reported to the agent on the next poll, then cleared.
    responses.push('{}')
    await fetchChanges()
    assert.strictEqual(requests[1].body.client.state.has_error, true)
    assert.strictEqual(requests[1].body.client.state.error, `Error: Unable to find target for path ${ASM_PATH}`)

    responses.push('{}')
    await fetchChanges()
    assert.strictEqual(requests[2].body.client.state.has_error, false)
    assert.strictEqual(requests[2].body.client.state.error, '')
  })

  it('should reject when a config file is missing from the response', async () => {
    const raw = Buffer.from('{}', 'utf8')
    responses.push(JSON.stringify({
      client_configs: [ASM_PATH],
      targets: Buffer.from(JSON.stringify({
        signed: {
          custom: { opaque_backend_state: 's' },
          targets: {
            [ASM_PATH]: {
              custom: { v: 1 },
              hashes: { sha256: createHash('sha256').update(raw).digest('hex') },
              length: raw.length,
            },
          },
          version: 1,
        },
      }), 'utf8').toString('base64'),
      target_files: [],
    }))

    await assert.rejects(fetchChanges(), { message: `Unable to find file for path ${ASM_PATH}` })
  })

  it('should retry additions after a later config fails validation', async () => {
    const configs = [
      { path: ASM_PATH, file: { asm: true }, version: 1 },
      { path: APM_PATH, file: { apm: true }, version: 1 },
    ]
    const invalidResponse = JSON.parse(agentResponse(configs, 1))
    invalidResponse.target_files.pop()
    responses.push(JSON.stringify(invalidResponse))

    await assert.rejects(fetchChanges(), { message: `Unable to find file for path ${APM_PATH}` })

    responses.push(agentResponse(configs, 1))
    const changes = await fetchChanges()

    assert.deepStrictEqual(changes.map(({ kind, path }) => [kind, path]), [
      ['add', ASM_PATH],
      ['add', APM_PATH],
    ])
  })

  it('should retry removals after a replacement config fails validation', async () => {
    responses.push(agentResponse([{ path: ASM_PATH, file: {}, version: 1 }], 1))
    await fetchChanges()

    const invalidResponse = JSON.parse(agentResponse([{ path: APM_PATH, file: {}, version: 1 }], 2))
    invalidResponse.target_files = []
    responses.push(JSON.stringify(invalidResponse))

    await assert.rejects(fetchChanges(), { message: `Unable to find file for path ${APM_PATH}` })

    responses.push(agentResponse([{ path: APM_PATH, file: {}, version: 1 }], 2))
    const changes = await fetchChanges()

    assert.deepStrictEqual(changes.map(({ kind, path }) => [kind, path]), [
      ['remove', ASM_PATH],
      ['add', APM_PATH],
    ])
  })

  it('should reject when a config path cannot be parsed', async () => {
    const path = 'datadog/42/confId/config'
    const raw = Buffer.from('{}', 'utf8')
    responses.push(JSON.stringify({
      client_configs: [path],
      targets: Buffer.from(JSON.stringify({
        signed: {
          custom: { opaque_backend_state: 's' },
          targets: {
            [path]: {
              custom: { v: 1 },
              hashes: { sha256: createHash('sha256').update(raw).digest('hex') },
              length: raw.length,
            },
          },
          version: 1,
        },
      }), 'utf8').toString('base64'),
      target_files: [{ path, raw: raw.toString('base64') }],
    }))

    await assert.rejects(fetchChanges(), { message: `Unable to parse path ${path}` })
  })

  function fetchChanges () {
    return new Promise((resolve, reject) => {
      fetcher.fetchChanges((error, changes) => {
        if (error) {
          reject(error)
        } else {
          resolve(changes)
        }
      })
    })
  }
})
