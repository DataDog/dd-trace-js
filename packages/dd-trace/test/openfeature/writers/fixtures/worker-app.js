'use strict'

const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { Worker, isMainThread } = require('node:worker_threads')

const mode = process.argv[2]
/** @typedef {import('../../../../src/config/config-base')} Config */
/** @typedef {import('../../../../src/openfeature/writers/flag-evaluations').FlagEvaluationRoute} Route */
if (mode === 'permissions') {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- The caller skips unsupported Node versions.
  assert.ok(process.permission)
  // Probe inside the real worker before loading its unchanged entrypoint with the writer's actual options.
  require('node:worker_threads').Worker = class extends Worker {
    constructor (filename, options) {
      super(`
        const assert = require('node:assert/strict')
        const { statSync } = require('node:fs')
        const { join } = require('node:path')
        const { tmpdir } = require('node:os')
        assert.ok(process.permission, 'worker must retain the permission model')
        assert.strictEqual(process.permission.has('fs.read', ${JSON.stringify(process.argv[3])}), true)
        assert.throws(() => statSync(join(tmpdir(), 'ffe-denied')), { code: 'ERR_ACCESS_DENIED' })
        assert.strictEqual(process.permission.has('fs.write'), false)
        assert.strictEqual(process.permission.has('child'), false)
        if (process.allowedNodeEnvironmentFlags.has('--allow-net')) {
          assert.strictEqual(process.permission.has('net'), true)
        }
        require(${JSON.stringify(filename)})
      `, { ...options, eval: true })
      this.once('error', error => { throw error })
    }
  }
}

if (mode === 'network-options') {
  require('node:worker_threads').Worker = class extends Worker {
    constructor (filename, options) {
      super(`
        const assert = require('node:assert/strict')
        const dns = require('node:dns')
        const net = require('node:net')
        assert.strictEqual(dns.getDefaultResultOrder(), 'ipv4first')
        if (process.allowedNodeEnvironmentFlags.has('--network-family-autoselection')) {
          assert.strictEqual(net.getDefaultAutoSelectFamily(), false)
        }
        if (process.allowedNodeEnvironmentFlags.has('--network-family-autoselection-attempt-timeout')) {
          assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 123)
        }
        require(${JSON.stringify(filename)})
      `, { ...options, eval: true })
      this.once('error', error => { throw error })
    }
  }
}

if (mode === 'tls-options') {
  const tls = require('node:tls')
  const expected = process.argv[3]
  assert.strictEqual(tls.DEFAULT_MIN_VERSION, expected)
  assert.strictEqual(tls.DEFAULT_MAX_VERSION, expected)
  require('node:worker_threads').Worker = class extends Worker {
    constructor (filename, options) {
      super(`
        const assert = require('node:assert/strict')
        const tls = require('node:tls')
        assert.strictEqual(tls.DEFAULT_MIN_VERSION, ${JSON.stringify(expected)})
        assert.strictEqual(tls.DEFAULT_MAX_VERSION, ${JSON.stringify(expected)})
        require(${JSON.stringify(filename)})
      `, { ...options, eval: true })
      this.once('error', error => { throw error })
    }
  }
}

