'use strict'

const assert = require('assert')
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const { useSandbox, sandboxCwd } = require('../helpers')
const { assertTraceReceived } = require('./helpers')

describe('Electron integration', function () {
  let httpServer
  let httpPort
  let electronBin
  let appDir
  let child

  // Create a sandbox with electron installed alongside dd-trace.
  // The app source files are copied in; dd-trace is installed into the app directory
  // from the pre-packed sandbox tgz so it is available at runtime.
  useSandbox(['electron'], false, [path.join(__dirname, 'app')])

  before(async function () {
    this.timeout(30_000)

    const sandboxFolder = sandboxCwd()
    appDir = path.join(sandboxFolder, 'app')

    // createSandbox packs dd-trace into a .tgz one level above the sandbox folder.
    // We reference it with a file: URL so npm installs the exact local build.
    const ddTraceTgz = path.join(path.dirname(sandboxFolder), 'dd-trace.tgz')

    fs.writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: 'ElectronTest',
        version: '1.0.0',
        main: 'main.js',
        dependencies: { 'dd-trace': `file:${ddTraceTgz}` },
      })
    )

    // Install dd-trace and its transitive dependencies into the app directory.
    execFileSync('npm', ['install'], { cwd: appDir, stdio: 'pipe' })

    // Use the electron binary already installed in the sandbox. Reading path.txt
    // (written by electron's postinstall) avoids any per-platform path logic here.
    const electronRelPath = fs.readFileSync(
      path.join(sandboxFolder, 'node_modules', 'electron', 'path.txt'),
      'utf-8'
    ).trim()
    electronBin = path.join(sandboxFolder, 'node_modules', 'electron', 'dist', electronRelPath)

    await new Promise(resolve => {
      httpServer = http.createServer((_req, res) => {
        res.writeHead(200)
        res.end()
      })
      httpServer.listen(0, '127.0.0.1', () => {
        httpPort = httpServer.address().port
        resolve()
      })
    })
  })

  after(async function () {
    if (httpServer) await new Promise(resolve => httpServer.close(resolve))
  })

  beforeEach(function (done) {
    this.timeout(30_000)

    const args = [appDir, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
    child = spawn(electronBin, args, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    })
    child.on('error', done)
    // 'ready' is sent by main.js only after the renderer window has finished
    // loading, so IPC commands can be issued as soon as this fires.
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
      assert.strictEqual(span.service, 'electron-integration-test')
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
      assert.strictEqual(span.service, 'electron-integration-test')
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
        assert.strictEqual(msg.result.exists, true, 'DatadogEventBridge should exist on window')
        assert.strictEqual(msg.result.capabilities, '[]')
        assert.ok(msg.result.privacyLevel, 'privacyLevel should be set')
        assert.ok(msg.result.sendSuccess, 'bridge.send() should not throw')
        done()
      } catch (e) {
        done(e)
      }
    }

    child.on('message', handler)
    child.send({ name: 'bridge' })
  })

  it('should produce spans for both HTTP and IPC when both operations are triggered', done => {
    // Register both assertions before triggering anything so no message is missed.
    const httpSpanSeen = assertTraceReceived(child, ({ payload }) => {
      const spans = payload.flat()
      const span = spans.find(s => s.name === 'http.request')
      if (!span) throw new Error('No http.request span found')

      assert.strictEqual(span.type, 'http')
      assert.strictEqual(span.meta.component, 'electron')
      assert.strictEqual(span.meta['http.status_code'], '200')
      assert.strictEqual(span.meta['http.url'], `http://127.0.0.1:${httpPort}/`)
    })

    const ipcSpanSeen = assertTraceReceived(child, ({ payload }) => {
      const spans = payload.flat()
      const span = spans.find(s => s.name === 'electron.main.send')
      if (!span) throw new Error('No electron.main.send span found')

      assert.strictEqual(span.meta.component, 'electron')
      assert.strictEqual(span.meta['span.kind'], 'producer')
    })

    Promise.all([httpSpanSeen, ipcSpanSeen]).then(() => done(), done)

    child.send({ name: 'http', url: `http://127.0.0.1:${httpPort}/` })
    child.send({ name: 'ipc' })
  })
})
