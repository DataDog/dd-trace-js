'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { once } = require('node:events')
const { createServer } = require('node:http')
const path = require('node:path')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')

const run = promisify(execFile)
const tracerPath = path.resolve(__dirname, '../..')

/** @param {(urls: string[], requests: { path: string, body: string }[][]) => Promise<void>} test */
async function withAgents (test) {
  const requests = [[], []]
  const agents = requests.map(received => createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.once('end', () => {
      received.push({ path: request.url, body: Buffer.concat(chunks).toString() })
      response.end('{}')
    })
  }))

  try {
    await Promise.all(agents.map(async agent => {
      agent.listen(0, '127.0.0.1')
      await once(agent, 'listening')
    }))
    const urls = agents.map(agent => `http://127.0.0.1:${agent.address().port}`)
    await test(urls, requests)
  } finally {
    await Promise.all(agents.map(agent => {
      const close = promisify(agent.close.bind(agent))
      return close()
    }))
  }
}

/**
 * @param {string} script
 * @param {import('node:child_process').ExecFileOptions['env']} [env]
 */
async function runTracer (script, env = {}) {
  await run(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_CRASHTRACKING_ENABLED: 'false',
      DD_PROFILING_HEAP_ENABLED: 'false',
      DD_PROFILING_TIMELINE_ENABLED: 'false',
      ...env,
    },
  })
}

