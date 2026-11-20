'use strict'

const { spawn } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')
const { resolve } = require('node:path')

const root = resolve(process.argv[2] || resolve(__dirname, '..'))
const bun = resolve(__dirname, '../node_modules/.bin/bun')
const rounds = Number(process.env.ROUNDS || 5)
const count = Number(process.env.REQUESTS || 50000)
const concurrency = Number(process.env.CONCURRENCY || 20)
const modes = ['raw-static', 'traced-static', 'disabled-static', 'raw-fetch', 'traced-fetch', 'disabled-fetch']
const results = Object.fromEntries(modes.map(mode => [mode, []]))

const serverSource = `
  const mode = process.env.BENCH_MODE
  if (!mode.startsWith('raw')) {
    const tracer = require(process.env.BENCH_ROOT).init({ startupLogs: false, flushInterval: 100 })
    if (mode.startsWith('disabled')) tracer.use('http', false)
  }
  const options = { port: 0, hostname: '127.0.0.1', development: false }
  if (mode.endsWith('static')) options.routes = { '/': new Response('hi') }
  else options.fetch = () => new Response('hi')
  const server = Bun.serve(options)
  process.send({ port: server.port })
`

const clientSource = `
  const assert = require('node:assert/strict')
  const count = Number(process.env.BENCH_REQUESTS)
  async function workload(count) {
    let sent = 0
    const start = performance.now()
    await Promise.all(Array.from({ length: Number(process.env.BENCH_CONCURRENCY) }, async () => {
      while (sent++ < count) {
        const response = await fetch(process.env.BENCH_URL)
        assert.strictEqual(response.status, 200)
        assert.strictEqual(await response.text(), 'hi')
      }
    }))
    return Math.round(count * 1000 / (performance.now() - start))
  }
  await workload(5000)
  process.send({ rate: await workload(count) })
  process.disconnect()
`

/**
 * @param {string} mode
 * @param {number} agentPort
 */
async function measure (mode, agentPort) {
  const child = spawn(bun, ['-e', serverSource], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: {
      ...process.env,
      BENCH_ROOT: root,
      BENCH_MODE: mode,
      DD_TRACE_AGENT_URL: `http://127.0.0.1:${agentPort}`,
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    },
  })
  let client
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', (code, signal) => reject(new Error(`Bun exited: ${code || signal}`)))
  })
  try {
    const { port } = await ready
    client = spawn(bun, ['-e', clientSource], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: {
        ...process.env,
        BENCH_REQUESTS: String(count),
        BENCH_CONCURRENCY: String(concurrency),
        BENCH_URL: `http://127.0.0.1:${port}/`,
      },
    })
    const [{ rate }] = await once(client, 'message')
    return rate
  } finally {
    client?.kill()
    const closed = once(child, 'close')
    child.kill()
    await closed
  }
}

async function main () {
  const agent = http.createServer((request, response) => {
    request.resume()
    request.once('end', () => response.end('{}'))
  })
  agent.listen(0, '127.0.0.1')
  await once(agent, 'listening')
  const config = { root, driver: process.version, rounds, count, concurrency, warmup: 5000 }
  process.stdout.write(JSON.stringify(config) + '\n')
  try {
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 ? [...modes].reverse() : modes
      for (const mode of order) {
        const rate = await measure(mode, agent.address().port)
        results[mode].push(rate)
        process.stdout.write(JSON.stringify({ round: round + 1, mode, requestsPerSecond: rate }) + '\n')
      }
    }
    for (const mode of modes) {
      const samples = results[mode].sort((a, b) => a - b)
      process.stdout.write(JSON.stringify({ mode, samples, median: samples[Math.floor(samples.length / 2)] }) + '\n')
    }
  } finally {
    agent.closeAllConnections()
    agent.close()
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n')
  process.exitCode = 1
})
