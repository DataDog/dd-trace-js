'use strict'

const assert = require('assert')
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const { FakeAgent, useSandbox, sandboxCwd } = require('../helpers')

describe('Electron integration', function () {
  this.timeout(300_000)

  let agent
  let httpServer
  let httpPort
  let binaryPath
  let child

  // Create a sandbox with electron and @electron/packager installed alongside dd-trace.
  // The app source files are copied in; dd-trace is then installed into the app directory
  // from the pre-packed sandbox tgz so electron-packager bundles it inside the binary.
  useSandbox(['electron', '@electron/packager'], false, [path.join(__dirname, 'app')])

  before(async function () {
    const sandboxFolder = sandboxCwd()
    const appDir = path.join(sandboxFolder, 'app')

    // createSandbox packs dd-trace into a .tgz one level above the sandbox folder.
    // We reference it with a file: URL so npm installs the exact local build.
    const ddTraceTgz = path.join(path.dirname(sandboxFolder), 'dd-trace.tgz')

    // Write the app's package.json with dd-trace as a bundled dependency so that
    // electron-packager includes it inside the binary together with the app source.
    fs.writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: 'ElectronTest',
        version: '1.0.0',
        main: 'main.js',
        dependencies: { 'dd-trace': `file:${ddTraceTgz}` }
      })
    )

    // Install dd-trace and its transitive dependencies into the app directory.
    execFileSync('npm', ['install'], { cwd: appDir, stdio: 'pipe' })

    // Use the electron version already installed in the sandbox so that
    // electron-packager finds the cached binary and does not re-download it.
    const electronVersion = require(
      path.join(sandboxFolder, 'node_modules', 'electron', 'package.json')
    ).version

    // Build a real standalone Electron binary. Running a compiled binary rather
    // than `electron <dir>` is a more faithful test of production behaviour.
    const outDir = path.join(sandboxFolder, 'dist')
    fs.mkdirSync(outDir, { recursive: true })

    execFileSync(
      path.join(sandboxFolder, 'node_modules', '.bin', 'electron-packager'),
      [
        appDir,
        'ElectronTest',
        `--platform=${process.platform}`,
        `--arch=${process.arch}`,
        `--electron-version=${electronVersion}`,
        `--out=${outDir}`,
        '--overwrite'
      ],
      { cwd: sandboxFolder, stdio: 'pipe' }
    )

    // The layout produced by electron-packager differs per platform:
    //   macOS  → <out>/ElectronTest-darwin-<arch>/ElectronTest.app/Contents/MacOS/ElectronTest
    //   Linux  → <out>/ElectronTest-linux-<arch>/ElectronTest
    //   Windows→ <out>/ElectronTest-win32-<arch>/ElectronTest.exe
    const packageDir = path.join(outDir, `ElectronTest-${process.platform}-${process.arch}`)
    if (process.platform === 'darwin') {
      binaryPath = path.join(packageDir, 'ElectronTest.app', 'Contents', 'MacOS', 'ElectronTest')
    } else if (process.platform === 'win32') {
      binaryPath = path.join(packageDir, 'ElectronTest.exe')
    } else {
      binaryPath = path.join(packageDir, 'ElectronTest')
    }

    agent = await new FakeAgent().start()

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
    if (agent) await agent.stop()
    if (httpServer) await new Promise(resolve => httpServer.close(resolve))
  })

  beforeEach(done => {
    child = spawn(binaryPath, [], {
      env: {
        ...process.env,
        // dd-trace is bundled inside the binary; only the agent port is injected.
        DD_TRACE_AGENT_PORT: String(agent.port)
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true
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
    agent
      .assertMessageReceived(({ payload }) => {
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
      })
      .then(done, done)

    child.send({ name: 'http', url: `http://127.0.0.1:${httpPort}/` })
  })

  it('should create an electron.main.send span for IPC send from main to renderer', done => {
    agent
      .assertMessageReceived(({ payload }) => {
        const spans = payload.flat()
        const span = spans.find(s => s.name === 'electron.main.send')
        if (!span) throw new Error('No electron.main.send span found')

        assert.strictEqual(span.resource, 'ping')
        assert.strictEqual(span.service, 'electron-integration-test')
        assert.strictEqual(span.error, 0)
        assert.strictEqual(span.meta.component, 'electron')
        assert.strictEqual(span.meta['span.kind'], 'producer')
      })
      .then(done, done)

    child.send({ name: 'ipc' })
  })

  it('should produce spans for both HTTP and IPC when both operations are triggered', done => {
    // Register both assertions before triggering anything so no message is missed.
    const httpSpanSeen = agent.assertMessageReceived(({ payload }) => {
      const spans = payload.flat()
      const span = spans.find(s => s.name === 'http.request')
      if (!span) throw new Error('No http.request span found')

      assert.strictEqual(span.type, 'http')
      assert.strictEqual(span.meta.component, 'electron')
      assert.strictEqual(span.meta['http.status_code'], '200')
      assert.strictEqual(span.meta['http.url'], `http://127.0.0.1:${httpPort}/`)
    })

    const ipcSpanSeen = agent.assertMessageReceived(({ payload }) => {
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
