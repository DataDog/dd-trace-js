'use strict'

const assert = require('assert')
const proc = require('child_process')
const http = require('http')
const { join } = require('path')
const { afterEach, beforeEach, describe, it } = require('mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const IPC_TIMEOUT_MS = 10_000

describe('Plugin', () => {
  let child
  let listener
  let port

  before(done => {
    const server = http.createServer((req, res) => {
      res.writeHead(200)
      res.end()
    })

    listener = server.listen(0, '127.0.0.1', () => {
      port = listener.address().port
      done()
    })
  })

  after(done => {
    listener.close(done)
  })

  withVersions('electron', ['electron'], version => {
    const startApp = done => {
      const electron = require(`../../../versions/electron@${version}`).get()

      const args = [join(__dirname, 'app', 'main')]
      if (process.platform === 'linux') {
        args.push('--no-sandbox', '--disable-gpu')
      }
      child = proc.spawn(electron, args, {
        env: {
          ...process.env,
          NODE_OPTIONS: `-r ${join(__dirname, 'tracer')}`,
          DD_TRACE_AGENT_PORT: agent.port,
        },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
      })

      child.on('error', done)
      child.on('message', msg => msg === 'ready' && done())
    }

    describe('electron', () => {
      describe('without configuration', function () {
        this.timeout(IPC_TIMEOUT_MS + 5_000)
        beforeEach(() => agent.load('electron'))
        beforeEach(function (done) {
          this.timeout(30_000)
          startApp(done)
        })

        afterEach(() => agent.close({ ritmReset: false }))
        afterEach(done => {
          const proc = child
          child = undefined
          // The child may have already exited (e.g. an app crash mid-test). Sending on a closed IPC channel emits
          // an unhandled ERR_IPC_CHANNEL_CLOSED 'error' that masks the real failure and aborts the rest of the
          // suite, so only quit a still-connected child and let the send callback absorb a channel that races closed.
          if (!proc?.connected) return done()
          proc.once('close', () => done())
          proc.send({ name: 'quit' }, () => {})
        })

        it('should do automatic instrumentation for fetch', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              const { meta } = span

              assert.strictEqual(span.type, 'http')
              assert.strictEqual(span.name, 'http.request')
              assert.strictEqual(span.resource, 'GET')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'client')
              assert.strictEqual(meta['http.url'], `http://127.0.0.1:${port}/`)
              assert.strictEqual(meta['http.method'], 'GET')
              assert.strictEqual(meta['http.status_code'], '200')
            })
            .then(done)
            .catch(done)

          child.send({ name: 'fetch', url: `http://127.0.0.1:${port}` })
        })

        it('should do automatic instrumentation for request', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              const { meta } = span

              assert.strictEqual(span.type, 'http')
              assert.strictEqual(span.name, 'http.request')
              assert.strictEqual(span.resource, 'GET')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'client')
              assert.strictEqual(meta['http.url'], `http://127.0.0.1:${port}/`)
              assert.strictEqual(meta['http.method'], 'GET')
              assert.strictEqual(meta['http.status_code'], '200')
            })
            .then(done)
            .catch(done)

          child.send({ name: 'request', options: `http://127.0.0.1:${port}/` })
        })

        it('should do automatic instrumentation for main IPC when receiving', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces.flat().find(s => s.name === 'electron.main.receive')
              assert.ok(span, 'expected electron.main.receive span')
              const { meta } = span

              assert.strictEqual(span.type, 'worker')
              assert.strictEqual(span.name, 'electron.main.receive')
              assert.strictEqual(span.resource, 'set-title')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)
              assert.strictEqual(span.parent_id, span.trace_id)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'consumer')
            }, { timeoutMs: IPC_TIMEOUT_MS })
            .then(done)
            .catch(done)

          child.send({ name: 'receive' })
        })

        it('should do automatic instrumentation for main IPC when handling', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces.flat().find(s => s.name === 'electron.main.handle')
              assert.ok(span, 'expected electron.main.handle span')
              const { meta } = span

              assert.strictEqual(span.type, 'worker')
              assert.strictEqual(span.name, 'electron.main.handle')
              assert.strictEqual(span.resource, 'get-data')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'consumer')
            }, { timeoutMs: IPC_TIMEOUT_MS })
            .then(done)
            .catch(done)

          child.send({ name: 'handle' })
        })

        it('should do automatic instrumentation for main IPC when sending', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces.flat().find(s => s.name === 'electron.main.send')
              assert.ok(span, 'expected electron.main.send span')
              const { meta } = span

              assert.strictEqual(span.name, 'electron.main.send')
              assert.strictEqual(span.resource, 'update-counter')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'producer')
            }, { timeoutMs: IPC_TIMEOUT_MS })
            .then(done)
            .catch(done)

          child.send({ name: 'send' })
        })

        it('should do automatic instrumentation for renderer IPC when receiving', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces.flat().find(s => s.name === 'electron.renderer.receive')
              assert.ok(span, 'expected electron.renderer.receive span')
              const { meta } = span

              assert.strictEqual(span.type, 'worker')
              assert.strictEqual(span.name, 'electron.renderer.receive')
              assert.strictEqual(span.resource, 'update-counter')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)
              assert.strictEqual(span.parent_id, span.trace_id)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'consumer')
            }, { timeoutMs: IPC_TIMEOUT_MS })
            .then(done)
            .catch(done)

          child.send({ name: 'send' })
        })

        it('should do automatic instrumentation for net.request from a utility process', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              const { meta } = span

              assert.strictEqual(span.type, 'http')
              assert.strictEqual(span.name, 'http.request')
              assert.strictEqual(span.resource, 'GET')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'client')
              assert.strictEqual(meta['http.url'], `http://127.0.0.1:${port}/utility`)
              assert.strictEqual(meta['http.method'], 'GET')
              assert.strictEqual(meta['http.status_code'], '200')
            })
            .then(done)
            .catch(done)

          child.send({ name: 'utility-request', url: `http://127.0.0.1:${port}/utility` })
        })

        it('should do automatic instrumentation for renderer IPC when sending', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces.flat().find(s => s.name === 'electron.renderer.send')
              assert.ok(span, 'expected electron.renderer.send span')
              const { meta } = span

              assert.strictEqual(span.name, 'electron.renderer.send')
              assert.strictEqual(span.resource, 'set-title')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'producer')
            }, { timeoutMs: IPC_TIMEOUT_MS })
            .then(done)
            .catch(done)

          child.send({ name: 'receive' })
        })
      })
    })
  })
})
