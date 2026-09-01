'use strict'

const assert = require('node:assert/strict')
/* eslint import/no-extraneous-dependencies: ["error", {"packageDir": ['./']}] */

const { execSync, spawn } = require('node:child_process')
const { once } = require('node:events')
const { mkdirSync, writeFileSync, readdirSync } = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const axios = require('axios')
const dc = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const { satisfies } = require('semver')

const { assertObjectContains } = require('../../../integration-tests/helpers')

const { storage } = require('../../datadog-core')
const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
require('../../datadog-instrumentations/src/next')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { NODE_MAJOR } = require('../../../version')
const addOtelRequestTags = require('../src/request-tags')
const { rawExpectedSchema } = require('./naming')

const min = NODE_MAJOR >= 25 ? '>=13' : '>=11.1'

function getCompiledRuntimeHook (runtime) {
  return instrumentations.next.find(hook => hook.filePattern?.includes(`${runtime}[`)).hook
}

function getDisabledRuntimeHooks () {
  const hooks = []
  const channels = new Map()
  const getChannel = name => {
    if (!channels.has(name)) {
      channels.set(name, {
        hasSubscribers: false,
        publish: () => { throw new Error(`unexpected ${name} publish`) },
        runStores: () => { throw new Error(`unexpected ${name} instrumentation`) },
      })
    }
    return channels.get(name)
  }

  const loadNext = proxyquire.noPreserveCache()
  loadNext('../../datadog-instrumentations/src/next', {
    '../../datadog-shimmer': {
      wrap (target, method, wrapper) {
        target[method] = wrapper(target[method])
      },
    },
    '../../dd-trace/src/opentelemetry/span-ending-hook': {},
    './helpers/instrument': {
      channel: getChannel,
      addHook: (metadata, hook) => hooks.push({ ...metadata, hook }),
    },
  })

  return runtime => hooks.find(hook => hook.filePattern?.includes(`${runtime}[`)).hook
}

