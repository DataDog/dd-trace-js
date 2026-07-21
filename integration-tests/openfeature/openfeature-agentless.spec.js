'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const zlib = require('node:zlib')
const { afterEach, before, beforeEach, describe, it } = require('mocha')
const { VERSION } = require('../../version')
const { sandboxCwd, useSandbox, spawnProc, stopProc } = require('../helpers')

const UFC = {
  createdAt: '2026-01-01T00:00:00.000Z',
  environment: { name: 'integration' },
  flags: {
    'agentless-integration-flag': {
      key: 'agentless-integration-flag',
      enabled: true,
      variationType: 'STRING',
      variations: {
        local: { key: 'local', value: 'loaded-from-agentless' },
      },
      allocations: [
        {
          key: 'agentless-integration-allocation',
          splits: [{ variationKey: 'local', shards: [] }],
          doLog: false,
        },
      ],
    },
  },
}

describe('OpenFeature agentless configuration integration', () => {
  let appFile
  let backend
  let backendUrl
  let cwd
  let observedRequests
  let proc

  useSandbox(
    ['@openfeature/server-sdk', '@openfeature/core'],
    false,
    [path.join(__dirname, 'app')]
  )

  before(() => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'app', 'agentless-evaluation.js')
  })

  beforeEach(async () => {
    observedRequests = []
    backend = http.createServer((request, response) => {
      observedRequests.push({
        url: request.url,
        headers: request.headers,
      })

      if (request.headers['if-none-match'] === '"agentless-integration"') {
        response.writeHead(304).end()
        return
      }

      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        ETag: '"agentless-integration"',
      })
      const body = JSON.stringify({
        data: {
          id: '1',
          type: 'universal-flag-configuration',
          attributes: UFC,
        },
      })
      response.end(zlib.gzipSync(body))
    })
    await new Promise((resolve, reject) => {
      backend.once('error', reject)
      backend.listen(0, '127.0.0.1', resolve)
    })
    backendUrl = `http://127.0.0.1:${backend.address().port}`

    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_API_KEY: 'integration-api-key',
        DD_FEATURE_FLAGS_ENABLED: 'true',
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL: backendUrl,
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS: '5',
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_REQUEST_TIMEOUT_SECONDS: '1',
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      },
    })
  })

  afterEach(async () => {
    await stopProc(proc)
    await new Promise(resolve => backend.close(resolve))
  })

  it('loads UFC from the default agentless source and evaluates locally', async () => {
    let details
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(`${proc.url}/evaluate`)
      details = await response.json()
      if (details.value === 'loaded-from-agentless') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    assert.strictEqual(details.value, 'loaded-from-agentless')
    assert.notStrictEqual(details.reason, 'ERROR')

    for (let attempt = 0; observedRequests.length < 2 && attempt < 350; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    assert.ok(observedRequests.length >= 2)
    assert.strictEqual(
      observedRequests[0].url,
      '/api/v2/feature-flagging/config/rules-based/server'
    )
    assert.strictEqual(observedRequests[0].headers['dd-api-key'], 'integration-api-key')
    assert.strictEqual(observedRequests[0].headers['accept-encoding'], 'gzip')
    assert.strictEqual(observedRequests[0].headers['dd-client-library-language'], 'nodejs')
    assert.strictEqual(observedRequests[0].headers['dd-client-library-version'], VERSION)
    assert.strictEqual(observedRequests[0].headers['dd-flagging-source-mode'], undefined)
    assert.strictEqual(observedRequests[1].headers['if-none-match'], '"agentless-integration"')
  })
})
