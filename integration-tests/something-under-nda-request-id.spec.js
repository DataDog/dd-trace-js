'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')

const {
  FakeAgent,
  spawnProc,
  stopProc,
  sandboxCwd,
  useSandbox,
} = require('./helpers')

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<void>}
 */
function curlWithHeaders (url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, res => {
      res.resume()
      res.once('end', resolve)
      res.once('error', reject)
    }).once('error', reject)
  })
}

describe('something-under-nda request id auto-tag', () => {
  let agent, proc, cwd, fixtureFile

  useSandbox([])

  before(() => {
    cwd = sandboxCwd()
    fixtureFile = path.join(cwd, 'something-under-nda-request-id/index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  it('should auto-tag span with lambda.request_id under something-under-nda', async () => {
    proc = await spawnProc(fixtureFile, {
      cwd,
      env: {
        AGENT_PORT: agent.port,
        DD_TRACE_AGENT_PORT: agent.port,
        SOMETHING_UNDER_NDA: 'something-under-nda',
      },
    })

    const assertion = agent.assertMessageReceived(({ payload }) => {
      const span = payload[0][0]
      assert.strictEqual(span.name, 'web.request')
      assert.strictEqual(span.meta['lambda.request_id'], 'req-abc-123')
    })

    await curlWithHeaders(proc.url, { 'lambda-web-request-id': 'req-abc-123' })
    await assertion
  })
})