describe('Plugin', function () {
  it('captures the URL and socket peer needed by OTel server attributes', () => {
    const tags = {}
    const span = { setTag: (key, value) => { tags[key] = value } }
    const req = {
      headers: { host: 'example.com:8080', 'user-agent': 'test-agent/1.0' },
      method: 'GET',
      socket: { encrypted: false, remoteAddress: '192.0.2.1' },
      url: '/products/42?token=secret',
    }

    addOtelRequestTags(
      span,
      { DD_TRACE_OTEL_SEMANTICS_ENABLED: true, queryStringObfuscation: false },
      req
    )

    assert.strictEqual(tags['http.url'], 'http://example.com:8080/products/42?token=secret')
    assert.strictEqual(tags['network.peer.address'], '192.0.2.1')
    // The shared `web.addRequestTags` path records this, so the Next path has to as well or the
    // conversion emits no `user_agent.original`.
    assert.strictEqual(tags['http.useragent'], 'test-agent/1.0')
  })

  it('captures an absolute URL and Headers values from a Web Request', () => {
    const tags = {}
    const span = { setTag: (key, value) => { tags[key] = value } }
    const req = new Request('https://example.com/products/42?token=secret', {
      headers: { 'user-agent': 'test-agent/1.0' },
    })

    addOtelRequestTags(
      span,
      { DD_TRACE_OTEL_SEMANTICS_ENABLED: true, queryStringObfuscation: false },
      req
    )

    assert.strictEqual(tags['http.url'], 'https://example.com/products/42?token=secret')
    assert.strictEqual(tags['http.useragent'], 'test-agent/1.0')
    assert.strictEqual(tags['network.peer.address'], undefined)
  })

  it('does not read request attributes when OTel semantics are disabled', () => {
    const tags = {}
    const span = { setTag: (key, value) => { tags[key] = value } }

    addOtelRequestTags(span, { DD_TRACE_OTEL_SEMANTICS_ENABLED: false }, {
      headers: { host: 'example.com' },
      method: 'GET',
      url: '/',
    })

    assert.deepStrictEqual(tags, {})
  })

  it('does not read request attributes without headers', () => {
    const tags = {}
    const span = { setTag: (key, value) => { tags[key] = value } }

    addOtelRequestTags(span, { DD_TRACE_OTEL_SEMANTICS_ENABLED: true }, { method: 'GET', url: '/' })

    assert.deepStrictEqual(tags, {})
  })

  let server
  let port
  let downstreamServer
  let downstreamPort

  // These next versions have a dependency which uses a deprecated node buffer
  describe('next', () => {
    const satisfiesStandalone = version => satisfies(version, '>=12.0.0')

    withVersions('next', 'next', min, version => {
      const pkg = require(`../../../versions/next@${version}/node_modules/next/package.json`)

      before(done => {
        downstreamServer = http.createServer((_req, res) => {
          res.writeHead(204)
          res.end()
        }).listen(0, '127.0.0.1', () => {
          downstreamPort = downstreamServer.address().port
          done()
        })
      })

      after(done => downstreamServer.close(done))

      const startServer = (
        {
          withConfig,
          standalone,
          withHttp = true,
          httpResourceRenamingEnabled = false,
          serverFile = 'server',
          httpServerErrorStatuses,
        },
        schemaVersion = 'v0',
        defaultToGlobalService = false
      ) => {
        before(async () => {
          return agent.load('next')
        })

        before(function (done) {
          this.timeout(300 * 1000)
          const cwd = standalone
            ? path.join(__dirname, '.next/standalone')
            : __dirname

          server = spawn('node', [serverFile], {
            cwd,
            env: {
              ...process.env,
              VERSION: version,
              PORT: 0,
              DOWNSTREAM_URL: `http://127.0.0.1:${downstreamPort}/downstream`,
              DOWNSTREAM_PORT: String(downstreamPort),
              DD_TRACE_AGENT_PORT: agent.server.address().port,
              WITH_CONFIG: withConfig,
              WITH_HTTP: String(withHttp),
              WITH_HTTP_RESOURCE_RENAMING: String(httpResourceRenamingEnabled),
              DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: schemaVersion,
              DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: defaultToGlobalService,
              // eslint-disable-next-line n/no-path-concat
              NODE_OPTIONS: `--require ${__dirname}/datadog.js`,
              HOSTNAME: '127.0.0.1',
              TIMES_HOOK_CALLED: 0,
              ...(httpServerErrorStatuses === undefined
                ? undefined
                : { DD_TRACE_HTTP_SERVER_ERROR_STATUSES: httpServerErrorStatuses }),
            },
          })

          server.once('error', done)

          function waitUntilServerStarted (chunk) {
            const chunkStr = chunk.toString()
            const match = chunkStr.match(/port:? (\d+)/) ||
              chunkStr.match(/http:\/\/127\.0\.0\.1:(\d+)/)

            if (match) {
              port = Number(match[1])
              server.stdout.off('data', waitUntilServerStarted)
              done()
            }
          }
          server.stdout.on('data', waitUntilServerStarted)

          server.stderr.on('data', chunk => process.stderr.write(chunk))
          server.stdout.on('data', chunk => process.stdout.write(chunk))
        })

        after(async function () {
          this.timeout(30 * 1000)

          server.kill()

          await axios.get(`http://127.0.0.1:${port}/api/hello/world`).catch(() => {})
          await agent.close()
        })
      }

      before(async function () {
        this.timeout(240 * 1000) // Webpack is very slow and builds on every test run

        const cwd = __dirname
        const pkg = require(`../../../versions/next@${version}/package.json`)
        const realVersion = require(`../../../versions/next@${version}`).version()

        delete pkg.workspaces

        // Next.js 16's app-router build needs react 19; the version manager resolves next's
        // loose peer to react 18, which fails the build. Pin both to what a next-16 app runs.
        if (satisfies(realVersion, '>=16')) {
          pkg.dependencies.react = '^19'
          pkg.dependencies['react-dom'] = '^19'
        }

        writeFileSync(path.join(__dirname, 'package.json'), JSON.stringify(pkg, null, 2))

        // installing here for standalone purposes, copying `nodules` above was not generating the server file properly
        // if there is a way to re-use nodules from somewhere in the versions folder, this `execSync` will be reverted
        try {
          execSync('yarn install', { cwd })
        } catch { // retry in case of error from registry
          execSync('yarn install', { cwd })
        }

        // dd-trace is the package under test, not a published dependency of this app. Drop a tiny
        // resolvable `dd-trace` package into node_modules that delegates to the monorepo root, so
        // route handlers can `require('dd-trace')` exactly like a customer. Kept external by the
        // pages-API default and `serverExternalPackages`, it resolves at runtime to the one tracer
        // the server loads via `--require datadog.js`, so the active span flows into the route.
        const ddTraceStub = path.join(cwd, 'node_modules', 'dd-trace')
        mkdirSync(ddTraceStub, { recursive: true })
        writeFileSync(
          path.join(ddTraceStub, 'package.json'),
          JSON.stringify({ name: 'dd-trace', version: '0.0.0-local', main: 'index.js' })
        )
        writeFileSync(
          path.join(ddTraceStub, 'index.js'),
          `module.exports = require(${JSON.stringify(path.join(__dirname, '..', '..', '..'))})\n`
        )

        // building in-process makes tests fail for an unknown reason
        // next <12 needs OpenSSL's legacy provider for webpack's MD4 hashing on Node >=17; newer
        // next does not, and from 16 the flag is rejected in a build worker's NODE_OPTIONS.
        const legacyOpenssl = satisfies(realVersion, '<12') ? '--openssl-legacy-provider' : ''
        execSync('yarn exec next build', {
          cwd,
          env: {
            ...process.env,
            NODE_OPTIONS: legacyOpenssl,
            VERSION: realVersion,
          },
          stdio: ['pipe', 'ignore', 'pipe'],
        })

        if (satisfiesStandalone(realVersion)) {
          // copy public and static files to the `standalone` folder
          const publicOrigin = path.join(__dirname, 'public')
          const publicDestination = path.join(__dirname, '.next/standalone/public')
          execSync(`mkdir ${publicDestination}`)
          execSync(`cp ${publicOrigin}/test.txt ${publicDestination}/test.txt`)
        }
      })

      after(function () {
        this.timeout(5000)
        const files = [
          'package.json',
          'node_modules',
          '.next',
          'yarn.lock',
        ]
        const paths = files.map(file => path.join(__dirname, file))
        execSync(`rm -rf ${paths.join(' ')}`)
      })

      withNamingSchema(
        (done) => {
          axios
            .get(`http://127.0.0.1:${port}/api/hello/world`)
            // skip catch due to socket hang up when server is killed, unsure if this catch is needed
            // .catch(done)
        },
        rawExpectedSchema.server,
        {
          hooks: (schemaVersion, defaultToGlobalService) => startServer({
            withConfig: false,
            standalone: false,
          }, schemaVersion, defaultToGlobalService),
          selectSpan: traces => traces[0][1],
        }
      )

      describe('without configuration', () => {
        startServer({ withConfig: false, standalone: false })

        describe('for api routes', () => {
          it('should do automatic instrumentation', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  service: 'test',
                  type: 'web',
                  resource: 'GET /api/hello/[name]',
                  meta: {
                    'span.kind': 'server',
                    'http.method': 'GET',
                    'http.status_code': '200',
                    component: 'next',
                    '_dd.integration': 'next',
                  },
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/hello/world`)
              .catch(done)
          })

          const pathTests = [
            ['/api/hello', '/api/hello'],
            ['/api/hello/world', '/api/hello/[name]'],
            ['/api/hello/other', '/api/hello/other'],
          ]
          pathTests.forEach(([url, expectedPath]) => {
            it(`should infer the correct resource path (${expectedPath})`, done => {
              agent
                .assertSomeTraces(traces => {
                  const spans = traces[0]

                  assert.strictEqual(spans[1].resource, `GET ${expectedPath}`)
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://127.0.0.1:${port}${url}`)
                .catch(done)
            })
          })

          it('should propagate context', done => {
            axios
              .get(`http://127.0.0.1:${port}/api/hello/world`)
              .then(res => {
                assert.strictEqual(res.data.name, 'next.request')
                done()
              })
              .catch(done)
          })

          it('should handle routes not found', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  service: 'test',
                  type: 'web',
                  meta: {
                    'span.kind': 'server',
                    'http.method': 'GET',
                    'http.status_code': '404',
                    component: 'next',
                  },
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/missing`)
              .catch(() => {})
          })

          it('should handle invalid catch all parameters', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  service: 'test',
                  type: 'web',
                  resource: 'GET /_error',
                  meta: {
                    'span.kind': 'server',
                    'http.method': 'GET',
                    // Next.js 16 surfaces a malformed request URL as a 500 instead of a 400.
                    'http.status_code': satisfies(pkg.version, '>=16') ? '500' : '400',
                    component: 'next',
                  },
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/invalid/%ff`)
              .catch(() => {})
          })

          it('should pass resource path to parent span', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assert.strictEqual(spans[0].name, 'web.request')
                assert.strictEqual(spans[0].resource, 'GET /api/hello/[name]')
                assert.strictEqual(spans[0].meta['http.endpoint'], undefined)
                assert.strictEqual(spans[1].name, 'next.request')
                assert.strictEqual(spans[1].parent_id.toString(), spans[0].span_id.toString())
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/hello/world`)
              .catch(done)
          })

          it('should preserve an upstream-established route on the HTTP parent', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assert.strictEqual(spans[0].name, 'web.request')
                assert.strictEqual(spans[0].resource, 'GET /upstream/[id]')
                assert.strictEqual(spans[0].meta['http.route'], '/upstream/[id]')
                assert.strictEqual(spans[1].name, 'next.request')
                assert.strictEqual(spans[1].resource, 'GET /api/hello/[name]')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/hello/world`, {
                headers: { 'x-test-upstream-route': '/upstream/[id]' },
              })
              .catch(done)
          })

          it('should handle child spans and still find the request object', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                const nextRequestSpan = spans.find(span => span.name === 'next.request')
                assert.ok(nextRequestSpan, 'next.request span should exist')

                assertObjectContains(nextRequestSpan, {
                  resource: 'GET /api/hello/[name]',
                  meta: {
                    'next.page': '/api/hello/[name]',
                    'http.method': 'GET',
                    'http.status_code': '200',
                  },
                })

                const webRequestSpan = spans.find(span => span.name === 'web.request')
                assert.ok(webRequestSpan, 'web.request span should exist')
                assert.strictEqual(webRequestSpan.resource, 'GET /api/hello/[name]')

                const childSpan = spans.find(span => span.name === 'child.operation')
                assert.ok(childSpan, 'child span should exist')
                assert.strictEqual(childSpan.parent_id.toString(), nextRequestSpan.span_id.toString())
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/hello/world?createChildSpan=true`)
              .catch(done)
          })

          if (satisfies(pkg.version, '>=15.4.1')) {
            it('should create one Pages API request span with a downstream HTTP child span', () => {
              const tracingPromise = agent.assertSomeTraces(traces => {
                const spans = traces[0]
                const nextRequestSpans = spans.filter(span => span.name === 'next.request')

                assert.strictEqual(nextRequestSpans.length, 1)

                const nextRequestSpan = nextRequestSpans[0]
                assertObjectContains(nextRequestSpan, {
                  resource: 'GET /api/hello/downstream',
                  meta: {
                    'next.page': '/api/hello/downstream',
                    'http.method': 'GET',
                    'http.status_code': '200',
                  },
                })

                const downstreamSpan = spans.find(span => span.name === 'http.request' &&
                  span.parent_id.toString() === nextRequestSpan.span_id.toString())
                assert.ok(downstreamSpan, 'downstream HTTP client span should be a child of next.request')
              })

              return Promise.all([
                axios.get(`http://127.0.0.1:${port}/api/hello/downstream`),
                tracingPromise,
              ])
            })
          }
        })

        describe('for pages', () => {
          it('should do automatic instrumentation', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  service: 'test',
                  type: 'web',
                  resource: 'GET /hello/[name]',
                  meta: {
                    'span.kind': 'server',
                    'http.method': 'GET',
                    'http.status_code': '200',
                    component: 'next',
                  },
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/hello/world`)
              .catch(done)
          })

          const pathTests = [
            ['/hello', '/hello'],
            ['/hello/world', '/hello/[name]'],
            ['/hello/other', '/hello/other'],
            ['/error/not_found', '/error/not_found', satisfies(pkg.version, '>=10') ? 404 : 500],
            ['/error/get_server_side_props', '/error/get_server_side_props', 500],
          ]
          pathTests.forEach(([url, expectedPath, statusCode]) => {
            it(`should infer the correct resource (${expectedPath})`, done => {
              agent
                .assertSomeTraces(traces => {
                  const spans = traces[0]

                  assertObjectContains(spans[1], {
                    resource: `GET ${expectedPath}`,
                    meta: {
                      'http.status_code': `${statusCode || 200}`,
                    },
                  })
                })
                .then(done)
                .catch(done)

              axios.get(`http://127.0.0.1:${port}${url}`)
            })
          })

          it('should handle pages not found', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  service: 'test',
                  type: 'web',
                  meta: {
                    'span.kind': 'server',
                    'http.method': 'GET',
                    'http.status_code': '404',
                    component: 'next',
                  },
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/missing`)
              .catch(() => {})
          })

          it('should pass resource path to parent span', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assert.strictEqual(spans[0].name, 'web.request')
                assert.strictEqual(spans[0].resource, 'GET /hello/[name]')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/hello/world`)
              .catch(done)
          })

          it('should attach errors by default', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  error: 1,
                  meta: {
                    'http.status_code': '500',
                    'error.message': 'fail',
                    'error.type': 'Error',
                  },
                })
                assert.ok(spans[1].meta['error.stack'])
              })
              .then(done)
              .catch(done)

            axios.get(`http://127.0.0.1:${port}/error/get_server_side_props`)
          })
        })

        describe('for static files', () => {
          it('should do automatic instrumentation for assets', () => {
            const tracingPromise = agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  service: 'test',
                  type: 'web',
                  resource: 'GET /public/*',
                  meta: {
                    'span.kind': 'server',
                    'http.method': 'GET',
                    'http.status_code': '200',
                    component: 'next',
                  },
                })
              })

            return Promise.all([axios.get(`http://127.0.0.1:${port}/test.txt`), tracingPromise])
          })

          it('should do automatic instrumentation for static chunks', () => {
            // Get first static chunk file programmatically
            const file = readdirSync(path.join(__dirname, '.next/static/chunks'))[0]

            const tracingPromise = agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  resource: 'GET /_next/static/*',
                  meta: {
                    'http.method': 'GET',
                    'http.status_code': '200',
                    component: 'next',
                  },
                })
              })

            return Promise.all([axios.get(`http://127.0.0.1:${port}/_next/static/chunks/${file}`), tracingPromise])
          })

          it('should pass resource path to parent span', () => {
            const tracingPromise = agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assert.strictEqual(spans[0].name, 'web.request')
                assert.strictEqual(spans[0].resource, 'GET /public/*')
              })

            return Promise.all([axios.get(`http://127.0.0.1:${port}/test.txt`), tracingPromise])
          })

          it('should not replace an upstream parent route for static files', () => {
            const tracingPromise = agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assert.strictEqual(spans[0].name, 'web.request')
                assert.strictEqual(spans[0].resource, 'GET /upstream/[id]')
                assert.strictEqual(spans[0].meta['http.route'], '/upstream/[id]')
                assert.strictEqual(spans[1].name, 'next.request')
                assert.strictEqual(spans[1].resource, 'GET /public/*')
              })

            return Promise.all([
              axios.get(`http://127.0.0.1:${port}/test.txt`, {
                headers: { 'x-test-upstream-route': '/upstream/[id]' },
              }),
              tracingPromise,
            ])
          })
        })

        describe('when an error happens', () => {
          it('should attach a Pages API error to the request span', () => {
            const tracingPromise = agent
              .assertSomeTraces(traces => {
                const nextRequestSpans = traces[0].filter(span => span.name === 'next.request')

                assert.strictEqual(nextRequestSpans.length, 1)
                assertObjectContains(nextRequestSpans[0], {
                  resource: 'GET /api/error/[name]',
                  error: 1,
                  meta: {
                    'http.status_code': '500',
                  },
                })

                if (satisfies(pkg.version, '>=15.4.1')) {
                  assertObjectContains(nextRequestSpans[0], {
                    meta: {
                      'error.message': 'oh no',
                      'error.type': 'Error',
                    },
                  })
                  assert.ok(nextRequestSpans[0].meta['error.stack'])
                }
              })

            return Promise.all([
              axios
                .get(`http://127.0.0.1:${port}/api/error/boom`)
                .catch(error => assert.strictEqual(error.response?.status, 500)),
              tracingPromise,
            ])
          })
        })
      })

      if (satisfies(pkg.version, '>=13.4.0')) {
        describe('with app directory', () => {
          startServer({ withConfig: false, standalone: false, httpResourceRenamingEnabled: true })

          it('should infer the correct resource path for appDir routes', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]
                const nextRequestSpans = spans.filter(span => span.name === 'next.request')

                assert.strictEqual(nextRequestSpans.length, 1)
                assert.strictEqual(nextRequestSpans[0].resource, 'GET /api/appDir/[name]')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/appDir/hello`)
              .catch(done)
          })

          it('should infer the correct resource path for appDir pages', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assert.strictEqual(spans[1].resource, 'GET /appDir/[name]')
                assert.strictEqual(spans[1].meta['http.status_code'], '200')
              })
              .then(done)
              .catch(done)

            axios.get(`http://127.0.0.1:${port}/appDir/hello`)
          })

          if (satisfies(pkg.version, '>=15.4.1')) {
            it('should trace an app route handler and its downstream request exactly once', () => {
              const tracePromise = agent.assertSomeTraces(traces => {
                const spans = traces[0]
                const requestSpans = spans.filter(span => span.name === 'next.request')
                const routeSpan = requestSpans.find(span => span.resource === 'GET /api/appRouteTrace/[name]')
                const httpSpan = spans.find(span => span.name === 'web.request')
                const downstreamSpan = spans.find(span => span.name === 'http.request' &&
                  span.meta['http.url'] === `http://127.0.0.1:${downstreamPort}/downstream`)

                assert.strictEqual(requestSpans.length, 1)
                assert.ok(routeSpan)
                assert.ok(httpSpan)
                assert.strictEqual(httpSpan.resource, 'GET /api/appRouteTrace/[name]')
                assert.strictEqual(httpSpan.meta['http.route'], '/api/appRouteTrace/[name]')
                assert.strictEqual(httpSpan.meta['http.endpoint'], '/api/appRouteTrace/{param:int}')
                assert.ok(downstreamSpan)
                assert.strictEqual(downstreamSpan.parent_id.toString(), routeSpan.span_id.toString())
              })

              return Promise.all([
                axios.get(`http://127.0.0.1:${port}/api/appRouteTrace/123`),
                tracePromise,
              ])
            })

            it('should trace a server-rendered app page and its downstream request exactly once', () => {
              const tracePromise = agent.assertSomeTraces(traces => {
                const spans = traces[0]
                const requestSpans = spans.filter(span => span.name === 'web.request')
                const nextRequestSpan = spans.find(span => span.name === 'next.request')
                const downstreamSpan = spans.find(span => span.name === 'http.request' &&
                  span.meta['http.url'] === `http://127.0.0.1:${downstreamPort}/app-page-downstream`)

                assert.strictEqual(spans.filter(span => span.parent_id === 0n).length, 1)
                assert.strictEqual(requestSpans.length, 1)
                assert.strictEqual(requestSpans[0].resource, 'GET /appPageTraceShape/[name]')
                assert.strictEqual(nextRequestSpan?.resource, 'GET /appPageTraceShape/[name]')
                assert.ok(downstreamSpan)
                assert.strictEqual(downstreamSpan.parent_id.toString(), nextRequestSpan.span_id.toString())
              })

              return Promise.all([
                axios.get(`http://127.0.0.1:${port}/appPageTraceShape/test`),
                tracePromise,
              ])
            })

            it('should attach a thrown app page error to the request span', done => {
              agent
                .assertSomeTraces(traces => {
                  const spans = traces[0]
                  const nextRequestSpan = spans.find(span => span.name === 'next.request')

                  assert.ok(nextRequestSpan, 'next.request span should exist')
                  assertObjectContains(nextRequestSpan, {
                    resource: 'GET /appDir/page-error',
                    error: 1,
                    meta: {
                      'http.status_code': '500',
                      'error.message': 'thrown app page error',
                      'error.type': 'Error',
                    },
                  })
                  assert.ok(nextRequestSpan.meta['error.stack'])
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://127.0.0.1:${port}/appDir/page-error`)
                .catch(error => {
                  if (error.response?.status !== 500) done(error)
                })
            })
          }
        })
      }

      describe('with configured HTTP server error statuses', () => {
        startServer({
          withConfig: false,
          standalone: false,
          httpServerErrorStatuses: '200',
        })

        it('should mark a configured status code as an error', async () => {
          await Promise.all([
            agent.assertSomeTraces(traces => {
              assertObjectContains(traces[0][1], {
                name: 'next.request',
                error: 1,
                meta: {
                  'http.status_code': '200',
                },
              })
            }),
            axios.get(`http://127.0.0.1:${port}/api/hello/world`),
          ])
        })
      })

      describe('with configuration', () => {
        startServer({ withConfig: true, standalone: false })

        it('should execute the hook and validate the status only once', done => {
          agent
            .assertSomeTraces(traces => {
              const spans = traces[0]

              assertObjectContains(spans[1], {
                name: 'next.request',
                service: 'test',
                type: 'web',
                resource: 'GET /api/hello/[name]',
                error: 1,
                meta: {
                  'span.kind': 'server',
                  'http.method': 'GET',
                  'http.status_code': '200',
                  foo: 'bar',
                  req: 'IncomingMessage',
                  component: 'next',
                  times_hook_called: '1',
                },
              })

              // assert request hook was only called once across the whole request
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://127.0.0.1:${port}/api/hello/world`)
            .catch(done)
        })

        // From next 15.4.1 the app-route handler builds its NextRequest from a copy of
        // `NextRequestAdapter.fromNodeNextRequest` that next bundles into the app build
        // (dist/build/templates/app-route.js), so the file hook that maps the node request to
        // the NextRequest never fires and a user-set `req.error` cannot reach the span. Capturing
        // it again needs the runtime `onRequestError` hook rather than file instrumentation.
        if (satisfies(pkg.version, '>=13.3.0 <15.4.1')) {
          it('should attach the error to the span from a NextRequest', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  error: 1,
                  meta: {
                    'error.message': 'error in app dir api route',
                    'error.type': 'Error',
                  },
                })

                assert.ok(spans[1].meta['error.stack'])
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/appDir/error`)
              .catch(err => {
                if (err.response.status !== 500) done(err)
              })
          })
        } else if (satisfies(pkg.version, '>=15.4.1')) {
          it('should attach a thrown app-route error to the span via onRequestError', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]

                assertObjectContains(spans[1], {
                  name: 'next.request',
                  error: 1,
                  meta: {
                    'error.message': 'thrown app dir error',
                    'error.type': 'Error',
                  },
                })

                assert.ok(spans[1].meta['error.stack'])
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://127.0.0.1:${port}/api/appDir/throw`)
              .catch(err => {
                if (err.response.status !== 500) done(err)
              })
          })
        }
      })

      // Issue with 13.4.13 - 13.4.18 causes process.env not to work properly in standalone mode
      // which affects how the tracer is passed down through NODE_OPTIONS, making tests fail
      // https://github.com/vercel/next.js/issues/53367
      // TODO investigate this further - traces appear in the UI for a small test app
      if (satisfiesStandalone(pkg.version) && !satisfies(pkg.version, '13.4.13 - 13.4.18')) {
        describe('with standalone', () => {
          startServer({ withConfig: false, standalone: true })

          // testing basic instrumentation between api, pages, static files since standalone still uses `next-server`
          const standaloneTests = [
            ['api', '/api/hello/world', 'GET /api/hello/[name]'],
            ['pages', '/hello/world', 'GET /hello/[name]'],
            ['static files', '/test.txt', 'GET /public/*'],
          ]

          standaloneTests.forEach(([test, resource, expectedResource]) => {
            it(`should do automatic instrumentation for ${test}`, () => {
              const promise = agent
                .assertSomeTraces(traces => {
                  const spans = traces[0]

                  assertObjectContains(spans[1], {
                    name: 'next.request',
                    service: 'test',
                    type: 'web',
                    resource: expectedResource,
                    meta: {
                      'span.kind': 'server',
                      'http.method': 'GET',
                      'http.status_code': '200',
                      component: 'next',
                    },
                  })
                })

              return Promise.all([axios.get(`http://127.0.0.1:${port}${resource}`), promise])
            }).timeout(5000)
            // increase timeout for longer test in CI
            // locally, do not see any slowdowns
          })
        })
      }

      describe('with a custom server that forwards raw req.url', () => {
        startServer({ withConfig: false, standalone: false, serverFile: 'server-raw' })

        const sendPath = path => new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
            res.on('data', () => {})
            res.on('end', resolve)
          })
          req.on('error', reject)
          req.end()
        })

        for (const path of ['http://[:::1]', '//[::1']) {
          it(`keeps serving requests after a request with path "${path}"`, async () => {
            await sendPath(path).catch(() => {})
            const response = await axios.get(`http://127.0.0.1:${port}/api/hello/world`)
            assert.strictEqual(response.status, 200)
          })
        }
      })

      describe('without HTTP instrumentation', () => {
        startServer({ withConfig: false, standalone: false, withHttp: false })

        it('should continue incoming distributed context', done => {
          agent
            .assertSomeTraces(traces => {
              const spans = traces[0]

              assert.strictEqual(spans.length, 1)
              assert.strictEqual(spans[0].name, 'next.request')
              assert.strictEqual(spans[0].trace_id.toString(), '1234')
              assert.strictEqual(spans[0].parent_id.toString(), '5678')
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://127.0.0.1:${port}/api/hello/world`, {
              headers: {
                'x-datadog-trace-id': '1234',
                'x-datadog-parent-id': '5678',
                'x-datadog-sampling-priority': '1',
              },
            })
            .catch(done)
        })
      })
    })
  })
})

