'use strict'

const assert = require('assert')
const proc = require('child_process')
const http = require('http')
const { afterEach, beforeEach, describe, it } = require('mocha')
const { join } = require('path')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

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

      child = proc.spawn(electron, [join(__dirname, 'app', 'main')], {
        env: {
          ...process.env,
          NODE_OPTIONS: `-r ${join(__dirname, 'tracer')}`,
          DD_TRACE_AGENT_PORT: agent.port
        },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        windowsHide: true
      })

      child.on('error', done)
      child.on('message', msg => msg === 'ready' && done())
    }

    describe('electron', () => {
      describe('without configuration', () => {
        beforeEach(() => agent.load('electron'))
        beforeEach(done => startApp(done))

        afterEach(() => agent.close({ ritmReset: false }))
        afterEach(done => {
          child.send({ name: 'quit' })
          child.on('close', () => done())
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
              const span = traces[0][0]
              const { meta } = span

              assert.strictEqual(span.type, 'worker')
              assert.strictEqual(span.name, 'electron.main.receive')
              assert.strictEqual(span.resource, 'set-title')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'consumer')
            })
            .then(done)
            .catch(done)

          child.send({ name: 'render' })
        })

        it('should do automatic instrumentation for main IPC when sending', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              const { meta } = span

              assert.strictEqual(span.name, 'electron.main.send')
              assert.strictEqual(span.resource, 'update-counter')
              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.error, 0)

              assert.strictEqual(meta.component, 'electron')
              assert.strictEqual(meta['span.kind'], 'producer')
            })
            .then(done)
            .catch(done)

          child.send({ name: 'render' })
        })
      })
    })
  })
})