if (mode === 'nested' && isMainThread) {
  const worker = new Worker(__filename, { argv: ['nested-child'] })
  worker.once('error', error => { throw error })
} else {
  globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }
  process.once('beforeExit', () => {
    for (const handler of globalThis[Symbol.for('dd-trace')].beforeExitHandlers) handler()
  })
  const Writer = require('../../../../src/openfeature/writers/flag-evaluations')
  const telemetry = require('../../../../src/telemetry/metrics')
  let accepted = 0
  let delivered = 0
  const bodies = []
  let fallbackRequests = 0
  let fallbackTransitions = 0
  let writer
  process.on('exit', () => {
    process.stdout.write(JSON.stringify({
      accepted,
      delivered,
      bodies,
      fallbackRequests,
      fallbackTransitions,
      metrics: telemetry.manager.namespace('general').toJSON().metrics?.series,
    }, (key, value) => {
      // Keep exit-time stdout small while inspecting the actual maximum-context wire values.
      if (mode === 'max-context' && key === 'raw') return undefined
      if (mode === 'max-context' && key === 'evaluation') {
        return Object.entries(value).map(([key, value]) => [key.length, value.length])
      }
      return value
    }))
  })
  if (mode === 'idle' || mode === 'startup-failure') {
    writer = new Writer(/** @type {Config} */ ({ url: new URL('http://127.0.0.1:9'), service: 'worker-test' }))
    const invalidRoute = /** @type {Route} */ ({ url: { href: 'invalid' }, basePath: '' })
    writer.setEnabled(true, mode === 'startup-failure' ? invalidRoute : undefined)
    if (mode === 'startup-failure') {
      if (writer.enqueue({ flagKey: 'pending', timestamp: 100, runtimeDefault: false })) accepted++
    }
  } else {
    let warmed = false
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/local')) {
        fallbackRequests++
        req.resume()
        res.writeHead(405).end()
        return
      }
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        if (warmed && mode === 'timeout') {
          // Keep the socket active without completing the response. An idle socket can hit its own timeout
          // before the worker's shutdown deadline now that requests are intentionally not retried.
          res.writeHead(202)
          res.write(' ')
          const heartbeat = setInterval(() => res.write(' '), 100)
          res.once('close', () => clearInterval(heartbeat))
          server.close()
          return
        }
        const body = JSON.parse(raw)
        delivered += body.flagEvaluations.reduce((sum, row) => sum + row.evaluation_count, 0)
        bodies.push({ raw, body, headers: req.headers, url: req.url })
        res.writeHead(202).end()
        if (!warmed) {
          warmed = true
          setImmediate(() => {
            if (mode === 'runtime-failure') {
              for (let i = 0; i < 8; i++) {
                if (writer.enqueue({ flagKey: 'pending', timestamp: 100, runtimeDefault: false })) accepted++
              }
              writer.setEnabled(true, /** @type {Route} */ ({ url: { href: 'invalid' }, basePath: '' }))
              server.close()
              return
            }
            // Admit the serialization-error probe before the load can fill the queue.
            assert.strictEqual(writer.enqueue({ flagKey: 'invalid', timestamp: NaN, runtimeDefault: false }), true)
            const deadline = Date.now() + 3000
            const targetCount = mode === 'progress' ? 12000 : mode === 'timeout' ? 8 : 16
            const attrs = mode === 'max-context'
              ? Object.freeze(Object.fromEntries(Array.from({ length: 256 }, (_, i) =>
                [String(i).padEnd(256, 'k'), 'v'.repeat(256)])))
              : Object.freeze({ plan: 'context-canary' })
            // Never yield during this loop. Producer credit must come from the worker itself.
            while (accepted < targetCount && Date.now() < deadline) {
              if (writer.enqueue({
                flagKey: accepted % 2 ? 'full' : 'protected',
                targetingKey: accepted % 2 ? 'full-target-canary' : 'protected-target-canary',
                attrs,
                errorCode: 'error-canary',
                observeFullEvaluationData: accepted % 2 === 1,
                timestamp: accepted + 100,
                runtimeDefault: true,
              })) accepted++
            }
            writer.destroy()
          })
        } else {
          server.close()
        }
      })
    })
    const listen = mode === 'unix' ? '/tmp/ffe-worker-' + process.pid + '.sock' : 0
    server.listen(listen, () => {
      const url = mode === 'unix'
        ? new URL('unix://' + listen)
        : new URL('http://127.0.0.1:' + /** @type {import('node:net').AddressInfo} */ (server.address()).port)
      writer = new Writer(/** @type {Config} */ ({ url, service: 'worker-test', env: 'test' }))
      const directRoute = { url, basePath: '', headers: { 'DD-API-KEY': 'test-key' } }
      writer.setEnabled(true, mode === 'fallback'
        ? {
            url,
            basePath: '/local',
            fallback: directRoute,
            onFallback: () => {
              fallbackTransitions++
              writer.setEnabled(true, directRoute)
            },
          }
        : { url, basePath: '' })
      writer.enqueue({ flagKey: 'warmup', timestamp: 100, runtimeDefault: false })
      writer.flush()
    })
  }
}
