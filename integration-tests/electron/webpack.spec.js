'use strict'

const assert = require('assert')
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const { useSandbox, sandboxCwd } = require('../helpers')
const { assertTraceReceived } = require('./helpers')

describe('Electron + webpack integration', function () {
  let httpServer
  let httpPort
  let binaryPath
  let child

  useSandbox(['electron', 'webpack', '@electron/packager'], false, [path.join(__dirname, 'app')])

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
        name: 'ElectronWebpackTest',
        version: '1.0.0',
        main: 'bundle.js',
        dependencies: { 'dd-trace': `file:${ddTraceTgz}`, webpack: '*' },
      })
    )
    execFileSync('npm', ['install'], { cwd: appDir, stdio: 'pipe' })

    // Bundle main.js — no DatadogWebpackPlugin. target:'electron-main' externalises
    // the legacy electron API names and Node built-ins automatically, but electron/main
    // and electron/renderer must be listed explicitly because webpack's ElectronTargetPlugin
    // only covers the old-style names (electron, app, ipc, …) not modern sub-path imports.
    const buildScript = [
      "'use strict'",
      "const path = require('path')",
      "const webpack = require('webpack')",
      '',
      'webpack({',
      "  mode: 'development',",
      "  target: 'electron-main',",
      `  entry: ${JSON.stringify(path.join(appDir, 'main.js'))},`,
      '  output: {',
      "    filename: 'bundle.js',",
      `    path: ${JSON.stringify(appDir)},`,
      '  },',
      '  externals: {',
      "    'electron/main': 'commonjs2 electron/main',",
      "    'electron/renderer': 'commonjs2 electron/renderer',",
      "    'electron/common': 'commonjs2 electron/common',",
      '  },',
      '}, (err, stats) => {',
      '  if (err) {',
      "    process.stderr.write(err.message + '\\n')",
      '    process.exit(1)',
      '  }',
      '  if (stats.hasErrors()) {',
      "    process.stderr.write(stats.toString({ errors: true }) + '\\n')",
      '    process.exit(1)',
      '  }',
      '})',
    ].join('\n')

    const buildScriptPath = path.join(sandboxFolder, 'webpack.build.js')
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
        'ElectronWebpackTest',
        `--platform=${process.platform}`,
        `--arch=${process.arch}`,
        `--electron-version=${electronVersion}`,
        `--out=${outDir}`,
        '--overwrite',
      ],
      { cwd: sandboxFolder, stdio: 'pipe' }
    )

    const packageDir = path.join(outDir, `ElectronWebpackTest-${process.platform}-${process.arch}`)
    if (process.platform === 'darwin') {
      binaryPath = path.join(packageDir, 'ElectronWebpackTest.app', 'Contents', 'MacOS', 'ElectronWebpackTest')
    } else if (process.platform === 'win32') {
      binaryPath = path.join(packageDir, 'ElectronWebpackTest.exe')
    } else {
      binaryPath = path.join(packageDir, 'ElectronWebpackTest')
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
