'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')

const axios = require('axios')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let tracer
  let Koa
  let appListener

  describe('koa', () => {
    withVersions('koa', 'koa', (version, _, realVersion) => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        Koa = require(`../../../versions/koa@${version}`).get()
      })

      afterEach(done => {
        appListener.close(() => done())
      })

      describe('without configuration', () => {
        before(() => agent.load(
          ['koa', 'http'],
          [{}, { client: false }],
          {
            // this is needed to test the client IP header configuration and must be done before loading the tracer
            // initially since we can't change the tracer config after it's loaded. Ideally, this clientIpHeader test
            // would be located within the http plugin tests, but due to the way the tracer is loaded during testing,
            // we can't do that since the tracer cannot be re-configured after it's loaded. So we added it here as the
            // first test in this describe block.
            clientIpEnabled: true,
            clientIpHeader: 'X-Custom-Client-Ip-Header', // config should be case-insensitive
          })
        )

        after(() => agent.close({ ritmReset: false }))

        it('should do automatic instrumentation on 2.x middleware', done => {
          const app = new Koa()

          app.use(function handle (ctx) {
            ctx.body = ''
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].name, 'koa.request')
                assert.strictEqual(spans[0].service, 'test')
                assert.strictEqual(spans[0].type, 'web')
                assert.strictEqual(spans[0].resource, 'GET')
                assert.strictEqual(spans[0].meta['span.kind'], 'server')
                assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user`)
                assert.strictEqual(spans[0].meta['http.method'], 'GET')
                assert.strictEqual(spans[0].meta['http.status_code'], '200')
                assert.strictEqual(spans[0].meta.component, 'koa')
                assert.strictEqual(spans[0].meta['_dd.integration'], 'koa')

                assert.strictEqual(spans[1].name, 'koa.middleware')
                assert.strictEqual(spans[1].service, 'test')
                assert.strictEqual(spans[1].resource, 'handle')
                assert.strictEqual(spans[1].meta.component, 'koa')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        if (semver.satisfies(realVersion, '<3')) {
          it('should do automatic instrumentation on 1.x middleware', done => {
            const app = new Koa()

            app.use(function * handle (next) {
              this.body = ''
              yield next
            })

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].name, 'koa.request')
                  assert.strictEqual(spans[0].service, 'test')
                  assert.strictEqual(spans[0].type, 'web')
                  assert.strictEqual(spans[0].resource, 'GET')
                  assert.strictEqual(spans[0].meta['span.kind'], 'server')
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user`)
                  assert.strictEqual(spans[0].meta['http.method'], 'GET')
                  assert.strictEqual(spans[0].meta['http.status_code'], '200')
                  assert.strictEqual(spans[0].meta.component, 'koa')

                  assert.strictEqual(spans[1].name, 'koa.middleware')
                  assert.strictEqual(spans[1].service, 'test')
                  assert.strictEqual(spans[1].resource, 'converted')
                  assert.strictEqual(spans[1].meta.component, 'koa')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        }

        it('should run middleware in the request scope', done => {
          const app = new Koa()

          app.use((ctx, next) => {
            ctx.body = ''

            assert.notStrictEqual(tracer.scope().active(), null)

            return next()
              .then(() => {
                assert.notStrictEqual(tracer.scope().active(), null)
                done()
              })
              .catch(done)
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/app/user/123`)
              .catch(done)
          })
        })

        it('should activate a scope per middleware', done => {
          const app = new Koa()

          let span

          app.use((ctx, next) => {
            span = tracer.scope().active()
            return tracer.scope().activate(null, () => next())
          })

          app.use(ctx => {
            ctx.body = ''

            try {
              const activeSpan = tracer.scope().active()
              assert.ok(activeSpan)
              assert.notStrictEqual(activeSpan, span)
              done()
            } catch (e) {
              done(e)
            }
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should finish middleware spans in the correct order', done => {
          const app = new Koa()

          let parentSpan
          let childSpan

          app.use((ctx, next) => {
            parentSpan = tracer.scope().active()

            sinon.spy(parentSpan, 'finish')

            setImmediate(() => {
              try {
                sinon.assert.called(childSpan.finish)
                sinon.assert.called(parentSpan.finish)
                assert.strictEqual(parentSpan.finish.calledAfter(childSpan.finish), true)
                assert.strictEqual(childSpan.context()._parentId.toString(10), parentSpan.context().toSpanId())
                assert.notStrictEqual(parentSpan.context()._parentId, null)
                done()
              } catch (e) {
                done(e)
              }
            })

            return next()
          })

          app.use((ctx, next) => {
            childSpan = tracer.scope().active()

            sinon.spy(childSpan, 'finish')

            ctx.body = ''

            setImmediate(() => {
              try {
                sinon.assert.called(childSpan.finish)
              } catch (e) {
                done(e)
              }
            })

            sinon.assert.notCalled(parentSpan.finish)

            return next()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should handle client IP header configuration', done => {
          const app = new Koa()

          app.use(async (ctx) => {
            ctx.body = ''
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])
                assert.strictEqual(spans[0].meta['http.client_ip'], '8.8.8.8')
              })
              .then(done)
              .catch(done)

            axios.get(`http://localhost:${port}/user`, {
              headers: {
                'x-custom-client-ip-header': '8.8.8.8',
              },
            }).catch(done)
          })
        })

        it('should not add client IP tag when header is missing or a different header is used', done => {
          const app = new Koa()

          app.use(async (ctx) => {
            ctx.body = ''
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])
                assert.ok(!('http.client_ip' in spans[0].meta))
              })
              .then(done)
              .catch(done)

            axios.get(`http://localhost:${port}/user`, {
              headers: {
                'x-other-custom-client-ip-header': '8.8.8.8',
              },
            }).catch(done)
          })
        })

        withVersions('koa', 'koa-route', routerVersion => {
          let koaRouter

          beforeEach(() => {
            koaRouter = require(`../../../versions/koa-route@${routerVersion}`).get()
          })

          it('should do automatic instrumentation on koa-route', done => {
            const app = new Koa()

            const getUser = (ctx, id) => {
              ctx.body = ''
            }

            app
              .use(koaRouter.get('/user/:id', getUser))

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].resource, 'GET /user/:id')
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user/123`)
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })
        })

        withVersions('koa', ['koa-router', '@koa/router'], (routerVersion, moduleName, realVersion) => {
          let Router

          if (moduleName === '@koa/router' &&
            semver.satisfies(realVersion, '>=15.0.0') &&
            !semver.satisfies(process.version.slice(1), '>=20.0.0')) {
            return
          }

          beforeEach(() => {
            Router = require(`../../../versions/${moduleName}@${routerVersion}`).get()
          })

          it('should do automatic instrumentation on routers', done => {
            const app = new Koa()
            const router = new Router()

            router.get('user', '/user/:id', function handle (ctx, next) {
              ctx.body = ''
            })

            app
              .use(router.routes())
              .use(router.allowedMethods())

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])
                  assert.strictEqual(spans[0].resource, 'GET /user/:id')
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user/123`)

                  assert.ok(Object.hasOwn(spans[1], 'resource'))
                  assert.match(spans[1].resource, /^(dispatch|bound)/)

                  assert.strictEqual(spans[2].resource, 'handle')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })

          it('should not lose the route if next() is called in middleware', done => {
            const app = new Koa()
            const router = new Router()

            router.get('/user/:id', (ctx, next) => {
              ctx.body = ''
              return next()
            })

            app
              .use(router.routes())
              .use(router.allowedMethods())

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].resource, 'GET /user/:id')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })

          it('should not lose the route if next() is called in a previous middleware', done => {
            const app = new Koa()
            const router = new Router()

            router.use((ctx, next) => next())
            router.get('/user/:id', (ctx, next) => {
              ctx.body = ''
            })

            app
              .use(router.routes())
              .use(router.allowedMethods())

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].resource, 'GET /user/:id')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })

          it('should not lose the route with multiple middleware', done => {
            const app = new Koa()
            const router = new Router()

            router.get('/user/:id', (ctx, next) => next(), (ctx, next) => {
              ctx.body = ''
            })

            app
              .use(router.routes())
              .use(router.allowedMethods())

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].resource, 'GET /user/:id')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })

          it('should not lose the route if next() is called in a previous router', done => {
            const app = new Koa()
            const router1 = new Router()
            const router2 = new Router()

            router2.use(async (ctx, next) => next())
            router2.get('/plop', (ctx) => {
              ctx.body = 'bar'
            })

            router1.use('/public', router2.routes())

            app.use(router1.routes())

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].resource, 'GET /public/plop')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/public/plop`)
                .catch(done)
            })
          })

          it('should support nested routers', done => {
            const app = new Koa()
            const forums = new Router()
            const discussions = new Router()
            const posts = new Router()

            posts.get('/posts/:pid', (ctx, next) => {
              ctx.body = ''
            })

            discussions.use('/discussions/:did', posts.routes(), posts.allowedMethods())

            forums.use('/forums/:fid', discussions.routes(), discussions.allowedMethods())

            app.use(forums.routes())

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].resource, 'GET /forums/:fid/discussions/:did/posts/:pid')
                  assert.ok('http.url' in spans[0].meta)
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/forums/123/discussions/456/posts/789`)
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/forums/123/discussions/456/posts/789`)
                .catch(done)
            })
          })

          if (semver.intersects(routerVersion, '8.0.3')) {
            it('should support reused routers', done => {
              const app = new Koa()
              const first = new Router()
              const second = new Router()
              const child = new Router()

              child.get('/child', (ctx, next) => {
                ctx.body = ''
              })

              first.use('/first', child.routes())
              second.use('/second', child.routes())

              app.use(first.routes())
              app.use(second.routes())

              appListener = app.listen(0, 'localhost', () => {
                const port = appListener.address().port

                agent
                  .assertSomeTraces(traces => {
                    const spans = sort(traces[0])

                    assert.strictEqual(spans[0].resource, 'GET /first/child')
                    assert.ok('http.url' in spans[0].meta)
                    assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/first/child`)
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/first/child`)
                  .catch(done)
              })
            })
          }

          it('should only match the current HTTP method', done => {
            const app = new Koa()
            const forums = new Router()
            const posts = new Router()

            posts.get('/:pid', (ctx, next) => {
              ctx.body = ''
            })
            posts.post('/:pid', (ctx, next) => {
              ctx.body = ''
            })

            forums.use('/forums/:fid/posts', posts.routes(), posts.allowedMethods())

            app.use(forums.routes())

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].resource, 'GET /forums/:fid/posts/:pid')
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/forums/123/posts/456`)
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/forums/123/posts/456`)
                .catch(done)
            })
          })

          it('should support a router prefix', done => {
            const app = new Koa()
            const router = new Router({
              prefix: '/user',
            })

            router.get('/:id', (ctx, next) => {
              ctx.body = ''
            })

            app
              .use(router.routes())
              .use(router.allowedMethods())

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].resource, 'GET /user/:id')
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user/123`)
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })

          it('should handle request errors', done => {
            const error = new Error('boom')
            const app = new Koa()
            const router = new Router({
              prefix: '/user',
            })

            router.get('/:id', (ctx, next) => {
              throw error
            })

            app.silent = true
            app
              .use(router.routes())
              .use(router.allowedMethods())

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].resource, 'GET /user/:id')
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user/123`)
                  assert.strictEqual(spans[0].error, 1)

                  assert.ok(Object.hasOwn(spans[1], 'resource'))
                  assert.match(spans[1].resource, /^(dispatch|bound)/)
                  assertObjectContains(spans[1].meta, {
                    [ERROR_TYPE]: error.name,
                    component: 'koa',
                  })
                  assert.strictEqual(spans[1].error, 1)
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(() => {})
            })
          })

          withVersions('koa', 'koa-websocket', wsVersion => {
            let WebSocket
            let websockify
            let ws

            beforeEach(() => {
              WebSocket = require('../../../versions/ws@6.1.0').get()
              websockify = require(`../../../versions/koa-websocket@${wsVersion}`).get()
            })

            afterEach(() => {
              ws && ws.close()
            })

            it('should skip instrumentation', done => {
              const app = websockify(new Koa())
              const router = new Router()

              router.all('/message', (ctx, next) => {
                ctx.websocket.send('pong')
                ctx.websocket.on('message', message => {})
              })

              app.ws
                .use(router.routes())
                .use(router.allowedMethods())

              appListener = app.listen(0, 'localhost', () => {
                const port = appListener.address().port

                ws = new WebSocket(`ws://localhost:${port}/message`)
                ws.on('error', done)
                ws.on('open', () => {
                  ws.send('ping', err => err && done(err))
                })
                ws.on('message', msg => {
                  if (msg === 'pong') {
                    done()
                  }
                })
              })
            })
          })
        })
      })

      describe('with configuration', () => {
        before(() => agent.load(['koa', 'http'], [{ middleware: false }, { client: false }]))

        after(() => agent.close({ ritmReset: false }))

        describe('middleware set to false', () => {
          it('should not do automatic instrumentation on 2.x middleware', done => {
            const app = new Koa()

            app.use(function handle (ctx) {
              ctx.body = ''
            })

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[0].name, 'koa.request')
                  assert.strictEqual(spans[0].service, 'test')
                  assert.strictEqual(spans[0].type, 'web')
                  assert.strictEqual(spans[0].resource, 'GET')
                  assert.strictEqual(spans[0].meta['span.kind'], 'server')
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user`)
                  assert.strictEqual(spans[0].meta['http.method'], 'GET')
                  assert.strictEqual(spans[0].meta['http.status_code'], '200')
                  assert.strictEqual(spans[0].meta.component, 'koa')

                  assert.strictEqual(spans.length, 1)
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          if (semver.satisfies(realVersion, '<3')) {
            it('should not do automatic instrumentation on 1.x middleware', done => {
              const app = new Koa()

              app.use(function * handle (next) {
                this.body = ''
                yield next
              })

              appListener = app.listen(0, 'localhost', () => {
                const port = appListener.address().port

                agent
                  .assertSomeTraces(traces => {
                    const spans = sort(traces[0])

                    assert.strictEqual(spans[0].name, 'koa.request')
                    assert.strictEqual(spans[0].service, 'test')
                    assert.strictEqual(spans[0].type, 'web')
                    assert.strictEqual(spans[0].resource, 'GET')
                    assert.strictEqual(spans[0].meta['span.kind'], 'server')
                    assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user`)
                    assert.strictEqual(spans[0].meta['http.method'], 'GET')
                    assert.strictEqual(spans[0].meta['http.status_code'], '200')
                    assert.strictEqual(spans[0].meta.component, 'koa')

                    assert.strictEqual(spans.length, 1)
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(done)
              })
            })
          }

          it('should run middleware in the request scope', done => {
            const app = new Koa()

            app.use((ctx, next) => {
              ctx.body = ''

              assert.notStrictEqual(tracer.scope().active(), null)

              return next()
                .then(() => {
                  assert.notStrictEqual(tracer.scope().active(), null)
                  done()
                })
                .catch(done)
            })

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              axios
                .get(`http://localhost:${port}/app/user/123`)
                .catch(done)
            })
          })

          it('should not activate a scope per middleware', done => {
            const app = new Koa()

            let span

            app.use((ctx, next) => {
              span = tracer.scope().active()
              return next()
            })

            app.use(ctx => {
              ctx.body = ''

              try {
                const activeSpan = tracer.scope().active()
                assert.ok(activeSpan)
                assert.strictEqual(activeSpan, span)
                done()
              } catch (e) {
                done(e)
              }
            })

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              axios.get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          it('should keep user stores untouched', done => {
            const app = new Koa()
            const storage = new AsyncLocalStorage()
            const store = {}

            app.use((ctx, next) => {
              return storage.run(store, () => next())
            })

            app.use(ctx => {
              ctx.body = ''

              try {
                assert.strictEqual(storage.getStore(), store)
                done()
              } catch (e) {
                done(e)
              }
            })

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              axios.get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          withVersions('koa', ['koa-router', '@koa/router'], (routerVersion, moduleName, realVersion) => {
            let Router
            if (moduleName === '@koa/router' &&
              semver.satisfies(realVersion, '>=15.0.0') &&
              !semver.satisfies(process.version.slice(1), '>=20.0.0')) {
              return
            }
            beforeEach(() => {
              Router = require(`../../../versions/${moduleName}@${routerVersion}`).get()
            })

            it('should handle request errors', done => {
              const error = new Error('boom')
              const app = new Koa()
              const router = new Router({
                prefix: '/user',
              })

              router.get('/:id', (ctx, next) => {
                throw error
              })

              app.silent = true
              app
                .use(router.routes())
                .use(router.allowedMethods())

              appListener = app.listen(0, 'localhost', () => {
                const port = appListener.address().port

                agent
                  .assertSomeTraces(traces => {
                    const spans = sort(traces[0])

                    assert.strictEqual(spans[0].resource, 'GET /user/:id')
                    assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user/123`)
                    assert.strictEqual(spans[0].error, 1)
                    assert.strictEqual(spans[0].meta.component, 'koa')
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/user/123`)
                  .catch(() => {})
              })
            })
          })
        })
      })
    })
  })
})
