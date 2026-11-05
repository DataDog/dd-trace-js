'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')
const path = require('node:path')

const { describe, it } = require('mocha')

describe('runtime metrics transport', () => {
  for (const runtimeOtelEnabled of [undefined, 'false']) {
    it(`exports OTel API metrics with runtime OTLP=${runtimeOtelEnabled ?? 'default'}`, async function () {
      this.timeout(15_000)
      const packets = []
      const exportedMetrics = []
      const server = http.createServer((request, response) => {
        let body = ''
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
          if (request.url === '/v1/metrics') {
            for (const resource of JSON.parse(body).resourceMetrics) {
              for (const scope of resource.scopeMetrics) exportedMetrics.push(...scope.metrics)
            }
          }
          if (request.url === '/dogstatsd/v2/proxy') packets.push(body)
          response.end('{}')
          checkDelivery()
        })
      })
      let child
      let exited
      let stderr = ''
      let finish
      const delivered = new Promise(resolve => { finish = resolve })

      function checkDelivery () {
        const apiMetric = exportedMetrics.find(metric => metric.name === 'application.requests')
        const runtimeMetric = runtimeOtelEnabled === 'false'
          ? packets.some(packet => packet.includes('runtime.node.mem.heap_used:'))
          : exportedMetrics.some(metric => metric.name === 'v8js.memory.heap.used')
        if (apiMetric && runtimeMetric) finish()
      }

      try {
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const env = Object.fromEntries(Object.entries(process.env)
          .filter(([key]) => !key.startsWith('DD_') && !key.startsWith('OTEL_')))
        Object.assign(env, {
          DD_METRICS_OTEL_ENABLED: 'true',
          DD_RUNTIME_METRICS_FLUSH_INTERVAL: '100',
          DD_TRACE_AGENT_URL: `http://127.0.0.1:${server.address().port}`,
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
          DD_REMOTE_CONFIGURATION_ENABLED: 'false',
          DD_TRACE_STARTUP_LOGS: 'false',
          OTEL_METRIC_EXPORT_INTERVAL: '100',
          OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/metrics`,
        })
        if (runtimeOtelEnabled !== undefined) env.DD_RUNTIME_METRICS_OTEL_ENABLED = runtimeOtelEnabled
        child = fork(path.join(__dirname, 'fixtures/runtime-metrics-transport.js'), [], {
          env,
          silent: true,
          timeout: 10_000,
        })
        child.stderr.on('data', chunk => { stderr += chunk })
        exited = once(child, 'exit')
        await Promise.race([
          delivered,
          exited.then(([code]) => { throw new Error(`Child exited before delivery (${code}): ${stderr}`) }),
        ])
        child.send('shutdown')
        const [code] = await exited
        assert.strictEqual(code, 0, stderr)
        const apiMetric = exportedMetrics.find(metric => metric.name === 'application.requests')
        assert.strictEqual(apiMetric.sum.dataPoints[0].asInt, 7)
        if (runtimeOtelEnabled === 'false') {
          assert.ok(!exportedMetrics.some(metric => metric.name.startsWith('v8js.')))
        } else {
          assert.ok(!packets.some(packet => packet.includes('runtime.node.mem.heap_used:')))
        }
      } finally {
        child?.kill()
        if (exited) await exited
        const closed = once(server, 'close')
        server.closeAllConnections()
        server.close()
        await closed
      }
    })
  }
})
