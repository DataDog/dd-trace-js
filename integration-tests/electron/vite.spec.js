'use strict'

const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const {
  '@hono/node-server': HONO_NODE_SERVER_VERSION,
  ai: AI_VERSION,
  hono: HONO_VERSION,
  zod: ZOD_VERSION,
} = require('../../packages/dd-trace/test/plugins/versions/package.json').dependencies
const { sandboxCwd, useSandbox } = require('../helpers')
const { readPackageJson, run, supportsNode, viteVersions } = require('../vite/helpers')
const { assertTraceReceived } = require('./helpers')

const SERVICE = 'electron-integration-test'

const variants = [
  // electron-vite externalizes the application's `dependencies`, so the tracer is loaded from node_modules, which
  // the packaged application includes.
  { tool: 'electron-vite', tracer: 'external', main: 'out/main/index.js' },
  // devDependencies are bundled into the main process and left out of the packaged application.
  { tool: 'electron-vite', tracer: 'bundled', main: 'out/main/index.js' },
  // Electron Forge bundles every dependency into a minified main process.
  { tool: 'forge', tracer: 'bundled', main: '.vite/build/main.cjs' },
]

for (const viteVersion of viteVersions) {
  describe(`Electron integration with the datadog-vite plugin and Vite ${viteVersion}`, function () {
    // The Electron script runs without a global mocha timeout.
    this.timeout(60_000)

    useSandbox([
      `vite@${viteVersion}`,
      '@electron/packager',
      'electron',
      'electron-vite',
    ], false, [path.join(__dirname, 'app'), path.join(__dirname, 'vite-app')])

    let appDirectory
    let httpPort
    let httpServer

    before(async function () {
      this.timeout(120_000)
      if (!supportsNode(['vite', 'electron-vite'])) {
        // Release lines testing older Node.js versions run this suite too, but these Vite versions do not support them.
        this.skip()
      }

      const sandboxFolder = sandboxCwd()
      appDirectory = path.join(sandboxFolder, 'vite-app')
      for (const file of ['index.html', 'preload.js']) {
        fs.copyFileSync(path.join(sandboxFolder, 'app', file), path.join(appDirectory, file))
      }
      writePackageJson(appDirectory, 'dependencies', variants[0].main)
      // Installs the tracer from the tarball packed for the sandbox, with the Orchestrion target.
      execFileSync('npm', ['install'], { cwd: appDirectory, killSignal: 'SIGKILL', stdio: 'pipe', timeout: 110_000 })

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

    after(async () => {
      if (httpServer) await new Promise(resolve => httpServer.close(resolve))
    })

    for (const variant of variants) {
      describe(`${variant.tool} with dd-trace ${variant.tracer}`, () => {
        let binaryPath
        let child
        let packagedAppArchive

        before(function () {
          this.timeout(330_000)
          const name = `${variant.tool}-${variant.tracer}`
          const field = variant.tracer === 'bundled' ? 'devDependencies' : 'dependencies'
          writePackageJson(appDirectory, field, variant.main)
          fs.rmSync(path.join(appDirectory, 'out'), { force: true, recursive: true })
          fs.rmSync(path.join(appDirectory, '.vite'), { force: true, recursive: true })
          if (variant.tool === 'forge') {
            run(appDirectory, 'vite', ['build', '--config', 'vite.forge.config.mjs'])
          } else {
            run(appDirectory, 'electron-vite', ['build'])
          }
          ({ binaryPath, packagedAppArchive } = packageApp(sandboxCwd(), appDirectory, name))
        })

        beforeEach(function (done) {
          this.timeout(30_000)

          child = spawn(binaryPath, process.platform === 'linux' ? ['--no-sandbox'] : [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            windowsHide: true,
          })
          // A failed spawn emits `error` without `exit`; an application that crashes on startup emits `exit`.
          const onExit = (code, signal) => done(new Error(`Electron exited before it was ready: ${code ?? signal}`))
          child.once('error', done)
          child.once('exit', onExit)
          child.on('message', function onMessage (msg) {
            if (msg !== 'ready') return
            child.removeListener('error', done)
            child.removeListener('exit', onExit)
            child.removeListener('message', onMessage)
            done()
          })
        })

        afterEach(done => {
          const proc = child
          child = null
          if (!proc?.connected) {
            proc?.kill('SIGKILL')
            return done()
          }
          const killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000)
          proc.once('close', () => {
            clearTimeout(killTimer)
            setImmediate(done)
          })
          proc.send({ name: 'quit' }, () => {})
        })

        it('packages the tracer and traces net, IPC, Orchestrion and ESM hooks', async function () {
          this.timeout(15_000)
          // @electron/asar is a dependency of @electron/packager and an ES module.
          const asarPath = path.join(sandboxCwd(), 'node_modules', '@electron', 'asar', 'lib', 'asar.js')
          const { listPackage } = await import(pathToFileURL(asarPath).href)
          const files = listPackage(packagedAppArchive, { isPack: false })
          const tracerPackage = path.join(path.sep, 'node_modules', 'dd-trace', 'package.json')
          assert.ok(files.includes(path.join(path.sep, 'index.html')), 'The application should be packaged')
          assert.strictEqual(files.includes(tracerPackage), variant.tracer === 'external')

          if (variant.tool === 'forge') {
            const outDir = path.join(appDirectory, path.dirname(variant.main))
            const code = fs.readdirSync(outDir).map(file => fs.readFileSync(path.join(outDir, file), 'utf8')).join('\n')
            assert.ok(code.includes('DatadogBrowserWindow'), 'The tracer class names should survive minification')
          }

          const httpSpanSeen = assertTraceReceived(child, ({ payload }) => {
            const span = payload.flat().find(span => span.name === 'http.request')
            assert.ok(span, 'No http.request span found')
            assert.strictEqual(span.service, SERVICE)
            assert.strictEqual(span.meta.component, 'electron')
            assert.strictEqual(span.meta['http.status_code'], '200')
            assert.strictEqual(span.meta['http.url'], `http://127.0.0.1:${httpPort}/`)
          }, 10_000)
          const ipcSpanSeen = assertTraceReceived(child, ({ payload }) => {
            const span = payload.flat().find(span => span.name === 'electron.main.send')
            assert.ok(span, 'No electron.main.send span found')
            assert.strictEqual(span.resource, 'ping')
            assert.strictEqual(span.service, SERVICE)
            assert.strictEqual(span.meta['span.kind'], 'producer')
          }, 10_000)
          const aiSpanSeen = assertTraceReceived(child, ({ payload }) => {
            const span = payload.flat().find(span => span.name === 'generateText')
            assert.ok(span, 'No generateText span found')
            assert.strictEqual(span.service, SERVICE)
          }, 10_000)
          const honoSpanSeen = assertTraceReceived(child, ({ payload }) => {
            const span = payload.flat().find(span => span.name === 'hono.request')
            assert.ok(span, 'No hono.request span found')
            assert.strictEqual(span.resource, 'GET /hono')
            assert.strictEqual(span.service, SERVICE)
          }, 10_000)

          child.send({ name: 'http', url: `http://127.0.0.1:${httpPort}/` })
          child.send({ name: 'ipc' })
          child.send({ name: 'ai' })
          child.send({ name: 'hono' })

          await Promise.all([httpSpanSeen, ipcSpanSeen, aiSpanSeen, honoSpanSeen])
        })
      })
    }
  })
}

/**
 * Bundlers bundle devDependencies, electron-vite externalizes dependencies, and the packager only copies
 * dependencies into the packaged application.
 *
 * @param {string} appDirectory
 * @param {'dependencies' | 'devDependencies'} field
 * @param {string} main
 */
function writePackageJson (appDirectory, field, main) {
  const tarball = path.join(path.dirname(sandboxCwd()), 'dd-trace.tgz')
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({
    name: 'ElectronViteTest',
    version: '1.0.0',
    main,
    // The packager only copies listed dependencies, so the peer dependency of ai is listed too.
    [field]: {
      '@hono/node-server': HONO_NODE_SERVER_VERSION,
      ai: AI_VERSION,
      'dd-trace': `file:${tarball}`,
      hono: HONO_VERSION,
      zod: ZOD_VERSION,
    },
  }))
}

