'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const semver = require('semver')

const {
  FakeAgent,
  checkSpansForServiceName,
  sandboxCwd,
  spawnProc,
  stopProc,
  useSandbox,
} = require('../helpers')
const httpRequest = require('../../packages/dd-trace/test/setup/helpers/http-client')
const { readPackageJson, run, supportsNode, viteVersions } = require('./helpers')

const SERVICE = 'vite-plugin-app'

// Cover standalone output formats, shared-chunk initialization and an external tracer with bundled packages.
// Fully external packages use normal runtime instrumentation; Electron Forge covers minified Node.js library builds.
const variants = [
  { dependencies: 'bundled', format: 'cjs' },
  { dependencies: 'bundled', format: 'es' },
  // The tracer and the wrappers intercepting ES module exports land in a chunk shared by two entries.
  { dependencies: 'bundled', format: 'es', split: true },
  { dependencies: 'list', format: 'es' },
]

for (const viteVersion of viteVersions) {
  describe(`datadog-vite plugin with Vite ${viteVersion}`, () => {
    useSandbox([
      `vite@${viteVersion}`,
      '@langchain/core',
      '@langchain/langgraph',
      '@react-router/dev',
      '@react-router/express',
      '@react-router/node',
      '@hono/node-server',
      '@types/node',
      'ai',
      'express',
      'hono',
      'isbot',
      'pnpm',
      'react',
      'react-dom',
      'react-router',
      'typescript@6.0.3',
    ], true, [path.join(__dirname, 'plugin'), path.join(__dirname, 'react-router')])

    let applicationDirectory

    before(function () {
      applicationDirectory = path.join(sandboxCwd(), 'plugin')
      if (!supportsNode(['vite'])) {
        // Release lines testing older Node.js versions run this suite too, but newer Vite versions do not support them.
        this.skip()
      }
    })

    for (const variant of variants) {
      const { dependencies, format, split } = variant
      const bundled = dependencies === 'bundled'
      const tracerExternal = !bundled

      describe(`SSR build, ${dependencies} dependencies, ${format} output${split ? ', split' : ''}`, () => {
        const extension = format === 'es' ? 'mjs' : 'cjs'
        let agent
        let outDir
        let proc
        let runDirectory

        before(function () {
          this.timeout(180_000)
          outDir = path.join(applicationDirectory, `dist-${dependencies}-${format}${split ? '-split' : ''}`)
          build(applicationDirectory, outDir, variant)
          runDirectory = outDir
          if (bundled) {
            // Running outside of the project proves that nothing but built-ins is loaded from node_modules, so the
            // optional dependencies of the tracer are only required lazily.
            runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-vite-'))
            fs.cpSync(outDir, runDirectory, { recursive: true })
          }
        })

        after(() => {
          if (runDirectory && runDirectory !== outDir) fs.rmSync(runDirectory, { force: true, recursive: true })
        })

        beforeEach(async () => {
          agent = await new FakeAgent().start()
          // ES modules loaded from node_modules are only instrumented by the loader hook.
          const execArgv = tracerExternal && format === 'es' ? ['--import', 'dd-trace/initialize.mjs'] : []
          proc = await spawnProc(path.join(runDirectory, `server.${extension}`), {
            cwd: tracerExternal ? applicationDirectory : runDirectory,
            execArgv,
            env: {
              ...process.env,
              NODE_OPTIONS: '',
              DD_SERVICE: SERVICE,
              DD_TRACE_AGENT_PORT: String(agent.port),
              DD_TRACE_FLUSH_INTERVAL: '0',
            },
          })
        })

        afterEach(async () => {
          await stopProc(proc)
          await agent.stop()
        })

        it('traces CommonJS, ESM, built-ins and Orchestrion targets across chunks', async function () {
          this.timeout(60_000)

          await assertRoute(agent, proc, '/express', { ok: true }, payload => {
            const span = payload.flat().find(span => span.name === 'express.request')
            assert.ok(span, 'express.request span not found')
            assert.strictEqual(span.service, SERVICE)
          })
          await assertRoute(agent, proc, '/http', { status: 200 }, payload => {
            assert.strictEqual(checkSpansForServiceName(payload, 'http.request'), true)
          })
          await assertRoute(agent, proc, '/ai', { text: 'ok' }, payload => {
            assert.strictEqual(checkSpansForServiceName(payload, 'generateText'), true)
          })
          await assertRoute(agent, proc, '/langgraph', { step: 1 }, payload => {
            assert.strictEqual(checkSpansForServiceName(payload, 'LangGraph'), true)
          })
          await assertRoute(agent, proc, '/hono', { ok: true }, payload => {
            const span = payload.flat().find(span => span.name === 'hono.request')
            assert.ok(span, 'hono.request span not found')
            assert.strictEqual(span.resource, 'GET /hono')
            assert.strictEqual(span.service, SERVICE)
          })

          const chunks = fs.readdirSync(outDir).filter(file => file.endsWith(`.${extension}`))
          assert.ok(chunks.length > 1, `Expected a code-split output, got ${chunks.join(', ')}`)

          if (split) {
            const tracerCode = /function hasGarbageCollectionBug(\$\d+)?\s*\(/
            for (const entry of [`server.${extension}`, `worker.${extension}`]) {
              assert.doesNotMatch(fs.readFileSync(path.join(outDir, entry), 'utf8'), tracerCode, entry)
            }
            assert.match(readOutput(outDir, extension), tracerCode)
          }

          if (format === 'cjs') {
            const commitSHA = git(['rev-parse', 'HEAD'])
            const entry = fs.readFileSync(path.join(outDir, 'server.cjs'), 'utf8')
            assert.ok(entry.includes(`process.env.DD_GIT_COMMIT_SHA = ${JSON.stringify(commitSHA)}`))
            assert.match(entry, /process\.env\.DD_GIT_REPOSITORY_URL = "[^"]+"/)
            for (const chunk of chunks.filter(file => file !== 'server.cjs')) {
              assert.ok(!fs.readFileSync(path.join(outDir, chunk), 'utf8').includes('DD_GIT_COMMIT_SHA'))
            }
          }
        })
      })
    }

    it('type checks the plugin against the installed Vite types', function () {
      this.timeout(120_000)
      run(applicationDirectory, 'tsc', ['--project', 'tsconfig.json'])
    })

    describe('React Router framework mode', () => {
      let agent
      let frameworkDirectory
      let proc

      before(function () {
        this.timeout(180_000)
        frameworkDirectory = path.join(sandboxCwd(), 'react-router')
        const { peerDependencies } = readPackageJson('@react-router/dev')
        if (!semver.satisfies(readPackageJson('vite').version, peerDependencies.vite) ||
          !supportsNode(['@react-router/dev'])) {
          // React Router only supports some of the tested Vite and Node.js versions.
          this.skip()
        }
        run(frameworkDirectory, 'react-router', ['build'])
      })

      beforeEach(async () => {
        agent = await new FakeAgent().start()
        proc = await spawnProc(path.join(frameworkDirectory, 'server.js'), {
          cwd: frameworkDirectory,
          execArgv: ['--import', 'dd-trace/initialize.mjs'],
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            DD_TRACE_AGENT_PORT: String(agent.port),
            DD_TRACE_FLUSH_INTERVAL: '0',
          },
        })
      })

      afterEach(async () => {
        await stopProc(proc)
        await agent.stop()
      })

      it('instruments a dependency bundled into the server build', async function () {
        this.timeout(60_000)
        const [response] = await Promise.all([
          httpRequest.get(proc.url),
          agent.assertMessageReceived(({ payload }) => {
            assert.strictEqual(checkSpansForServiceName(payload, 'express.request'), true)
            assert.strictEqual(checkSpansForServiceName(payload, 'generateText'), true)
          }, 10_000, 1, true),
        ])
        assert.match(response.data, /<p id="text">ok<\/p>/)
      })
    })

    describe('with pnpm and hoist=false', () => {
      let agent
      let pnpmDirectory
      let proc

      before(function () {
        this.timeout(300_000)
        // Outside the sandbox, whose hoisted node_modules would otherwise be reachable from parent directories.
        pnpmDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-vite-pnpm-'))
        for (const file of ['server.mjs', 'tracer.mjs', 'model.mjs', 'graph.mjs', 'worker.mjs', 'vite.config.mjs']) {
          fs.copyFileSync(path.join(applicationDirectory, file), path.join(pnpmDirectory, file))
        }
        const tarball = path.join(path.dirname(sandboxCwd()), 'dd-trace.tgz')
        const dependencies = {}
        for (const name of ['vite', 'express', 'ai', '@langchain/langgraph', '@langchain/core', 'hono',
          '@hono/node-server']) {
          dependencies[name] = readPackageJson(name).version
        }
        dependencies['dd-trace'] = `file:${tarball}`
        fs.writeFileSync(path.join(pnpmDirectory, 'package.json'), JSON.stringify({ private: true, dependencies }))
        // Strict layout: only direct dependencies are reachable from the application, so dc-polyfill is only
        // reachable from the tracer's own directory.
        fs.writeFileSync(path.join(pnpmDirectory, 'pnpm-workspace.yaml'), 'hoist: false\nnodeLinker: isolated\n')
        run(pnpmDirectory, 'pnpm', ['install', '--ignore-scripts'])
        assert.throws(() => require.resolve('dc-polyfill', { paths: [pnpmDirectory] }), { code: 'MODULE_NOT_FOUND' })

        build(pnpmDirectory, path.join(pnpmDirectory, 'dist'), { dependencies: 'bundled', format: 'cjs' },
          path.join(pnpmDirectory, 'node_modules', '.bin', 'vite'))
      })

      after(() => {
        if (pnpmDirectory) fs.rmSync(pnpmDirectory, { force: true, recursive: true })
      })

      beforeEach(async () => {
        agent = await new FakeAgent().start()
        proc = await spawnProc(path.join(pnpmDirectory, 'dist', 'server.cjs'), {
          cwd: pnpmDirectory,
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            DD_TRACE_AGENT_PORT: String(agent.port),
            DD_TRACE_FLUSH_INTERVAL: '0',
          },
        })
      })

      afterEach(async () => {
        await stopProc(proc)
        await agent.stop()
      })

      it('instruments packages bundled from a strict node_modules layout', async function () {
        this.timeout(60_000)
        await assertRoute(agent, proc, '/express', { ok: true }, payload => {
          assert.strictEqual(checkSpansForServiceName(payload, 'express.request'), true)
        })
        await assertRoute(agent, proc, '/ai', { text: 'ok' }, payload => {
          assert.strictEqual(checkSpansForServiceName(payload, 'generateText'), true)
        })
        await assertRoute(agent, proc, '/hono', { ok: true }, payload => {
          assert.strictEqual(checkSpansForServiceName(payload, 'hono.request'), true)
        })
      })
    })
  })
}

