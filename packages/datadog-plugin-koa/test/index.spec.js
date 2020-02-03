'use strict'

const axios = require('axios')
const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let tracer
  let Koa
  let appListener

  describe('koa', () => {
    withVersions(plugin, 'koa', version => {
      let port

      beforeEach(() => {
        tracer = require('../../dd-trace')
        Koa = require(`../../../versions/koa@${version}`).get()
        return getPort().then(newPort => {
          port = newPort
        })
      })

      afterEach(done => {
        appListener.close(() => done())
      })

      describe('without configuration', () => {
        before(() => agent.load(plugin, 'koa'))
        after(() => agent.close())

        it('should do automatic instrumentation on 2.x middleware', done => {
          const app = new Koa()

          app.use(function handle (ctx) {
            ctx.body = ''
          })

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('name', 'koa.request')
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('type', 'web')
              expect(spans[0]).to.have.property('resource', 'GET')
              expect(spans[0].meta).to.have.property('span.kind', 'server')
              expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(spans[0].meta).to.have.property('http.method', 'GET')
              expect(spans[0].meta).to.have.property('http.status_code', '200')

              expect(spans[1]).to.have.property('name', 'koa.middleware')
              expect(spans[1]).to.have.property('service', 'test')
              expect(spans[1]).to.have.property('resource', 'handle')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should do automatic instrumentation on 1.x middleware', done => {
          const app = new Koa()

          app.use(function * handle (next) {
            this.body = ''
            yield next
          })

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('name', 'koa.request')
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('type', 'web')
              expect(spans[0]).to.have.property('resource', 'GET')
              expect(spans[0].meta).to.have.property('span.kind', 'server')
              expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(spans[0].meta).to.have.property('http.method', 'GET')
              expect(spans[0].meta).to.have.property('http.status_code', '200')

              expect(spans[1]).to.have.property('name', 'koa.middleware')
              expect(spans[1]).to.have.property('service', 'test')
              expect(spans[1]).to.have.property('resource', 'handle')
            })
            .then(done)
            .catch(done)

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should run middleware in the request scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const app = new Koa()

          app.use((ctx, next) => {
            ctx.body = ''

            expect(tracer.scope().active()).to.not.be.null

            return next()
              .then(() => {
                expect(tracer.scope().active()).to.not.be.null
                done()
              })
              .catch(done)
          })

          appListener = app.listen(port, 'localhost', () => {
            axios
              .get(`http://localhost:${port}/app/user/123`)
              .catch(done)
          })
        })

        it('should activate a scope per middleware', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const app = new Koa()

          let span

          app.use((ctx, next) => {
            span = tracer.scope().active()
            return tracer.scope().activate(null, () => next())
          })

          app.use(ctx => {
            ctx.body = ''

            try {
              expect(tracer.scope().active()).to.not.be.null.and.not.equal(span)
              done()
            } catch (e) {
              done(e)
            }
          })

          getPort().then(port => {
            appListener = app.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/user`)
                .catch(done)
            })
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
                expect(childSpan.finish).to.have.been.called
                expect(parentSpan.finish).to.have.been.called
                expect(parentSpan.finish).to.have.been.calledAfter(childSpan.finish)
                expect(childSpan.context()._parentId.toString(10)).to.equal(parentSpan.context().toSpanId())
                expect(parentSpan.context()._parentId).to.not.be.null
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
                expect(childSpan.finish).to.have.been.called
              } catch (e) {
                done(e)
              }
            })

            expect(parentSpan.finish).to.not.have.been.called

            return next()
          })

          getPort().then(port => {
            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/1`)
                .catch(done)
            })
          })
        })

        withVersions(plugin, 'koa-route', routerVersion => {
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

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', (e) => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })
        })

        withVersions(plugin, ['koa-router', '@koa/router'], (routerVersion, moduleName) => {
          let Router

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

            agent
              .use(traces => {
                const spans = sort(traces[0])
                expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)

                expect(spans[1]).to.have.property('resource')
                expect(spans[1].resource).to.match(/^dispatch/)

                expect(spans[2]).to.have.property('resource', 'handle')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', (e) => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })

          it('should not lose the route if next() is called', done => {
            const app = new Koa()
            const router = new Router()

            router.get('/user/:id', (ctx, next) => {
              ctx.body = ''
              return next()
            })

            app
              .use(router.routes())
              .use(router.allowedMethods())

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /user/:id')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', (e) => {
              axios
                .get(`http://localhost:${port}/user/123`)
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

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /forums/:fid/discussions/:did/posts/:pid')
                expect(spans[0].meta)
                  .to.have.property('http.url', `http://localhost:${port}/forums/123/discussions/456/posts/789`)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/forums/123/discussions/456/posts/789`)
                .catch(done)
            })
          })

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

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /forums/:fid/posts/:pid')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/forums/123/posts/456`)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/forums/123/posts/456`)
                .catch(done)
            })
          })

          it('should support a router prefix', done => {
            const app = new Koa()
            const router = new Router({
              prefix: '/user'
            })

            router.get('/:id', (ctx, next) => {
              ctx.body = ''
            })

            app
              .use(router.routes())
              .use(router.allowedMethods())

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })

          it('should handle request errors', done => {
            const error = new Error('boom')
            const app = new Koa()
            const router = new Router({
              prefix: '/user'
            })

            router.get('/:id', (ctx, next) => {
              throw error
            })

            app.silent = true
            app
              .use(router.routes())
              .use(router.allowedMethods())

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
                expect(spans[0].error).to.equal(1)

                expect(spans[1]).to.have.property('resource')
                expect(spans[1].resource).to.match(/^dispatch/)
                expect(spans[1].meta).to.include({
                  'error.type': error.name
                })
                expect(spans[0].error).to.equal(1)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(() => {})
            })
          })

          withVersions(plugin, 'koa-websocket', wsVersion => {
            let WebSocket
            let websockify
            let ws

            beforeEach(() => {
              WebSocket = require(`../../../versions/ws@6.1.0`).get()
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

              appListener = app.listen(port, 'localhost', () => {
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
        before(() => agent.load(plugin, 'koa', { middleware: false }))
        after(() => agent.close())

        describe('middleware set to false', () => {
          it('should not do automatic instrumentation on 2.x middleware', done => {
            const app = new Koa()

            app.use(function handle (ctx) {
              ctx.body = ''
            })

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('name', 'koa.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')

                expect(spans).to.have.length(1)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          it('should not do automatic instrumentation on 1.x middleware', done => {
            const app = new Koa()

            app.use(function * handle (next) {
              this.body = ''
              yield next
            })

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('name', 'koa.request')
                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')

                expect(spans).to.have.length(1)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          it('should run middleware in the request scope', done => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

            const app = new Koa()

            app.use((ctx, next) => {
              ctx.body = ''

              expect(tracer.scope().active()).to.not.be.null

              return next()
                .then(() => {
                  expect(tracer.scope().active()).to.not.be.null
                  done()
                })
                .catch(done)
            })

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/123`)
                .catch(done)
            })
          })

          it('should not activate a scope per middleware', done => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

            const app = new Koa()

            let span

            app.use((ctx, next) => {
              span = tracer.scope().active()
              return next()
            })

            app.use(ctx => {
              ctx.body = ''

              try {
                expect(tracer.scope().active()).to.equal(span)
                done()
              } catch (e) {
                done(e)
              }
            })

            getPort().then(port => {
              appListener = app.listen(port, 'localhost', () => {
                axios.get(`http://localhost:${port}/user`)
                  .catch(done)
              })
            })
          })

          withVersions(plugin, ['koa-router', '@koa/router'], (routerVersion, moduleName) => {
            let Router

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

              agent
                .use(traces => {
                  const spans = sort(traces[0])

                  expect(spans).to.have.length(1)
                  expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                  expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
                })
                .then(done)
                .catch(done)

              appListener = app.listen(port, 'localhost', (e) => {
                axios
                  .get(`http://localhost:${port}/user/123`)
                  .catch(done)
              })
            })

            it('should not lose the route if next() is called', done => {
              const app = new Koa()
              const router = new Router()

              router.get('/user/:id', (ctx, next) => {
                ctx.body = ''
                return next()
              })

              app
                .use(router.routes())
                .use(router.allowedMethods())

              agent
                .use(traces => {
                  const spans = sort(traces[0])

                  expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                })
                .then(done)
                .catch(done)

              appListener = app.listen(port, 'localhost', (e) => {
                axios
                  .get(`http://localhost:${port}/user/123`)
                  .catch(done)
              })
            })

            it('should support nested routers', done => {
              const app = new Koa()
              const forums = new Router()
              const posts = new Router()

              posts.get('/:pid', (ctx, next) => {
                ctx.body = ''
              })

              forums.use('/forums/:fid/posts', posts.routes(), posts.allowedMethods())

              app.use(forums.routes())

              agent
                .use(traces => {
                  const spans = sort(traces[0])

                  expect(spans[0]).to.have.property('resource', 'GET /forums/:fid/posts/:pid')
                  expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/forums/123/posts/456`)
                })
                .then(done)
                .catch(done)

              appListener = app.listen(port, 'localhost', () => {
                axios
                  .get(`http://localhost:${port}/forums/123/posts/456`)
                  .catch(done)
              })
            })

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

              agent
                .use(traces => {
                  const spans = sort(traces[0])

                  expect(spans[0]).to.have.property('resource', 'GET /forums/:fid/posts/:pid')
                  expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/forums/123/posts/456`)
                })
                .then(done)
                .catch(done)

              appListener = app.listen(port, 'localhost', () => {
                axios
                  .get(`http://localhost:${port}/forums/123/posts/456`)
                  .catch(done)
              })
            })

            it('should support a router prefix', done => {
              const app = new Koa()
              const router = new Router({
                prefix: '/user'
              })

              router.get('/:id', (ctx, next) => {
                ctx.body = ''
              })

              app
                .use(router.routes())
                .use(router.allowedMethods())

              agent
                .use(traces => {
                  const spans = sort(traces[0])

                  expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                  expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
                })
                .then(done)
                .catch(done)

              appListener = app.listen(port, 'localhost', () => {
                axios
                  .get(`http://localhost:${port}/user/123`)
                  .catch(done)
              })
            })

            it('should handle request errors', done => {
              const error = new Error('boom')
              const app = new Koa()
              const router = new Router({
                prefix: '/user'
              })

              router.get('/:id', (ctx, next) => {
                throw error
              })

              app.silent = true
              app
                .use(router.routes())
                .use(router.allowedMethods())

              agent
                .use(traces => {
                  const spans = sort(traces[0])

                  expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                  expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
                  expect(spans[0].error).to.equal(1)
                })
                .then(done)
                .catch(done)

              appListener = app.listen(port, 'localhost', () => {
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