/**
 * @param {string} sandboxFolder
 * @param {string} appDirectory
 * @param {string} name
 */
function packageApp (sandboxFolder, appDirectory, name) {
  const outDir = path.join(sandboxFolder, `dist-${name}`)
  execFileSync(
    path.join(sandboxFolder, 'node_modules', '.bin', 'electron-packager'),
    [
      appDirectory,
      'ElectronViteTest',
      `--platform=${process.platform}`,
      `--arch=${process.arch}`,
      `--electron-version=${readPackageJson('electron').version}`,
      `--out=${outDir}`,
      '--overwrite',
    ],
    { cwd: sandboxFolder, killSignal: 'SIGKILL', stdio: 'pipe', timeout: 120_000 }
  )

  const packageDirectory = path.join(outDir, `ElectronViteTest-${process.platform}-${process.arch}`)
  if (process.platform === 'darwin') {
    const contents = path.join(packageDirectory, 'ElectronViteTest.app', 'Contents')
    return {
      binaryPath: path.join(contents, 'MacOS', 'ElectronViteTest'),
      packagedAppArchive: path.join(contents, 'Resources', 'app.asar'),
    }
  }
  return {
    binaryPath: path.join(packageDirectory, process.platform === 'win32' ? 'ElectronViteTest.exe' : 'ElectronViteTest'),
    packagedAppArchive: path.join(packageDirectory, 'resources', 'app.asar'),
  }
}
