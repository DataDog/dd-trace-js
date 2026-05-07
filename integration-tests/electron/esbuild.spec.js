'use strict'

const assert = require('assert')
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const { useSandbox, sandboxCwd } = require('../helpers')
const { assertTraceReceived } = require('./helpers')

describe('Electron + esbuild integration', function () {
  let httpServer
  let httpPort
  let distDir
  let child
  let buildError = null

  useSandbox(['electron', 'esbuild'], false, [path.join(__dirname, 'app')])

  before(async function () {
    this.timeout(120_000)

    const sandboxFolder = sandboxCwd()
    const appDir = path.join(sandboxFolder, 'app')
    distDir = path.join(sandboxFolder, 'dist')
    fs.mkdirSync(distDir, { recursive: true })

    // Minimal esbuild config — no datadog-esbuild plugin.
    // external:['electron','electron/*'] is the standard minimum for any
    // esbuild + Electron app (Electron provides these at runtime).
    const buildScript = [
      "'use strict'",
      "const esbuild = require('esbuild')",
      '',
      'esbuild.build({',
      "  platform: 'node',",
      '  bundle: true,',
      `  entryPoints: [${JSON.stringify(path.join(appDir, 'main.js'))}],`,
      `  outfile: ${JSON.stringify(path.join(distDir, 'bundle.js'))},`,
      "  external: ['electron', 'electron/*'],",
      '}).catch(err => {',
      "  process.stderr.write(String(err) + '\\n')",
      '  process.exit(1)',
      '})',
    ].join('\n')

    const buildScriptPath = path.join(sandboxFolder, 'esbuild.build.js')
    fs.writeFileSync(buildScriptPath, buildScript)

    try {
      execFileSync(process.execPath, [buildScriptPath], { cwd: sandboxFolder, stdio: 'pipe' })
    } catch (err) {
      buildError = err
    }

    if (!buildError) {
      fs.copyFileSync(path.join(appDir, 'preload.js'), path.join(distDir, 'preload.js'))
      fs.copyFileSync(path.join(appDir, 'index.html'), path.join(distDir, 'index.html'))
      fs.writeFileSync(
        path.join(distDir, 'package.json'),
        JSON.stringify({ name: 'electron-esbuild-test', main: 'bundle.js' })
      )
    }

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

  afterEach(done => {
    if (!child) return done()
    const proc = child
    child = null
    if (proc.exitCode !== null || proc.signalCode !== null) return done()
    try { proc.send({ name: 'quit' }) } catch {}
    proc.once('close', done)
  })

  it('builds successfully', () => {
    if (buildError) throw buildError
    assert.ok(fs.existsSync(path.join(distDir, 'bundle.js')))
  })

  it('initializes the tracer and produces an http.request span', function (done) {
    this.timeout(15_000)
    if (buildError) return this.skip()

    const electronBin = path.join(sandboxCwd(), 'node_modules', '.bin', 'electron')
    const args = process.platform === 'linux' ? [distDir, '--no-sandbox'] : [distDir]
    child = spawn(electronBin, args, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    })
    child.on('error', done)
    child.once('exit', code => done(new Error(`Electron exited with code ${code} before sending ready`)))
    child.on('message', msg => {
      if (msg !== 'ready') return
      child.removeAllListeners('exit')

      assertTraceReceived(child, ({ payload }) => {
        const span = payload.flat().find(s => s.name === 'http.request')
        if (!span) throw new Error('No http.request span found')
        assert.strictEqual(span.meta.component, 'electron')
      }).then(done, done)

      child.send({ name: 'http', url: `http://127.0.0.1:${httpPort}/` })
    })
  })
})
