'use strict'

const assert = require('node:assert/strict')
/* eslint import/no-extraneous-dependencies: ["error", {"packageDir": ['./']}] */

const path = require('node:path')
const http = require('node:http')
const { execSync, spawn } = require('node:child_process')
const { mkdirSync, writeFileSync, readdirSync } = require('node:fs')
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

        if (satisfies(pkg.version, '>=13.3.0')) {
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
        }

        if (satisfies(pkg.version, '>=15.4.1')) {
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
      const returned = {
        handleResponse: {},
        prepare: {},
        route: {},
      }
      class RouteModule {
        prepare (...received) {
          assert.strictEqual(this, routeModule)
          assert.deepStrictEqual(received, args)
          return returned.prepare
        }

        handleResponse (...received) {
          assert.strictEqual(this, routeModule)
          assert.deepStrictEqual(received, args)
          return returned.handleResponse
        }

        [method] (...received) {
          assert.strictEqual(this, routeModule)
          assert.deepStrictEqual(received, args)
          return returned.route
        }
      }
      const routeModule = new RouteModule()

      const hook = getHook(runtime)
      hook({ [exportName]: RouteModule })

      if (runtime !== 'pages-api') {
        assert.strictEqual(routeModule.prepare(...args), returned.prepare)
        assert.strictEqual(routeModule.handleResponse(...args), returned.handleResponse)
      }
      assert.strictEqual(routeModule[method](...args), returned.route)
    }
  })

  it('bypasses the shared lifecycle when the last subscriber is removed after prepare', async () => {
    class RouteModule {
      prepare () {
        return Promise.resolve({})
      }

      /** @param {{responseGenerator: () => Promise<unknown>}} options */
      handleResponse ({ responseGenerator }) {
        return responseGenerator()
      }
    }

    class AppPageRouteModule extends RouteModule {}
    getCompiledRuntimeHook('app-page')({ AppPageRouteModule })

    const startChannel = dc.channel('apm:next:request:start')
    const onStart = () => {}
    startChannel.subscribe(onStart)
    const routeModule = new AppPageRouteModule()
    const request = { headers: {}, method: 'GET', url: '/disabled-after-prepare' }
    await routeModule.prepare(request, new http.ServerResponse(request), {})
    startChannel.unsubscribe(onStart)

    const result = await routeModule.handleResponse({
      req: request,
      responseGenerator: () => Promise.resolve('response'),
    })
    assert.strictEqual(result, 'response')
  })

  describe('as the first tracing entrypoint', () => {
    let tracer

    class RouteModule {
      prepare () {
        return Promise.resolve({})
      }

      /** @param {{responseGenerator: () => Promise<unknown>}} options */
      handleResponse ({ responseGenerator }) {
        return responseGenerator()
      }
    }

    before(async () => {
      tracer = await agent.load('next')
      dc.channel('dd-trace:instrumentation:load').publish({ name: 'next' })
    })
    after(() => agent.close())

    it('traces an App Route lifecycle with status and incoming context', async () => {
      class AppRouteRouteModule extends RouteModule {
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
          resource: 'GET /api/first-entry',
          meta: {
            'http.status_code': '201',
            'next.page': '/api/first-entry',
          },
        })
        assert.strictEqual(span.trace_id.toString(), '1234')
        assert.strictEqual(span.parent_id.toString(), '5678')
      })

      assert.strictEqual(storage('legacy').getStore(), undefined)
      const nodeResponse = new http.ServerResponse(request)
      const routeModule = new AppRouteRouteModule()
      const nextRequest = { headers: {}, method: 'GET', url: '/api/first-entry' }
      await routeModule.prepare(request, nodeResponse, {})
      const response = await routeModule.handleResponse({
        req: request,
        responseGenerator: async () => {
          const response = await routeModule.handle(nextRequest, {})
          return { value: { status: response.status } }
        },
      })
      assert.strictEqual(response.value.status, 201)
      nodeResponse.emit('finish')
      await trace
      assert.deepStrictEqual(lifecycle, ['start', 'page', 'finish'])
      dc.channel('apm:next:request:start').unsubscribe(onStart)
      dc.channel('apm:next:page:load').unsubscribe(onPage)
      dc.channel('apm:next:request:finish').unsubscribe(onFinish)
    })

    it('clears the App Route request association after a synchronous generator error', async () => {
      const nextRequest = {
        error: new Error('unrelated Next request error'),
        headers: {},
        method: 'GET',
        url: '/api/generator-error',
      }

      class AppRouteRouteModule extends RouteModule {
        definition = { pathname: '/api/generator-error' }

        handle () {
          return Promise.resolve({ status: 200 })
        }

        /** @param {{responseGenerator: () => Promise<unknown>}} options */
        async handleResponse ({ responseGenerator }) {
          assert.throws(responseGenerator, /synchronous generator error/)
          const response = await this.handle(nextRequest, {})
          return { value: { status: response.status } }
        }
      }
      getCompiledRuntimeHook('app-route')({ AppRouteRouteModule })

      const request = { headers: {}, method: 'GET', url: '/api/generator-error' }
      const response = new http.ServerResponse(request)
      const trace = agent.assertSomeTraces(traces => {
        const [span] = traces[0]
        assert.strictEqual(span.error, 0)
      })
      const routeModule = new AppRouteRouteModule()
      await routeModule.prepare(request, response, {})
      await routeModule.handleResponse({
        req: request,
        responseGenerator: () => { throw new Error('synchronous generator error') },
      })
      response.emit('finish')
      await trace
    })

    it('bypasses the shared lifecycle when prepare was not called', async () => {
      class AppPageRouteModule extends RouteModule {
        definition = { pathname: '/without-prepare' }
      }

      getCompiledRuntimeHook('app-page')({ AppPageRouteModule })

      let starts = 0
      const onStart = () => starts++
      dc.channel('apm:next:request:start').subscribe(onStart)
      const result = await new AppPageRouteModule().handleResponse({
        req: { headers: {}, method: 'GET', url: '/without-prepare' },
        responseGenerator: () => Promise.resolve('response'),
      })
      dc.channel('apm:next:request:start').unsubscribe(onStart)

      assert.strictEqual(result, 'response')
      assert.strictEqual(starts, 0)
    })

    const cachedRuntimeCases = [
      {
        exportName: 'AppRouteRouteModule',
        label: 'App Route',
        method: 'handle',
        pathname: '/api/cached',
        runtime: 'app-route',
      },
      {
        exportName: 'AppPageRouteModule',
        label: 'App Page',
        method: 'render',
        pathname: '/cached',
        runtime: 'app-page',
      },
    ]

    for (const { exportName, label, method, pathname, runtime } of cachedRuntimeCases) {
      it(`traces a cached ${label} response`, async () => {
        class CompiledRouteModule extends RouteModule {
          handleResponse () {
            return Promise.resolve({
              isMiss: false,
              isStale: false,
              value: { status: 202 },
            })
          }

          [method] () {
            assert.fail('a cache hit should not invoke the response generator')
          }

          definition = { pathname }
        }

        getCompiledRuntimeHook(runtime)({ [exportName]: CompiledRouteModule })

        const request = { headers: {}, method: 'GET', url: pathname }
        const response = new http.ServerResponse(request)
        const routeModule = new CompiledRouteModule()
        const parentResource = `cache-hit-${runtime}`
        /** @param {import('../../dd-trace/src/opentracing/span')[][]} traces */
        function assertNextRequestTrace (traces) {
          let httpParentSpan
          let nextRequestSpan
          let nextRequestSpanCount = 0

          for (const span of traces[0]) {
            if (span.name === parentResource) httpParentSpan = span
            if (span.name === 'next.request') {
              nextRequestSpan = span
              nextRequestSpanCount++
            }
          }

          assert.strictEqual(httpParentSpan.resource, `GET ${pathname}`)
          assert.strictEqual(httpParentSpan.meta['http.route'], pathname)
          assert.strictEqual(nextRequestSpanCount, 1)
          assert.strictEqual(nextRequestSpan.resource, `GET ${pathname}`)
          assert.strictEqual(nextRequestSpan.meta['http.status_code'], '202')
        }
        const tracePromise = agent.assertSomeTraces(assertNextRequestTrace, {
          rejectFirst: true,
          spanResourceMatch: new RegExp(pathname),
        })

        await Promise.all([
          tracer.trace(parentResource, { integrationName: 'http' }, async () => {
            await routeModule.prepare(request, response, {})
            const result = await routeModule.handleResponse({
              req: request,
              responseGenerator: () => assert.fail('a cache hit should not invoke the response generator'),
            })
            response.emit('finish')
            return result
          }),
          tracePromise,
        ])
      })

      it(`does not create a request span for stale ${label} background revalidation`, async () => {
        let responseGenerator

        class CompiledRouteModule extends RouteModule {
          /** @param {{responseGenerator: () => Promise<unknown>}} options */
          handleResponse (options) {
            responseGenerator = options.responseGenerator
            return Promise.resolve({ isMiss: false, isStale: true })
          }

          [method] () {
            return Promise.reject(new Error(`stale ${label} revalidation error`))
          }

          onRequestError () {
            return Promise.resolve()
          }

          definition = { pathname }
        }

        getCompiledRuntimeHook(runtime)({ [exportName]: CompiledRouteModule })

        const nodeRequest = { headers: {}, method: 'GET', url: pathname }
        const request = runtime === 'app-page' ? { ...nodeRequest, originalRequest: nodeRequest } : nodeRequest
        const response = new http.ServerResponse(nodeRequest)
        const routeModule = new CompiledRouteModule()
        const foregroundTrace = runtime === 'app-page'
          ? agent.assertSomeTraces(traces => {
            const [span] = traces[0]
            assert.strictEqual(span.error, 0)
            assert.strictEqual(span.meta['error.message'], undefined)
          }, { spanResourceMatch: new RegExp(pathname) })
          : undefined
        await routeModule.prepare(request, response, {})
        await routeModule.handleResponse({
          req: request,
          responseGenerator: async () => {
            try {
              return runtime === 'app-route'
                ? await routeModule[method]({ headers: {}, method: 'GET' }, {})
                : await routeModule[method](request, response, { page: pathname })
            } catch (error) {
              await routeModule.onRequestError(request, error)
              throw error
            }
          },
        })
        assert.strictEqual(typeof responseGenerator, 'function')

        /** @param {import('../../dd-trace/src/opentracing/span')[][]} traces */
        function assertNoNextRequestTrace (traces) {
          let nextRequestSpanCount = 0
          for (const span of traces[0]) {
            if (span.name === 'next.request') nextRequestSpanCount++
          }
          assert.strictEqual(nextRequestSpanCount, 0)
        }
        const parentResource = `stale-revalidation-${runtime}`
        const tracePromise = agent.assertSomeTraces(assertNoNextRequestTrace, {
          rejectFirst: true,
          spanResourceMatch: new RegExp(parentResource),
        })
        const revalidate = () => assert.rejects(
          () => responseGenerator({ hasResolved: true }),
          new RegExp(`stale ${label} revalidation error`)
        )

        await Promise.all([
          tracer.trace(parentResource, revalidate),
          tracePromise,
        ])
        response.emit('finish')
        if (runtime === 'app-page') {
          await foregroundTrace
        }
      })
    }

    it('records a foreground App Page error while stale revalidation is pending', async () => {
      let responseGenerator
      let continueRevalidation
      let reportForegroundError
      let foregroundErrorReported
      const foregroundError = new Error('foreground postponed render error')
      const backgroundError = new Error('stale revalidation error')
      const foregroundErrorTrigger = new Promise(resolve => { reportForegroundError = resolve })
      const revalidationContinuation = new Promise(resolve => { continueRevalidation = resolve })

      class AppPageRouteModule extends RouteModule {
        definition = { pathname: '/interleaved-error' }

        /** @param {{responseGenerator: () => Promise<unknown>}} options */
        handleResponse (options) {
          responseGenerator = options.responseGenerator
          foregroundErrorReported = foregroundErrorTrigger.then(() => this.onRequestError(options.req, foregroundError))
          return Promise.resolve({ isMiss: false, isStale: true })
        }

        onRequestError () {
          return Promise.resolve()
        }
      }
      getCompiledRuntimeHook('app-page')({ AppPageRouteModule })

      const nodeRequest = { headers: {}, method: 'GET', url: '/interleaved-error' }
      const request = { ...nodeRequest, originalRequest: nodeRequest }
      const response = new http.ServerResponse(nodeRequest)
      const routeModule = new AppPageRouteModule()
      const trace = agent.assertSomeTraces(traces => {
        const [span] = traces[0]
        assert.strictEqual(span.error, 1)
        assert.strictEqual(span.meta['error.message'], foregroundError.message)
      })

      await routeModule.prepare(request, response, {})
      await routeModule.handleResponse({
        req: request,
        responseGenerator: async () => {
          await revalidationContinuation
          await routeModule.onRequestError(request, backgroundError)
          throw backgroundError
        },
      })

      const revalidation = responseGenerator({ hasResolved: true })
      reportForegroundError()
      await foregroundErrorReported
      continueRevalidation()
      await assert.rejects(revalidation, backgroundError)
      response.emit('finish')
      await trace
    })

    for (const { cacheStatus, label, responseStatus } of [
      { cacheStatus: 307, label: 'RSC redirect', responseStatus: 200 },
      { cacheStatus: 200, label: 'segment-prefetch miss', responseStatus: 204 },
    ]) {
      it(`records the final App Page status for a cached ${label}`, async () => {
        class AppPageRouteModule extends RouteModule {
          definition = { pathname: '/cached-status' }

          handleResponse () {
            return Promise.resolve({ value: { status: cacheStatus } })
          }
        }
        getCompiledRuntimeHook('app-page')({ AppPageRouteModule })

        const request = { headers: {}, method: 'GET', url: '/cached-status' }
        const response = new http.ServerResponse(request)
        const routeModule = new AppPageRouteModule()
        const trace = agent.assertSomeTraces(traces => {
          const [span] = traces[0]
          assert.strictEqual(span.meta['http.status_code'], String(responseStatus))
        })

        await routeModule.prepare(request, response, {})
        await routeModule.handleResponse({
          req: request,
          responseGenerator: () => assert.fail('a cache hit should not invoke the response generator'),
        })
        response.statusCode = responseStatus
        response.emit('finish')
        await trace
      })
    }

    it('waits for App Page response handling after the response closes', async () => {
      let finishHandleResponse
      const handleResponseResult = new Promise(resolve => { finishHandleResponse = resolve })

      class AppPageRouteModule extends RouteModule {
        definition = { pathname: '/closed-response' }

        handleResponse () {
          return handleResponseResult
        }
      }
      getCompiledRuntimeHook('app-page')({ AppPageRouteModule })

      const request = { headers: {}, method: 'GET', url: '/closed-response' }
      const response = new http.ServerResponse(request)
      const routeModule = new AppPageRouteModule()
      const trace = agent.assertSomeTraces(traces => {
        const [span] = traces[0]
        assert.strictEqual(span.meta['http.status_code'], '503')
      })

      await routeModule.prepare(request, response, {})
      const result = routeModule.handleResponse({
        req: request,
        responseGenerator: () => assert.fail('a cache hit should not invoke the response generator'),
      })
      response.emit('close')
      finishHandleResponse({ value: { status: 503 } })
      await result
      await trace
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

    it('records App Page streaming errors after cache handling completes', async () => {
      class AppPageRouteModule extends RouteModule {
        definition = { pathname: '/first-entry' }

        render () {
          return Promise.resolve({ value: { status: 200 } })
        }

        onRequestError () {
          return Promise.resolve()
        }
      }
      const runtimeHook = getCompiledRuntimeHook('app-page')
      runtimeHook({ AppPageRouteModule })

      const request = { headers: {}, method: 'GET', url: '/first-entry' }
      const response = new http.ServerResponse(request)
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
      const routeModule = new AppPageRouteModule()
      await routeModule.prepare(request, response, {})
      let reportStreamingError
      const streamingErrorTrigger = new Promise(resolve => { reportStreamingError = resolve })
      let streamingError
      await routeModule.handleResponse({
        req: request,
        responseGenerator: () => {
          streamingError = streamingErrorTrigger.then(() => {
            return routeModule.onRequestError(request, new Error('App Page first-entry error'))
          })
          return routeModule.render(request, response, { page: '/first-entry' })
        },
      })
      reportStreamingError()
      await streamingError
      response.statusCode = 500
      response.emit('finish')
      await trace
    })

    it('passes final Node responses to hooks without propagating deferred hook errors', async () => {
      const hookResponses = []
      const hookCacheStatuses = []
      /**
       * @param {import('../../dd-trace/src/opentracing/span')} _span
       * @param {import('node:http').IncomingMessage} request
       * @param {import('node:http').ServerResponse} response
       */
      const requestHook = (_span, request, response) => {
        hookResponses.push(response)
        hookCacheStatuses.push(response.getHeader('x-nextjs-cache'))
        response.getHeader('content-type')
        if (request.url === '/app-page-hook-error') throw new Error('request hook error')
      }
      agent.reload('next', { hooks: { request: requestHook } })

      class AppRouteRouteModule extends RouteModule {
        definition = { pathname: '/api/response-hook' }

        handle () {
          return Promise.resolve({ status: 200 })
        }
      }

      class PagesAPIRouteModule {
        definition = { page: '/api/response-hook-sentinel' }

        render () {
          return Promise.resolve()
        }
      }

      class AppPageRouteModule extends RouteModule {
        definition = { pathname: '/app-page-hook-error' }

        handleResponse () {
          return Promise.reject(new Error('App Page handler error'))
        }
      }

      getCompiledRuntimeHook('app-route')({ AppRouteRouteModule })
      getCompiledRuntimeHook('pages-api')({ PagesAPIRouteModule })
      getCompiledRuntimeHook('app-page')({ AppPageRouteModule })

      const routeRequest = { headers: {}, method: 'GET', url: '/api/response-hook' }
      const routeResponse = new http.ServerResponse(routeRequest)
      const routeModule = new AppRouteRouteModule()
      await routeModule.prepare(routeRequest, routeResponse, {})
      await routeModule.handleResponse({
        req: routeRequest,
        responseGenerator: () => routeModule.handle({ headers: {}, method: 'GET' }, {}),
      })
      routeResponse.setHeader('x-nextjs-cache', 'HIT')
      routeResponse.emit('finish')

      const sentinelRequest = { headers: {}, method: 'GET', url: '/api/response-hook-sentinel' }
      const sentinelResponse = new http.ServerResponse(sentinelRequest)
      /** @param {import('../../dd-trace/src/opentracing/span')[][]} traces */
      function assertNextRequestTrace (traces) {
        let nextRequestSpan
        for (const span of traces[0]) {
          if (span.name === 'next.request') {
            nextRequestSpan = span
            break
          }
        }

        assert.ok(nextRequestSpan, 'next.request span should exist after the App Route hook')
      }
      const tracePromise = agent.assertSomeTraces(assertNextRequestTrace, {
        rejectFirst: true,
        spanResourceMatch: /response-hook-sentinel/,
      })

      await Promise.all([
        tracer.trace('response-hook-sentinel', () => {
          return new PagesAPIRouteModule().render(sentinelRequest, sentinelResponse, {
            page: '/api/response-hook-sentinel',
          })
        }),
        tracePromise,
      ])
      assert.deepStrictEqual(hookResponses, [routeResponse, sentinelResponse])
      assert.deepStrictEqual(hookCacheStatuses, ['HIT', undefined])

      const pageRequest = { headers: {}, method: 'GET', url: '/app-page-hook-error' }
      const pageResponse = new http.ServerResponse(pageRequest)
      const pageRouteModule = new AppPageRouteModule()
      await pageRouteModule.prepare(pageRequest, pageResponse, {})
      await assert.rejects(pageRouteModule.handleResponse({
        req: pageRequest,
        responseGenerator: () => assert.fail('a cache hit should not invoke the response generator'),
      }), /App Page handler error/)
      pageResponse.emit('finish')
    })
  })
})
