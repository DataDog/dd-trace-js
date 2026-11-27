'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { once } = require('node:events')
const { createRequire } = require('node:module')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')

describe('Plugin', () => {
  let tracer
  let restify
  let appListener

  describe('restify', () => {
    withVersions('restify', 'restify', version => {
      const pkgVersion = require(`../../../versions/restify@${version}`).version()

      // restify <4 fails to load (its `dtrace-provider` native dep has no prebuilt binding), and 7.x-9.x crash
      // on load on Node >=18 (they assign the now getter-only `IncomingMessage#closed`). Skip those; the
      // remaining majors (4-6, 10+) load and run against this suite.
      if (semver.intersects(pkgVersion, '<4.0.0') || semver.intersects(pkgVersion, '>=7.0.0 <10.0.0')) return

      beforeEach(() => {
        tracer = require('../../dd-trace')
        restify = require(`../../../versions/restify@${version}`).get()
      })

      afterEach(() => {
        appListener.close()
      })

      for (const order of [['restify', 'http'], ['http', 'restify']]) {
        describe('resource sampling with ' + order[0] + ' loaded first', () => {
          let regexResource
          let rootResource
          let rootThroughUseResource

          before(() => {
            const getConfig = require('../../dd-trace/src/config')
            const { DD_TRACE_OTEL_SEMANTICS_ENABLED: otel } = getConfig()
            regexResource = otel ? 'PATCH' : 'PATCH /widgets/'
            rootResource = otel && semver.gte(pkgVersion, '7.0.0') ? 'POST /' : 'POST'
            rootThroughUseResource = otel ? 'OPTIONS /' : 'OPTIONS'
            return agent.load([...order, 'find-my-way'], [{ client: false }, { client: false }, {}], {
              rateLimit: -1,
              sampleRate: 0,
              samplingRules: [
                { resource: 'GET /p', sampleRate: 1 },
                { resource: 'GET /items/:id', sampleRate: 1 },
                { resource: 'DELETE', sampleRate: 1 },
                { resource: 'DELETE /items/:id', sampleRate: 1 },
                { resource: 'PUT /', sampleRate: 1 },
                { resource: rootThroughUseResource, sampleRate: 1 },
                { resource: regexResource, sampleRate: 1 },
                { resource: 'PUT /widgets/', sampleRate: 1 },
                { resource: 'GET /x', sampleRate: 1 },
                { resource: 'POST', sampleRate: 1 },
                { resource: 'POST /', sampleRate: 1 },
              ],
            })
          })

          after(() => agent.close())

          /**
           * @param {'pre' | 'pre with method rule' | 'named preliminary' | 'routed' | 'routed terminal' |
           *   'preselected' | 'preselected through use' | 'preselected root' | 'preselected root through use' |
           *   'preselected wildcard' |
           *   'use' | 'handler' | 'root' | 'root terminal' | 'regex' |
           *   'regex terminal' | 'regex after pre' | 'regex handler after pre' | 'url' | 'reroute' | 'untraced'} stage
           * @param {'del' | 'get' | 'opts' | 'patch' | 'post' | 'put'} [method]
           */
          async function propagate (stage, method = 'get') {
            const app = restify.createServer()
            let priority
            const regex = stage.startsWith('regex')
            const preselectedWildcard = stage === 'preselected wildcard'
            const namedPreliminary = stage === 'named preliminary'
            const beforeLookup = stage === 'pre' || stage === 'pre with method rule' ||
              preselectedWildcard || namedPreliminary
            const preselectedRoot = stage.startsWith('preselected root')
            const throughUse = stage.endsWith(' through use')
            const preselected = stage.startsWith('preselected')
            const root = stage === 'root' || stage === 'root terminal' || preselectedRoot
            const requestMethod = method === 'opts' ? 'OPTIONS' : (method === 'del' ? 'DELETE' : method.toUpperCase())

            function inject () {
              const carrier = {}
              tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
              return carrier['x-datadog-sampling-priority']
            }

            if (stage.endsWith('after pre')) {
              app.pre((req, res, next) => next())
            }
            if (namedPreliminary) {
              app.get({ name: 'preliminary', path: '/p' }, (req, res, next) => {
                res.send(500)
                return next()
              })
              app.pre((req, res, next) => {
                app.router.lookupByName('preliminary', req, res)
                return next()
              })
            }
            if (preselected) {
              const fixture = require(`../../../versions/restify@${version}`)
              const fromRestify = createRequire(fixture.getPath('restify'))
              const FindMyWay = fromRestify('find-my-way')
              const preliminary = FindMyWay()
              let proceed
              const preselectedPath = throughUse ? '/items/:other' : '/items/:preselected'
              const route = root ? '/' : (preselectedWildcard ? '*' : preselectedPath)
              preliminary.on(requestMethod, route, () => proceed())
              app.pre((req, res, next) => {
                proceed = next
                return preliminary.lookup(req, res)
              })
            }
            if (beforeLookup || stage === 'use' || throughUse) {
              const sample = (req, res, next) => {
                priority = inject()
                return next()
              }
              app[beforeLookup ? 'pre' : 'use'](namedPreliminary ? [[sample]] : sample)
            }
            const terminal = stage.endsWith(' terminal') || (preselected && !throughUse && !preselectedWildcard)
            if (stage === 'routed' || stage === 'regex after pre' || terminal) {
              app.once('routed', (req, res) => {
                priority = inject()
                if (terminal) {
                  res.send({ priority })
                }
              })
            }
            if (stage === 'untraced') {
              app.once('routed', (req, res) => res.send({ routed: true }))
            }
            function reply (req, res, next) {
              if (!res.headersSent) {
                const atHandler = inject()
                const earlyDecision = beforeLookup || stage === 'regex after pre'
                res.send(earlyDecision ? { priority, atHandler } : { priority: priority ?? atHandler })
              }
              return next()
            }

            if (stage === 'reroute') {
              app.get('/items/:productIdentifier', (req, res, next) => next('shorter'))
              app.get({ path: '/x', name: 'shorter' }, reply)
            } else {
              const route = regex ? /widgets/ : { [stage === 'url' ? 'url' : 'path']: root ? '/' : '/items/:id' }
              app[method](route, reply)
            }

            appListener = app.listen(0, '127.0.0.1')
            await once(appListener, 'listening')
            const url = 'http://127.0.0.1:' + appListener.address().port
            const path = root ? '/' : (regex ? '/widgets' : '/items/42')
            const { data } = await httpRequest.request(url + path, {
              method: requestMethod,
            })
            return data
          }

          const stages = ['use', 'handler']
          if (semver.satisfies(pkgVersion, '>=5')) stages.push('routed', 'routed terminal')

          for (const stage of stages) {
            it('samples the matched resource from ' + stage, async () => {
              const [body] = await Promise.all([
                propagate(stage),
                agent.assertFirstTraceSpan({ resource: 'GET /items/:id', metrics: { _sampling_priority_v1: 2 } }),
              ])
              assert.deepStrictEqual(body, { priority: '2' })
            })
          }

          it('falls back before lookup and preserves that decision after lookup', async () => {
            const [body] = await Promise.all([
              propagate('pre'),
              agent.assertUserRejectedTrace('GET /items/:id'),
            ])
            assert.deepStrictEqual(body, { priority: '-1', atHandler: '-1' })
          })

          if (semver.gte(pkgVersion, '7.0.0')) {
            it('does not sample a route looked up by name from pre middleware', async () => {
              const [body] = await Promise.all([
                propagate('named preliminary'),
                agent.assertUserRejectedTrace('GET /items/:id'),
              ])
              assert.deepStrictEqual(body, { priority: '-1', atHandler: '-1' })
            })
          }

          const earlyCases = [
            ['pre with method rule', 'uses the existing fallback, not the selected route, before lookup'],
          ]
          if (semver.gte(pkgVersion, '10.0.0')) {
            earlyCases.push(['preselected wildcard', 'does not treat a preliminary wildcard as the selected route'])
          }
          for (const [stage, title] of earlyCases) {
            it(title, async () => {
              const resource = 'DELETE /items/:id'
              const usesMethodFallback = regexResource === 'PATCH' && stage === 'pre with method rule'
              const priority = usesMethodFallback ? '2' : '-1'
              const [body] = await Promise.all([
                propagate(stage, 'del'),
                usesMethodFallback
                  ? agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } })
                  : agent.assertUserRejectedTrace(resource),
              ])
              assert.deepStrictEqual(body, { priority, atHandler: priority })
            })
          }

          it('samples the root resource as it is exported', async () => {
            const [body] = await Promise.all([
              propagate('root', 'post'),
              agent.assertFirstTraceSpan({ resource: rootResource, metrics: { _sampling_priority_v1: 2 } }),
            ])
            assert.deepStrictEqual(body, { priority: '2' })
          })

          if (semver.gte(pkgVersion, '5.0.0')) {
            it('samples the root resource from a terminal routed listener', async () => {
              const [body] = await Promise.all([
                propagate('root terminal', 'post'),
                agent.assertFirstTraceSpan({ resource: 'POST', metrics: { _sampling_priority_v1: 2 } }),
              ])
              assert.deepStrictEqual(body, { priority: '2' })
            })
          }

          if (order[0] === 'restify' && semver.gte(pkgVersion, '10.0.0')) {
            it('preserves the root resource with Find My Way tracing disabled', async () => {
              tracer.use('find-my-way', { enabled: false })
              try {
                const [body] = await Promise.all([
                  propagate('root', 'post'),
                  agent.assertFirstTraceSpan({ resource: 'POST', metrics: { _sampling_priority_v1: 2 } }),
                ])
                assert.deepStrictEqual(body, { priority: '2' })
              } finally {
                tracer.use('find-my-way', { enabled: true })
              }
            })
          }

          if (semver.lt(pkgVersion, '7.0.0')) {
            const legacyStages = ['regex', 'url']
            if (semver.gte(pkgVersion, '5.0.0')) legacyStages.push('regex terminal')
            for (const stage of legacyStages) {
              it('samples the exported resource for a ' + stage + ' route', async () => {
                const resource = stage === 'url' ? 'POST' : regexResource
                const [body] = await Promise.all([
                  propagate(stage, stage === 'url' ? 'post' : 'patch'),
                  agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
                ])
                assert.deepStrictEqual(body, { priority: '2' })
              })
            }

            if (semver.gte(pkgVersion, '5.0.0')) {
              it('samples only a regex resource already known at routed', async () => {
                const otel = regexResource === 'PATCH'
                const [body] = await Promise.all([
                  propagate('regex after pre', 'put'),
                  otel
                    ? agent.assertUserRejectedTrace('PUT /widgets/')
                    : agent.assertFirstTraceSpan({ resource: 'PUT /widgets/', metrics: { _sampling_priority_v1: 2 } }),
                ])
                const priority = otel ? '-1' : '2'
                assert.deepStrictEqual(body, { priority, atHandler: priority })
              })
            }

            it('samples the rendered regex resource after middleware ran', async () => {
              const [body] = await Promise.all([
                propagate('regex handler after pre', 'put'),
                agent.assertFirstTraceSpan({ resource: 'PUT /widgets/', metrics: { _sampling_priority_v1: 2 } }),
              ])
              assert.deepStrictEqual(body, { priority: '2' })
            })

            it('does not sample a shorter named reroute that the span will not export', async () => {
              const [body] = await Promise.all([
                propagate('reroute'),
                agent.assertUserRejectedTrace('GET /items/:productIdentifier'),
              ])
              assert.deepStrictEqual(body, { priority: '-1' })
            })
          }

          if (semver.gte(pkgVersion, '10.0.0')) {
            for (const [stage, method, terminalResource] of [
              ['preselected', 'get', 'GET /items/:id'],
              ['preselected through use', 'get', 'GET /items/:id'],
              ['preselected root', 'put', 'PUT /'],
              ['preselected root through use', 'opts'],
            ]) {
              it(`samples the current route from a co-loaded router with ${stage}`, async () => {
                const resource = terminalResource ?? rootThroughUseResource
                const [body] = await Promise.all([
                  propagate(stage, method),
                  agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
                ])
                assert.deepStrictEqual(body, { priority: '2' })
              })
            }
          }

          if (order[0] === 'restify' && semver.gte(pkgVersion, '5.0.0')) {
            it('does not create a span when HTTP tracing is disabled', async () => {
              tracer.use('http', { enabled: false })
              try {
                const [body] = await Promise.all([
                  propagate('untraced'),
                  agent.assertNoTraces(() => assert.fail('Unexpected trace with HTTP disabled')),
                ])
                assert.deepStrictEqual(body, { routed: true })
              } finally {
                tracer.use('http', { client: false })
              }
            })
          }
        })
      }

      describe('without configuration', () => {
        before(() => agent.load(['restify', 'find-my-way', 'http'], [{}, {}, { client: false }]))

        after(() => agent.close())

        it('should do automatic instrumentation', done => {
          const server = restify.createServer()

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, 'restify.request')
                assert.strictEqual(traces[0][0].service, 'test')
                assert.strictEqual(traces[0][0].type, 'web')
                assert.strictEqual(traces[0][0].resource, 'GET')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
                assert.strictEqual(traces[0][0].meta['http.method'], 'GET')
                assert.strictEqual(traces[0][0].meta['http.status_code'], '404')
                assert.strictEqual(traces[0][0].meta.component, 'restify')
                assert.strictEqual(traces[0][0].meta['_dd.integration'], 'restify')
              })
              .then(done)
              .catch(done)

            httpRequest
              .get(`http://localhost:${port}/user`)
              .catch(() => {})
          })
        })

        it('should support routing', done => {
          const server = restify.createServer()

          server.get('/user/:id', (req, res, next) => {
            res.send(200)
            return next()
          })

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].resource, 'GET /user/:id')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user/123`)
                assert.strictEqual(traces[0][0].meta.component, 'restify')
              })
              .then(done)
              .catch(done)

            httpRequest
              .get(`http://localhost:${port}/user/123`)
              .catch(done)
          })
        })

        // restify added async route handler/middleware support in 7.x; older majors never await the
        // returned promise, so the request hangs. Only assert async routing where the feature exists.
        it('should support routing with async functions and middleware', function (done) {
          if (!semver.intersects(pkgVersion, '>=7')) return this.skip()

          const server = restify.createServer()

          server.get(
            '/user/:id',
            async function middleware () {},
            async function handler (req, res) {
              res.send('hello, ' + req.params.id)
            }
          )

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].resource, 'GET /user/:id')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user/123`)
                assert.strictEqual(traces[0][0].meta.component, 'restify')
              })
              .then(done)
              .catch(done)

            httpRequest
              .get(`http://localhost:${port}/user/123`)
              .catch(done)
          })
        })

        it('should route without producing any warnings', function (done) {
          if (!semver.intersects(pkgVersion, '>=7')) return this.skip()

          const warningSpy = sinon.spy((_, msg) => {
            // eslint-disable-next-line no-console
            console.error(`route called with warning: ${msg}`)
          })

          const server = restify.createServer({
            log: {
              trace: () => {},
              warn: warningSpy,
            },
          })

          server.get(
            '/user/:id',
            async function middleware () {},
            async function handler (req, res) {
              res.send('hello, ' + req.params.id)
            }
          )

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                sinon.assert.notCalled(warningSpy)
              })
              .then(done)
              .catch(done)

            httpRequest
              .get(`http://localhost:${port}/user/123`)
              .catch(done)
          })
        })

        it('should run handlers in the request scope', done => {
          const server = restify.createServer()
          const interval = setInterval(() => {
            if (next) {
              next()
              clearInterval(interval)
            }
          })

          let next

          server.pre((req, res, next) => {
            assert.notStrictEqual(tracer.scope().active(), null)
            next()
          })

          // break the async context
          server.use((req, res, _next) => {
            next = _next
          })

          server.use((req, res, next) => {
            assert.notStrictEqual(tracer.scope().active(), null)
            next()
          })

          server.get('/user', (req, res, next) => {
            assert.notStrictEqual(tracer.scope().active(), null)
            res.send(200)
            next()
            done()
          })

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            httpRequest
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should support array middleware', done => {
          const server = restify.createServer()

          server.get('/user/:id', [(req, res, next) => {
            res.send(200)
            return next()
          }])

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].resource, 'GET /user/:id')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user/123`)
                assert.strictEqual(traces[0][0].meta.component, 'restify')
              })
              .then(done)
              .catch(done)

            httpRequest
              .get(`http://localhost:${port}/user/123`)
              .catch(done)
          })
        })

        it('should keep user stores untouched', done => {
          const server = restify.createServer()
          const storage = new AsyncLocalStorage()
          const store = {}

          server.use((req, res, next) => {
            storage.run(store, () => next())
          })

          server.get('/user', (req, res, next) => {
            try {
              assert.strictEqual(storage.getStore(), store)
              res.end()
              done()
            } catch (e) {
              res.end()
              done(e)
            }
          })

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            httpRequest
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should allow handleUncaughtException', done => {
          const server = restify.createServer({
            handleUncaughtExceptions: true,
            log: {
              trace: function () {},
              warn: function () {},
            },
          })
          server.on('uncaughtException', function (req, res, route, err) {
            res.send(599)
          })

          server.get('/error', [(req, res, next) => {
            throw new Error('uncaught')
          }])

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].resource, 'GET /error')
                assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], 'uncaught')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/error`)
                assert.strictEqual(traces[0][0].meta['http.status_code'], '599')
                assert.strictEqual(traces[0][0].meta.component, 'restify')
              }, { timeoutMs: 12000 }) // restify <5 flushes the uncaught-exception span several seconds later
              .then(done)
              .catch(done)

            httpRequest
              .get(`http://localhost:${port}/error`, {
                validateStatus: status => status === 599,
              })
              .catch(done)
          })
        }).timeout(15000)
      })
    })
  })
})