describe('compiled Next runtimes', () => {
  it('bypasses all runtime wrappers without Next subscribers', () => {
    const getHook = getDisabledRuntimeHooks()
    const cases = [
      ['app-route', 'AppRouteRouteModule', 'handle', [{ headers: {}, method: 'GET' }, {}]],
      ['pages-api', 'PagesAPIRouteModule', 'render', [{ headers: {}, method: 'GET' }, { statusCode: 200 }, {}]],
      ['app-page', 'AppPageRouteModule', 'render', [{ headers: {}, method: 'GET' }, { statusCode: 200 }, {}]],
    ]

    for (const [runtime, exportName, method, args] of cases) {
      const returned = {}
      class RouteModule {
        [method] (...received) {
          assert.strictEqual(this, routeModule)
          assert.deepStrictEqual(received, args)
          return returned
        }
      }
      const routeModule = new RouteModule()

      const hook = getHook(runtime)
      hook({ [exportName]: RouteModule })

      assert.strictEqual(routeModule[method](...args), returned)
    }
  })

  describe('as the first tracing entrypoint', () => {
    before(async () => {
      await agent.load('next', { service: 'next-service' })
      dc.channel('dd-trace:instrumentation:load').publish({ name: 'next' })
    })
    after(() => agent.close())

    it('traces an App Route lifecycle with status and incoming context', async () => {
      class AppRouteRouteModule {
        definition = { pathname: '/api/first-entry' }

        handle () {
          return Promise.resolve({ status: 201 })
        }
      }
      const runtimeHook = getCompiledRuntimeHook('app-route')
      runtimeHook({ AppRouteRouteModule })

      const request = {
        headers: {
          'x-datadog-trace-id': '1234',
          'x-datadog-parent-id': '5678',
          'x-datadog-sampling-priority': '1',
        },
        method: 'GET',
        url: '/api/first-entry',
      }
      const lifecycle = []
      const onStart = () => lifecycle.push('start')
      const onPage = () => lifecycle.push('page')
      const onFinish = () => lifecycle.push('finish')
      dc.channel('apm:next:request:start').subscribe(onStart)
      dc.channel('apm:next:page:load').subscribe(onPage)
      dc.channel('apm:next:request:finish').subscribe(onFinish)
      const trace = agent.assertSomeTraces(traces => {
        const [span] = traces[0]
        assertObjectContains(span, {
          name: 'next.request',
          service: 'next-service',
          resource: 'GET /api/first-entry',
          meta: {
            '_dd.svc_src': 'opt.plugin',
            'http.status_code': '201',
            'next.page': '/api/first-entry',
          },
        })
        assert.strictEqual(span.trace_id.toString(), '1234')
        assert.strictEqual(span.parent_id.toString(), '5678')
      })

      assert.strictEqual(storage('legacy').getStore(), undefined)
      const response = await new AppRouteRouteModule().handle(request, {})
      assert.strictEqual(response.status, 201)
      await trace
      assert.deepStrictEqual(lifecycle, ['start', 'page', 'finish'])
      dc.channel('apm:next:request:start').unsubscribe(onStart)
      dc.channel('apm:next:page:load').unsubscribe(onPage)
      dc.channel('apm:next:request:finish').unsubscribe(onFinish)
    })

    it('records Pages API errors and status without an existing request store', async () => {
      class PagesAPIRouteModule {
        definition = { page: '/api/first-entry' }

        render (_req, res, context) {
          res.statusCode = 503
          context.onError(new Error('Pages API first-entry error'))
          return Promise.resolve()
        }
      }
      const runtimeHook = getCompiledRuntimeHook('pages-api')
      runtimeHook({ PagesAPIRouteModule })

      const response = { statusCode: 200 }
      const trace = agent.assertSomeTraces(traces => {
        const [span] = traces[0]
        assertObjectContains(span, {
          name: 'next.request',
          resource: 'GET /api/first-entry',
          error: 1,
          meta: {
            'http.status_code': '503',
            'error.message': 'Pages API first-entry error',
            'error.type': 'Error',
          },
        })
      })

      assert.strictEqual(storage('legacy').getStore(), undefined)
      await new PagesAPIRouteModule().render({ headers: {}, method: 'GET', url: '/api/first-entry' }, response, {
        page: '/api/first-entry',
      })
      await trace
    })

    it('records App Page errors and status without an existing request store', async () => {
      class AppPageRouteModule {
        definition = { pathname: '/first-entry' }

        render () {
          return Promise.reject(new Error('App Page first-entry error'))
        }
      }
      const runtimeHook = getCompiledRuntimeHook('app-page')
      runtimeHook({ AppPageRouteModule })

      const response = { statusCode: 200 }
      const trace = agent.assertSomeTraces(traces => {
        const [span] = traces[0]
        assertObjectContains(span, {
          name: 'next.request',
          resource: 'GET /first-entry',
          error: 1,
          meta: {
            'http.status_code': '500',
            'error.message': 'App Page first-entry error',
            'error.type': 'Error',
          },
        })
      })

      assert.strictEqual(storage('legacy').getStore(), undefined)
      await assert.rejects(
        new AppPageRouteModule().render({ headers: {}, method: 'GET', url: '/first-entry' }, response, {
          page: '/first-entry',
        }),
        /App Page first-entry error/
      )
      assert.strictEqual(response.statusCode, 500)
      await trace
    })
  })

  describe('with OTel semantics', () => {
    before(async () => {
      process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = 'true'
      await agent.load(['http', 'next'], [{ client: false }, undefined])
      dc.channel('dd-trace:instrumentation:load').publish({ name: 'next' })
    })

    after(() => {
      delete process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
      return agent.close()
    })

    it('captures Web NextRequest attributes through the App Route lifecycle', async () => {
      class AppRouteRouteModule {
        definition = { pathname: '/api/web-request' }

        handle (_request, _context) {
          return Promise.resolve({ status: 503 })
        }
      }
      const applyCompiledRuntimeHook = getCompiledRuntimeHook('app-route')
      applyCompiledRuntimeHook({ AppRouteRouteModule })

      const request = new Request('https://example.com/api/web-request?token=secret', {
        headers: { 'user-agent': 'test-agent/1.0' },
        method: 'PROPFIND',
      })
      const trace = agent.assertSomeTraces(traces => {
        const [span] = traces[0]
        assertObjectContains(span, {
          name: 'next.request',
          resource: 'HTTP /api/web-request',
          error: 1,
          meta: {
            'error.type': '503',
            'http.request.method': '_OTHER',
            'http.request.method_original': 'PROPFIND',
            'http.response.status_code': '503',
            'url.path': '/api/web-request',
            'url.scheme': 'https',
            'server.address': 'example.com',
            'user_agent.original': 'test-agent/1.0',
          },
        })
      })

      const response = await new AppRouteRouteModule().handle(request, {})
      assert.strictEqual(response.status, 503)
      await trace
    })

    it('updates the HTTP parent resource through the App Route lifecycle', async () => {
      class AppRouteRouteModule {
        definition = { pathname: '/api/web-request' }

        handle () {
          return Promise.resolve({ status: 201 })
        }
      }
      const instrumentAppRouteRuntime = getCompiledRuntimeHook('app-route')
      instrumentAppRouteRuntime({ AppRouteRouteModule })
      const routeModule = new AppRouteRouteModule()
      const server = http.createServer(async (req, res) => {
        try {
          const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method })
          const response = await routeModule.handle(request, {})
          res.statusCode = response.status
          res.end()
        } catch (error) {
          res.destroy(error)
        }
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const port = server.address().port
      const trace = agent.assertSomeTraces(traces => {
        const spans = traces.find(trace => trace.some(span => span.name === 'next.request'))
        assert.ok(spans)
        const nextSpan = spans.find(span => span.name === 'next.request')
        assert.ok(nextSpan)
        const parentSpan = spans.find(span => span.span_id.toString() === nextSpan.parent_id.toString())
        assert.ok(parentSpan)
        assert.strictEqual(parentSpan.resource, 'HTTP /api/web-request')
        assert.strictEqual(nextSpan.resource, 'HTTP /api/web-request')
      })

      try {
        const [response] = await Promise.all([
          axios({ method: 'PROPFIND', url: `http://127.0.0.1:${port}/api/web-request` }),
          trace,
        ])
        assert.strictEqual(response.status, 201)
      } finally {
        await new Promise(resolve => server.close(resolve))
      }
    })
  })
})