/**
 * @param {string} cwd
 * @param {string} outDir
 * @param {{ dependencies: string, format: string, split?: boolean }} variant
 * @param {string} [vite]
 */
function build (cwd, outDir, { dependencies, format, split }, vite = 'vite') {
  run(cwd, vite, ['build'], {
    VITE_DEPENDENCIES: dependencies,
    VITE_OUTPUT_FORMAT: format,
    VITE_OUT_DIR: outDir,
    VITE_SPLIT: String(Boolean(split)),
  })
}

/**
 * @param {FakeAgent} agent
 * @param {{ url: string }} proc
 * @param {string} route
 * @param {unknown} expected
 * @param {(payload: Array<Array<{ name: string, service: string }>>) => void} assertPayload
 */
async function assertRoute (agent, proc, route, expected, assertPayload) {
  const [response] = await Promise.all([
    httpRequest.get(`${proc.url}${route}`),
    agent.assertMessageReceived(({ payload }) => assertPayload(payload), 10_000, 1, true),
  ])
  assert.deepStrictEqual(response.data, expected)
}

/**
 * @param {string[]} args
 */
function git (args) {
  return execFileSync('git', args, { cwd: sandboxCwd(), encoding: 'utf8' }).trim()
}

/**
 * @param {string} directory
 * @param {string} extension
 */
function readOutput (directory, extension) {
  return fs.readdirSync(directory)
    .filter(file => file.endsWith(`.${extension}`))
    .map(file => fs.readFileSync(path.join(directory, file), 'utf8'))
    .join('\n')
}
