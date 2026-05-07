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
  let binaryPath
  let child

  useSandbox(['electron', 'esbuild', '@electron/packager'], false, [path.join(__dirname, 'app')])

  before(async function () {
    this.timeout(120_000)

    const sandboxFolder = sandboxCwd()
    const appDir = path.join(sandboxFolder, 'app')

    // Install dd-trace from the pre-packed tarball into the app directory so that
    // electron-packager bundles it inside the binary alongside the bundled source.
    const ddTraceTgz = path.join(path.dirname(sandboxFolder), 'dd-trace.tgz')
    fs.writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: 'ElectronEsbuildTest',
        version: '1.0.0',
        main: 'bundle.js',
        dependencies: { 'dd-trace': `file:${ddTraceTgz}`, esbuild: '*' },
      })
    )
    execFileSync('npm', ['install'], { cwd: appDir, stdio: 'pipe' })

    // Bundle main.js with a minimal esbuild config — no datadog-esbuild plugin.
    // external:['electron'] is the standard minimum for any esbuild + Electron app.
    const buildScript = [
      "'use strict'",
      "const esbuild = require('esbuild')",
      '',
      'esbuild.build({',
      "  platform: 'node',",
      '  bundle: true,',
      `  entryPoints: [${JSON.stringify(path.join(appDir, 'main.js'))}],`,
      `  outfile: ${JSON.stringify(path.join(appDir, 'bundle.js'))},`,
      "  external: ['electron'],",
      '}).catch(err => {',
      "  process.stderr.write(String(err) + '\\n')",
      '  process.exit(1)',
      '})',
    ].join('\n')

    const buildScriptPath = path.join(sandboxFolder, 'esbuild.build.js')
    fs.writeFileSync(buildScriptPath, buildScript)
    execFileSync(process.execPath, [buildScriptPath], { cwd: sandboxFolder, stdio: 'pipe' })

    const electronVersion = require(
      path.join(sandboxFolder, 'node_modules', 'electron', 'package.json')
    ).version

    const outDir = path.join(sandboxFolder, 'dist')
    fs.mkdirSync(outDir, { recursive: true })

    execFileSync(
      path.join(sandboxFolder, 'node_modules', '.bin', 'electron-packager'),
      [
        appDir,
        'ElectronEsbuildTest',
        `--platform=${process.platform}`,
        `--arch=${process.arch}`,
        `--electron-version=${electronVersion}`,
        `--out=${outDir}`,
        '--overwrite',
      ],
      { cwd: sandboxFolder, stdio: 'pipe' }
    )

    const packageDir = path.join(outDir, `ElectronEsbuildTest-${process.platform}-${process.arch}`)
    if (process.platform === 'darwin') {
      binaryPath = path.join(packageDir, 'ElectronEsbuildTest.app', 'Contents', 'MacOS', 'ElectronEsbuildTest')
    } else if (process.platform === 'win32') {
      binaryPath = path.join(packageDir, 'ElectronEsbuildTest.exe')
    } else {
      binaryPath = path.join(packageDir, 'ElectronEsbuildTest')
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

  beforeEach(function (done) {
    this.timeout(15_000)

    child = spawn(binaryPath, process.platform === 'linux' ? ['--no-sandbox'] : [], {
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

  it('builds and packages successfully', () => {
    assert.ok(fs.existsSync(binaryPath))
  })

  it('initializes the tracer and produces an http.request span', done => {
    assertTraceReceived(child, ({ payload }) => {
      const span = payload.flat().find(s => s.name === 'http.request')
      if (!span) throw new Error('No http.request span found')
      assert.strictEqual(span.meta.component, 'electron')
    }).then(done, done)

    child.send({ name: 'http', url: `http://127.0.0.1:${httpPort}/` })
  })
})
