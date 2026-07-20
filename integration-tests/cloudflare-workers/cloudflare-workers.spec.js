'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { unstable_dev: unstableDev } = require('wrangler')

const { FakeAgent } = require('../helpers')

const FIXTURES_DIR = path.join(__dirname, 'fixtures')
const CONFIG_TEMPLATE_PATH = path.join(FIXTURES_DIR, 'wrangler.jsonc')
const GENERATED_CONFIG_PATH = path.join(FIXTURES_DIR, 'wrangler.generated.json')
const WORKER_PATH = path.join(FIXTURES_DIR, 'worker.mjs')

/**
 * Resolves once the FakeAgent receives an OTLP traces POST, or rejects on timeout.
 * The Worker's export is fire-and-forget from workerd's perspective (see worker.mjs),
 * so an HTTP 200 from `worker.fetch()` proves nothing by itself — only this event proves
 * the span actually left the isolate over OTLP.
 *
 * @param {import('../helpers/fake-agent')} agent
 * @param {number} timeout
 * @returns {Promise<{ headers: Record<string, string>, payload: object }>}
 */
function waitForOtlpTraces (agent, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for OTLP traces')), timeout)
    agent.once('otlp-traces', (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
  })
}

describe('Cloudflare Workers (workerd) acceptance test', function () {
  this.timeout(60_000)

  let agent
  let worker

  before(async () => {
    agent = await new FakeAgent().start()

    // wrangler.jsonc's "vars" are static, but the FakeAgent's port is only known at
    // runtime, so template the endpoint into a generated config used just for this run.
    const template = fs.readFileSync(CONFIG_TEMPLATE_PATH, 'utf8')
    const endpoint = `http://127.0.0.1:${agent.port}/v1/traces`
    fs.writeFileSync(GENERATED_CONFIG_PATH, template.replaceAll('__OTLP_ENDPOINT__', endpoint))

    worker = await unstableDev(WORKER_PATH, {
      config: GENERATED_CONFIG_PATH,
      experimental: { disableExperimentalWarning: true },
    })
  })

  after(async () => {
    await worker?.stop()
    await agent?.stop()
    fs.rmSync(GENERATED_CONFIG_PATH, { force: true })
  })

  it('loads, initializes, and exports a span over OTLP from inside real workerd', async () => {
    const tracesPromise = waitForOtlpTraces(agent, 15_000)

    const response = await worker.fetch('/')
    assert.strictEqual(response.status, 200)

    const { payload } = await tracesPromise

    const resourceSpan = payload.resourceSpans[0]
    const serviceNameAttribute = resourceSpan.resource.attributes.find(
      (attribute) => attribute.key === 'service.name'
    )
    assert.deepStrictEqual(serviceNameAttribute.value, { stringValue: 'cf-workers-ci' })

    const span = resourceSpan.scopeSpans[0].spans.find((candidate) => candidate.name === 'cf.worker.test')
    assert.ok(span, 'expected an OTLP span named "cf.worker.test"')
  })
})
