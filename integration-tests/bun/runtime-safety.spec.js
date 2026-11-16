'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { createSocket } = require('node:dgram')
const { once } = require('node:events')
const path = require('node:path')
const { promisify } = require('node:util')

const { BUN } = require('../helpers/bun')
const { FakeAgent, sandboxCwd, useSandbox } = require('../helpers')

const execFileAsync = promisify(execFile)

describe('Bun runtime safety', function () {
  this.timeout(30_000)

  useSandbox()
  let agent

  before(async () => {
    agent = await new FakeAgent().start()
  })

  after(async () => {
    await agent?.stop()
  })

  /** @param {Record<string, string>} env */
  async function runBun (env) {
    const cwd = sandboxCwd()
    const result = await execFileAsync(BUN, [path.join(cwd, 'bun/runtime-safety/app.js')], {
      cwd,
      timeout: 15_000,
      env: {
        ...process.env,
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_TRACE_STARTUP_LOGS: 'true',
        ...env,
      },
    })
    assert.match(result.stdout, /ok/)
    return result
  }

  it('should emit runtime metrics over UDP without crashing', async () => {
    const socket = createSocket('udp4')
    const messages = []
    socket.on('message', message => messages.push(message.toString()))
    socket.bind(0, '127.0.0.1')
    await once(socket, 'listening')

    try {
      await runBun({
        DD_RUNTIME_METRICS_ENABLED: 'true',
        DD_RUNTIME_METRICS_NATIVE: 'true',
        DD_RUNTIME_METRICS_FLUSH_INTERVAL: '100',
        DD_DOGSTATSD_HOSTNAME: '127.0.0.1',
        DD_DOGSTATSD_PORT: String(socket.address().port),
      })

      const metrics = messages.join('\n')
      for (const name of ['mem.rss', 'mem.heap_used', 'cpu.user', 'cpu.system', 'heap.total_heap_size']) {
        const match = metrics.match(new RegExp(`runtime\\.node\\.${name.replaceAll('.', '\\.')}:(-?[\\d.]+)\\|g`))
        assert.ok(match, `Expected runtime.node.${name} gauge in: ${metrics}`)
        assert.ok(Number.isFinite(Number(match[1])), `Expected a finite runtime.node.${name} value`)
      }
      assert.doesNotMatch(metrics, /runtime\.node\.[^:]+:(?:NaN|Infinity)\|/)
    } finally {
      await new Promise(resolve => socket.close(resolve))
    }
  })

  it('should disable IAST with a startup diagnostic instead of crashing', async () => {
    const { stdout, stderr } = await runBun({ DD_IAST_ENABLED: 'true' })
    const diagnostic = 'DATADOG TRACER DIAGNOSTIC - IAST is disabled, because it is not supported on Bun.'

    assert.strictEqual((stdout + stderr).split(diagnostic).length - 1, 1)
  })

  for (const env of [{}, { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_PROFILERS: 'space,wall' }]) {
    it(`should upload wall and timeline profiles without heap profiling with ${JSON.stringify(env)}`, async () => {
      const profileReceived = agent.assertMessageReceived(({ files }) => {
        assert.ok(files, 'Expected a profiling upload')
        const event = JSON.parse(files.find(file => file.originalname === 'event.json').buffer.toString())
        assert.deepStrictEqual(event.attachments.sort(), ['events.pprof', 'wall.pprof'])
        assert.deepStrictEqual(event.info.profiler.settings.profilerTypes.sort(), ['events', 'wall'])
        for (const name of event.attachments) {
          assert.ok(files.find(file => file.originalname === name).buffer.length > 0)
        }
      }, 15_000)

      const [result] = await Promise.all([
        runBun({
          DD_PROFILING_ENABLED: 'true',
          DD_PROFILING_UPLOAD_PERIOD: '1',
          DD_PROFILING_TIMELINE_ENABLED: 'true',
          DD_TRACE_DEBUG: 'true',
          ...env,
        }),
        profileReceived,
      ])

      assert.match(result.stdout + result.stderr, /Heap profiling is disabled, because it is not supported on Bun\./)
    })
  }
})
