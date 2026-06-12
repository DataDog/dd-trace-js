'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const { describe, it, before, after, beforeEach, afterEach } = require('mocha')
const { assertTraceReceived } = require('./helpers')

describe('Electron instrumentation', function () {
  let httpServer
  let httpPort
  let child

  const electronBin = require('electron')
  const appDir = path.join(__dirname, 'app')

  before(done => {
    httpServer = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end()
    })
    httpServer.listen(0, '127.0.0.1', () => {
      httpPort = httpServer.address().port
      done()
    })
  })

  after(done => {
    httpServer.close(done)
  })

  beforeEach(function (done) {
    this.timeout(30_000)

    const args = [path.join(appDir, 'main')]
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu')

    child = spawn(electronBin, args, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    })

    child.on('error', done)
    child.on('message', msg => { if (msg === 'ready') done() })
  })

  afterEach(done => {
    const proc = child
    child = null
    proc.send({ name: 'quit' })
    proc.once('close', done)
  })

  it('should create an http.request span for net.fetch calls', done => {
    assertTraceReceived(child, ({ payload }) => {
      const spans = payload.flat()
      const span = spans.find(s => s.name === 'http.request')
      if (!span) throw new Error('No http.request span found')

      assert.strictEqual(span.type, 'http')
      assert.strictEqual(span.resource, 'GET')
      assert.strictEqual(span.service, 'electron-test')
      assert.strictEqual(span.error, 0)
      assert.strictEqual(span.meta.component, 'electron')
      assert.strictEqual(span.meta['span.kind'], 'client')
      assert.strictEqual(span.meta['http.method'], 'GET')
      assert.strictEqual(span.meta['http.status_code'], '200')
      assert.strictEqual(span.meta['http.url'], `http://127.0.0.1:${httpPort}/`)
    }).then(done, done)

    child.send({ name: 'http', url: `http://127.0.0.1:${httpPort}/` })
  })

  it('should create an electron.main.send span for IPC send from main to renderer', done => {
    assertTraceReceived(child, ({ payload }) => {
      const spans = payload.flat()
      const span = spans.find(s => s.name === 'electron.main.send')
      if (!span) throw new Error('No electron.main.send span found')

      assert.strictEqual(span.resource, 'ping')
      assert.strictEqual(span.service, 'electron-test')
      assert.strictEqual(span.error, 0)
      assert.strictEqual(span.meta.component, 'electron')
      assert.strictEqual(span.meta['span.kind'], 'producer')
    }).then(done, done)

    child.send({ name: 'ipc' })
  })

  it('should inject DatadogEventBridge in the renderer process', done => {
    function handler (msg) {
      if (!msg || msg.name !== 'bridge-result') return
      child.removeListener('message', handler)
      try {
        assert.strictEqual(msg.result.exists, true)
        assert.strictEqual(msg.result.capabilities, '[]')
        assert.ok(msg.result.privacyLevel)
        assert.ok(msg.result.sendSuccess)
        done()
      } catch (e) {
        done(e)
      }
    }

    child.on('message', handler)
    child.send({ name: 'bridge' })
  })
})
