'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { json } = require('../../packages/dd-trace/src/appsec/blocking/templates')
const { assertObjectContains, FakeAgent, sandboxCwd, spawnProc, stopProc, useSandbox } = require('../helpers')

const ACKNOWLEDGED = 2
const ERROR = 3
const ASM_RESPONSE_BLOCKING = 1n << 6n

const RESPONSE_STATUS_RULE = {
  id: 'test-response-status-rule',
  name: 'Block responses with a 404 status',
  tags: { type: 'security_scanner', category: 'attack_attempt' },
  conditions: [
    {
      operator: 'match_regex',
      parameters: { inputs: [{ address: 'server.response.status' }], regex: '^404$' },
    },
  ],
  transformers: [],
  on_match: ['block'],
}

/**
 * @param {FakeAgent} agent
 * @param {(body: { client: { products: string[], capabilities: string } }) => boolean} predicate
 * @returns {Promise<{ client: { products: string[], capabilities: string } }>}
 */
function waitForRemoteConfigRequest (agent, predicate) {
  return new Promise(resolve => {
    const onRequest = (body) => {
      if (!predicate(body)) return
      agent.removeListener('remote-config-request', onRequest)
      resolve(body)
    }
    agent.on('remote-config-request', onRequest)
  })
}

/**
 * @param {FakeAgent} agent
 * @param {{ product: string, id: string, config: object }} remoteConfig
 * @returns {Promise<void>}
 */
function addRemoteConfigAndWaitForAck (agent, remoteConfig) {
  return new Promise((resolve, reject) => {
    const onAck = (id, version, state, error) => {
      if (id !== remoteConfig.id || (state !== ACKNOWLEDGED && state !== ERROR)) return
      agent.removeListener('remote-config-ack-update', onAck)
      if (state === ERROR) {
        reject(new Error(`Remote Config ${id} was rejected: ${error}`))
      } else {
        resolve()
      }
    }
    agent.on('remote-config-ack-update', onAck)
    agent.addRemoteConfig(remoteConfig)
  })
}

/**
 * @param {string} capabilities - base64 encoded capabilities bitfield
 */
function decodeCapabilities (capabilities) {
  return BigInt(`0x${Buffer.from(capabilities, 'base64').toString('hex')}`)
}

describe('AppSec response blocking with Remote Configuration', () => {
  let cwd, appFile, agent, proc

  useSandbox(['express'], false, [path.join(__dirname, 'response-blocking')])

  before(() => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'response-blocking', 'index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_APPSEC_ENABLED: 'true',
        DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '0.1',
      },
    })
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  it('should advertise response blocking and block on a response rule received from Remote Config', async () => {
    const { client } = await waitForRemoteConfigRequest(agent, ({ client }) => client.products.includes('ASM'))

    assert.strictEqual(decodeCapabilities(client.capabilities) & ASM_RESPONSE_BLOCKING, ASM_RESPONSE_BLOCKING)

    await addRemoteConfigAndWaitForAck(agent, {
      product: 'ASM',
      id: 'response-status-rule',
      config: { custom_rules: [RESPONSE_STATUS_RULE] },
    })

    const [response] = await Promise.all([
      fetch(new URL('/unknown-route', proc.url)),
      agent.assertMessageReceived(({ payload }) => {
        const span = payload.flat().find(span => span.name === 'express.request')
        assert.ok(span, 'express.request span should exist')
        assertObjectContains(span.meta, {
          'appsec.blocked': 'true',
          'http.status_code': '403',
        })
      }),
    ])

    assert.strictEqual(response.status, 403)
    assert.deepStrictEqual((await response.json()).errors, JSON.parse(json).errors)
  })
})
