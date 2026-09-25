'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { once } = require('node:events')
const { copyFile, mkdir, mkdtemp, rm, symlink } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const axios = require('axios')
const semver = require('semver')

if (semver.gte(process.versions.node, '22.22.3')) require('../../../register')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const execFileAsync = promisify(execFile)

/**
 * @param {string} versionKey
 * @param {boolean} instrumented
 */
async function runCjsMutation (versionKey, instrumented) {
  const args = semver.gte(process.versions.node, '22.22.3') ? ['--no-experimental-require-module'] : []
  args.push(require.resolve('./fixtures/cjs-mutation'), versionKey)
  const { stdout } = await execFileAsync(process.execPath, args, {
    env: { ...process.env, INSTRUMENTED: instrumented ? '1' : '' },
  })
  return JSON.parse(stdout)
}

/**
 * @param {string} versionKey
 * @param {number} agentPort
 */
async function runEsmRequest (versionKey, agentPort) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dd-react-router-esm-'))
  try {
    const nodeModules = path.join(directory, 'node_modules')
    await mkdir(nodeModules)
    await symlink(
      path.resolve(__dirname, `../../../versions/react-router@${versionKey}/node_modules/react-router`),
      path.join(nodeModules, 'react-router'),
      'dir'
    )
    const fixture = path.join(directory, 'request.mjs')
    await copyFile(path.join(__dirname, 'fixtures/esm-request.mjs'), fixture)
    const { stdout } = await execFileAsync(process.execPath, [
      fixture,
      require.resolve('../../../'),
      require.resolve('../../../register'),
      String(agentPort),
    ], { env: { ...process.env, DD_INJECT_FORCE: '1', NODE_OPTIONS: '' } })
    return JSON.parse(stdout)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * @param {(request: Request) => Promise<Response>} handleRequest
 * @param {boolean} [hasRoute]
 * @param {string} [path]
 * @param {number} [expectedStatus]
 * @param {boolean} [checkBody]
 * @param {string} [route]
 * @param {boolean} [checkLoaderError]
 * @param {Record<string, string>} [requestHeaders]
 */
async function assertHttpRoute (
  handleRequest, hasRoute = true, path = '/users/123', expectedStatus = 200, checkBody = true,
  route = '/users/:id', checkLoaderError = false, requestHeaders
) {
  const http = require('node:http')
  const server = http.createServer(async (req, res) => {
    try {
      const response = await handleRequest(new Request(`http://localhost${req.url}`, { method: req.method }))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(await response.text())
    } catch (error) {
      res.writeHead(500)
      res.end(error.message)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const trace = agent.assertSomeTraces(traces => {
      const span = traces[0].find(span => span.type === 'web')
      assert.ok(span)
      if (requestHeaders?.Host) assert.equal(span.meta['http.url'], `http://${requestHeaders.Host}${path}`)
      assert.equal(span.meta['http.route'], hasRoute ? route : undefined)
      if (hasRoute) assert.equal(span.resource, `GET ${route}`)
      if (checkLoaderError) {
        const loader = traces[0].find(span => span.name === 'react-router.loader')
        assert.ok(loader)
        assert.equal(loader.error, 1)
        assert.equal(loader.meta['error.message'], 'loader failure')
      }
    })
    const address = /** @type {import('node:net').AddressInfo} */ (server.address())
    const response = axios.get(`http://127.0.0.1:${address.port}${path}`, {
      headers: requestHeaders,
      validateStatus: () => true,
    })
    const [, result] = await Promise.all([trace, response])
    assert.equal(result.status, expectedStatus)
    if (checkBody) assert.equal(result.data, 'ok')
  } finally {
    const closed = once(server, 'close')
    server.close()
    await closed
  }
}

/**
 * @param {object} [routeModule]
 * @param {object} [rootModule]
 * @param {object} [entryModule]
 */
function createBuild (routeModule = {}, rootModule = {}, entryModule = {}) {
  return {
    basename: '/',
    future: { v8_middleware: false },
    ssr: true,
    prerender: [],
    routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
    routes: {
      root: { id: 'root', path: '/', module: { default () {}, ...rootModule } },
      users: {
        id: 'users',
        parentId: 'root',
        path: 'users/:id',
        module: { default () {}, ...routeModule },
      },
    },
    assets: { version: 'test', routes: {} },
    entry: {
      module: {
        default (request, status, headers) {
          return new Response('ok', { status, headers })
        },
        ...entryModule,
      },
    },
  }
}

describe('Plugin', () => {
  describe('react-router Framework Mode', () => {
    withVersions('react-router', 'react-router', (version, moduleName, resolvedVersion) => {
      let createRequestHandler
      let tracer

      before(async () => {
        tracer = await agent.load(['react-router', 'http'], [{}, { client: false }])
        tracer.use('react-router', false)
        createRequestHandler = require(`../../../versions/react-router@${version}`).get().createRequestHandler
      })

      after(() => agent.close())

      afterEach(() => tracer.use('react-router', false))

      it('sets the root route for a document request without a loader', async () => {
        tracer.use('react-router', {})
        const handleRequest = createRequestHandler(createBuild(), 'test')
        await assertHttpRoute(handleRequest)
      })

      it('sets the root route when the matched route has no path', async () => {
        tracer.use('react-router', {})
        const build = createBuild()
        Reflect.deleteProperty(build.routes.root, 'path')
        build.routes.index = { id: 'index', parentId: 'root', index: true, module: { default () {} } }
        const handleRequest = createRequestHandler(build, 'test')
        await assertHttpRoute(handleRequest, true, '/', 200, true, '/')
      })

      it('sets the route for a data request', async () => {
        tracer.use('react-router', {})
        const handleRequest = createRequestHandler(createBuild({ loader () { return 'user' } }), 'test')
        await assertHttpRoute(handleRequest, true, '/users/123.data', 200, false)
      })

      it('sets the root route for root data', async () => {
        tracer.use('react-router', {})
        const handleRequest = createRequestHandler(createBuild({}, { loader () { return 'root' } }), 'test')
        const path = semver.gte(resolvedVersion, '8.0.0') ? '/_.data' : '/_root.data'
        await assertHttpRoute(handleRequest, true, path, 200, false, '/')
      })

      it('sets the root route for root data under a basename', async () => {
        tracer.use('react-router', {})
        const build = createBuild({}, { loader () { return 'root' } })
        build.basename = '/app'
        const handleRequest = createRequestHandler(build, 'test')
        const path = semver.gte(resolvedVersion, '8.0.0') ? '/app/_.data' : '/app/_root.data'
        await assertHttpRoute(handleRequest, true, path, 200, false, '/')
      })

      it('sets the route for a trailing slash request', async () => {
        tracer.use('react-router', {})
        const handleRequest = createRequestHandler(createBuild(), 'test')
        await assertHttpRoute(handleRequest, true, '/users/123/')
      })

      it('continues tracing after an invalid Host header', async () => {
        tracer.use('react-router', {})
        const handleRequest = createRequestHandler(createBuild(), 'test')
        await assertHttpRoute(handleRequest, false, '/users/123', 200, true, '/users/:id', false,
          { Host: 'localhost:abc' })
        await assertHttpRoute(handleRequest)
      })

      it('leaves an unmatched request without a route', async () => {
        tracer.use('react-router', {})
        const handleRequest = createRequestHandler(createBuild(), 'test')
        await assertHttpRoute(handleRequest, false, '/missing', 404, false)
      })

      it('reports a loader error without changing the response', async () => {
        tracer.use('react-router', {})
        const build = createBuild({ loader () { throw new Error('loader failure') } })
        const handleRequest = createRequestHandler(build, 'test')
        await assertHttpRoute(handleRequest, true, '/users/123', 500, false, '/users/:id', true)
      })

      it('leaves a manifest request without a route', async () => {
        tracer.use('react-router', {})
        const build = createBuild()
        build.routeDiscovery.mode = 'lazy'
        const handleRequest = createRequestHandler(build, 'test')
        await assertHttpRoute(handleRequest, false, '/__manifest?version=test&paths=/users/123', 200, false)
      })

      it('preserves loader output without subscribers', async () => {
        let calls = 0
        const handleRequest = createRequestHandler(createBuild({ loader () { calls++; return 'user' } }), 'test')
        const response = await handleRequest(new Request('http://localhost/users/123'))
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'ok')
        assert.equal(calls, 1)
      })

      it('preserves a request without an ambient span', async () => {
        tracer.use('react-router', {})
        const handleRequest = createRequestHandler(createBuild({ loader () { return 'user' } }), 'test')
        const response = await handleRequest(new Request('http://localhost/users/123'))
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'ok')
      })

      it('reports an action span without changing the response', async () => {
        tracer.use('react-router', {})
        const handleRequest = createRequestHandler(createBuild({ action () { return { saved: true } } }), 'test')
        const trace = agent.assertSomeTraces(traces => {
          const action = traces[0].find(span => span.name === 'react-router.action')
          assert.ok(action)
          assert.equal(action.meta['react-router.route_id'], 'users')
          assert.equal(action.error, 0)
        })
        const response = tracer.trace('test.request', () => {
          return handleRequest(new Request('http://localhost/users/123', { method: 'POST' }))
        })
        const [, result] = await Promise.all([trace, response])
        assert.equal(result.status, 200)
        assert.equal(await result.text(), 'ok')
      })

      it('traces a request loaded through the ESM package entry', async () => {
        const trace = agent.assertSomeTraces(traces => {
          const spans = traces[0]
          const request = spans.find(span => span.type === 'web')
          const loader = spans.find(span => span.name === 'react-router.loader')
          assert.ok(request)
          assert.ok(loader)
          assert.equal(request.meta['http.route'], '/users/:id')
          assert.equal(loader.parent_id.toString(), request.span_id.toString())
        })
        const request = runEsmRequest(version, agent.port)
        const [, result] = await Promise.all([trace, request])
        assert.deepEqual(result, { status: 200, body: 'ok' })
      }).timeout(20000)

      it('does not mutate a frozen server build', async () => {
        tracer.use('react-router', {})
        const build = createBuild()
        Object.freeze(build.entry.module)
        Object.freeze(build.entry)
        Object.freeze(build)
        const handleRequest = createRequestHandler(build, 'test')
        await assertHttpRoute(handleRequest)
      })

      it('sets the route when enabled after handler creation', async () => {
        const handleRequest = createRequestHandler(createBuild(), 'test')
        tracer.use('react-router', {})
        await assertHttpRoute(handleRequest)
      })

      it('stops and resumes reporting for an existing handler', async () => {
        tracer.use('react-router', {})
        const handleRequest = createRequestHandler(createBuild(), 'test')
        await assertHttpRoute(handleRequest)
        tracer.use('react-router', false)
        await assertHttpRoute(handleRequest, false)
        tracer.use('react-router', {})
        await assertHttpRoute(handleRequest)
      })

      it('finishes a loader started before the plugin is disabled', async () => {
        tracer.use('react-router', {})
        let loaderStarted
        /** @type {((value: string) => void) | undefined} */
        let releaseLoader
        const started = new Promise(resolve => { loaderStarted = resolve })
        const release = new Promise(resolve => { releaseLoader = resolve })
        const handleRequest = createRequestHandler(createBuild({
          loader () {
            loaderStarted()
            return release
          },
        }), 'test')
        const trace = agent.assertSomeTraces(traces => {
          const spans = traces[0]
          assert.ok(spans.some(span => span.name === 'test.first.request'))
          const loader = spans.find(span => span.name === 'react-router.loader')
          assert.ok(loader)
          assert.ok(loader.duration > 0)
        })
        const firstResponse = tracer.trace('test.first.request', () => {
          return handleRequest(new Request('http://localhost/users/123'))
        })
        const responses = (async () => {
          await started
          tracer.use('react-router', false)
          assert.ok(releaseLoader)
          releaseLoader('user')
          const first = await firstResponse
          assert.equal(first.status, 200)
          tracer.use('react-router', {})
          const second = await tracer.trace('test.second.request', () => {
            return handleRequest(new Request('http://localhost/users/456'))
          })
          assert.equal(second.status, 200)
        })()
        await Promise.all([trace, responses])
      })

      it('finishes parallel loader spans with their own invocation', async () => {
        tracer.use('react-router', {})
        let rootFinished
        const rootFinishedPromise = new Promise(resolve => { rootFinished = resolve })
        let userStarted
        const userStartedPromise = new Promise(resolve => { userStarted = resolve })
        const key = resolvedVersion === '7.9.5' ? 'unstable_instrumentations' : 'instrumentations'
        const userInstrumentation = {
          route (route) {
            if (route.id !== 'root') return
            route.instrument({
              async loader (run) {
                const result = await run()
                rootFinished()
                return result
              },
            })
          },
        }
        const build = createBuild(
          {
            loader: async () => {
              userStarted()
              await rootFinishedPromise
              await new Promise(resolve => setImmediate(resolve))
              return 'user'
            },
          },
          {
            loader: async () => {
              await userStartedPromise
              throw new Error('root failure')
            },
          },
          { [key]: [userInstrumentation] }
        )
        const handleRequest = createRequestHandler(build, 'test')
        const trace = agent.assertSomeTraces(traces => {
          const spans = traces[0]
          const request = spans.find(span => span.name === 'test.request')
          const root = spans.find(span => span.meta['react-router.route_id'] === 'root')
          const users = spans.find(span => span.meta['react-router.route_id'] === 'users')
          assert.ok(request)
          assert.ok(root)
          assert.ok(users)
          assert.equal(root.parent_id.toString(), request.span_id.toString())
          assert.equal(users.parent_id.toString(), request.span_id.toString())
          assert.equal(root.error, 1)
          assert.equal(users.error, 0)
          assert.ok(root.start + BigInt(root.duration) < users.start + BigInt(users.duration))
        })
        const response = tracer.trace('test.request', () => handleRequest(new Request('http://localhost/users/123')))
        const [, result] = await Promise.all([trace, response])
        assert.equal(result.status, 500)
      })

      it('preserves instrumentation added before the first request', async () => {
        const build = createBuild()
        const handleRequest = createRequestHandler(build, 'test')
        const key = resolvedVersion === '7.9.5' ? 'unstable_instrumentations' : 'instrumentations'
        let calls = 0
        build.entry.module[key] = [{
          handler (handler) {
            handler.instrument({
              async request (callRequest) {
                calls++
                await callRequest()
              },
            })
          },
        }]

        const response = await handleRequest(new Request('http://localhost/users/123'))
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'ok')
        assert.equal(calls, 1)
      })

      if (semver.major(resolvedVersion) === 7) {
        it('preserves instrumentation added after the CJS factory is created', async () => {
          const [native, instrumented] = await Promise.all([
            runCjsMutation(version, false),
            runCjsMutation(version, true),
          ])
          assert.deepEqual(native, { cjs: true, calls: 1, status: 200, body: 'ok' })
          assert.deepEqual(instrumented, native)
        })
      }
    })

    it('instruments production package exports in a fresh process', async () => {
      await execFileAsync(process.execPath, [
        require.resolve('mocha/bin/mocha.js'),
        '--fail-zero',
        __filename,
        '--grep',
        'sets the root route for a document request without a loader',
        '--reporter',
        'dot',
      ], { env: { ...process.env, NODE_ENV: 'production' } })
    })
  })
})