describe('runtime Agent configuration', function () {
  this.timeout(30000)

  for (const enabled of [true, false]) {
    it(`moves profile uploads after setUrl with APM tracing ${enabled ? 'enabled' : 'disabled'}`, async function () {
      if (process.platform === 'win32') this.skip()
      await withAgents(async (urls, requests) => {
        await runTracer(`
          const assert = require('node:assert/strict')
          const tracer = require(${JSON.stringify(tracerPath)}).init({
            url: ${JSON.stringify(urls[0])},
            apmTracingEnabled: ${enabled},
            profiling: true,
            flushInterval: 0,
            plugins: false,
          })
          assert.strictEqual(tracer.setUrl(${JSON.stringify(urls[1])}), tracer)
          tracer.profilerStarted().then(started => assert.strictEqual(started, true))
          tracer.trace('updated-agent', () => {})
        `)

        assert.strictEqual(requests[0].filter(({ path }) => path === '/profiling/v1/input').length, 0)
        assert.strictEqual(requests[1].filter(({ path }) => path === '/profiling/v1/input').length, 1)
        if (enabled) assert.strictEqual(requests[1].filter(({ path }) => path === '/v0.4/traces').length, 1)
      })
    })
  }

  it('uses the updated Agent when Data Streams activates after setUrl', async () => {
    await withAgents(async (urls, requests) => {
      const processorPath = path.join(tracerPath, 'packages/dd-trace/src/datastreams/processor')
      await runTracer(`
        const assert = require('node:assert/strict')
        const tracer = require(${JSON.stringify(tracerPath)}).init({
          url: ${JSON.stringify(urls[0])},
          dsmEnabled: true,
          flushInterval: 0,
          plugins: false,
        })
        tracer.setUrl(${JSON.stringify(urls[1])})
        assert.strictEqual(require.cache[require.resolve(${JSON.stringify(processorPath)})], undefined)
        tracer.dataStreamsCheckpointer.setProduceCheckpoint('kafka', 'events', {})
      `)

      assert.strictEqual(requests[0].filter(({ path }) => path === '/v0.1/pipeline_stats').length, 0)
      assert.strictEqual(requests[1].filter(({ path }) => path === '/v0.1/pipeline_stats').length, 1)
    })
  })

  it('routes LLMObs spans across disable, URL update, and re-enable', async () => {
    await withAgents(async (urls, requests) => {
      await runTracer(`
        const assert = require('node:assert/strict')
        const tracer = require(${JSON.stringify(tracerPath)}).init({
          url: ${JSON.stringify(urls[0])},
          flushInterval: 0,
          plugins: false,
        })
        tracer.llmobs.enable({ mlApp: 'first-app', agentlessEnabled: false })
        tracer.llmobs.trace({ kind: 'workflow', name: 'first-span' }, () => {})
        tracer.llmobs.flush()
        tracer.llmobs.disable()
        assert.strictEqual(tracer.llmobs.enabled, false)
        tracer.setUrl(${JSON.stringify(urls[1])})
        tracer.llmobs.enable({ mlApp: 'second-app', agentlessEnabled: false })
        assert.strictEqual(tracer.llmobs.enabled, true)
        tracer.llmobs.trace({ kind: 'workflow', name: 'second-span' }, () => {})
        tracer.llmobs.flush()
        tracer.llmobs.disable()
      `)

      const spans = requests.map(received => received
        .filter(({ path }) => path === '/evp_proxy/v2/api/v2/llmobs')
        .flatMap(({ body }) => JSON.parse(body).flatMap(event => event.spans)))
      assert.deepStrictEqual(spans[0].map(span => span.name), ['first-span'])
      assert.deepStrictEqual(spans[1].map(span => span.name), ['second-span'])
      assert.ok(spans[0][0].tags.includes('ml_app:first-app'))
      assert.ok(spans[1][0].tags.includes('ml_app:second-app'))
    })
  })

  for (const exporter of ['agentless', 'otlp']) {
    it(`preserves an explicit setUrl for ${exporter} across unrelated configuration updates`, async () => {
      await withAgents(async (urls, requests) => {
        await runTracer(`
          const tracer = require(${JSON.stringify(tracerPath)}).init({
            url: ${JSON.stringify(urls[0])},
            flushInterval: 0,
            plugins: false,
          })
          tracer.setUrl(${JSON.stringify(exporter === 'otlp' ? `${urls[1]}/v1/traces` : urls[1])})
          tracer.llmobs.enable({ mlApp: 'runtime', agentlessEnabled: false })
          tracer.llmobs.disable()
          tracer.trace('explicit-destination', () => {})
        `, exporter === 'agentless'
          ? { DD_TRACE_EXPERIMENTAL_EXPORTER: 'agentless', DD_API_KEY: 'test-api-key' }
          : { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${urls[0]}/v1/traces` })

        const intake = exporter === 'agentless' ? '/api/v2/spans' : '/v1/traces'
        assert.strictEqual(requests[0].filter(({ path }) => path === intake).length, 0)
        assert.strictEqual(requests[1].filter(({ path }) => path === intake).length, 1)
      })
    })
  }

  it('preserves the OTLP destination when a remote Agent URL is removed', async () => {
    await withAgents(async (urls, requests) => {
      await runTracer(`
        const tracer = require(${JSON.stringify(tracerPath)}).init({
          url: ${JSON.stringify(urls[0])},
          flushInterval: 0,
          plugins: false,
        })
        const config = require(${JSON.stringify(path.join(tracerPath, 'packages/dd-trace/src/config'))})()
        config.setRemoteConfig({ DD_TRACE_AGENT_URL: ${JSON.stringify(urls[1])} })
        config.setRemoteConfig(null)
        tracer.trace('independent-destination', () => {})
      `, { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${urls[1]}/v1/traces` })

      assert.strictEqual(requests[0].filter(({ path }) => path === '/' || path === '/v1/traces').length, 0)
      assert.strictEqual(requests[1].filter(({ path }) => path === '/v1/traces').length, 1)
    })
  })

  for (const exporter of ['agentless', 'llmobs']) {
    it(`preserves the independent ${exporter} destination when a remote Agent URL is removed`, async () => {
      await withAgents(async urls => {
        await runTracer(`
          const assert = require('node:assert/strict')
          const tracer = require(${JSON.stringify(tracerPath)}).init({
            url: ${JSON.stringify(urls[0])},
            plugins: false,
            llmobs: { mlApp: 'runtime', agentlessEnabled: true },
          })
          const config = require(${JSON.stringify(path.join(tracerPath, 'packages/dd-trace/src/config'))})()
          const exporter = tracer._tracer._exporter
          const destination = exporter._url.href
          config.setRemoteConfig({ DD_TRACE_AGENT_URL: ${JSON.stringify(urls[1])} })
          config.setRemoteConfig(null)
          assert.strictEqual(exporter._url.href, destination)
          assert.strictEqual(config.url.href, ${JSON.stringify(`${urls[0]}/`)})
        `, { DD_TRACE_EXPERIMENTAL_EXPORTER: exporter, DD_API_KEY: 'test-api-key' })
      })
    })
  }
})
