'use strict'

const axios = require('axios')
const getPort = require('get-port')
const agent = require('./agent')
const plugin = require('../../src/plugins/koa')

wrapIt()

describe('Plugin', () => {
  let tracer
  let Koa
  let appListener

  describe('express', () => {
    withVersions(plugin, 'koa', version => {
      let port

      beforeEach(() => {
        tracer = require('../..')
        Koa = require(`../../versions/koa@${version}`).get()
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

          app.use((ctx) => {
            ctx.body = ''
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'koa.request')
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'http')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
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

          app.use(function * (next) {
            this.body = ''
            yield next
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'koa.request')
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'http')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
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

        it('should reactivate the request span in middleware scopes', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const app = new Koa()

          let span

          app.use((ctx, next) => {
            span = tracer.scope().active()
            tracer.scope().activate({}, () => next())
          })

          app.use((ctx) => {
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

        withVersions(plugin, 'koa-router', routerVersion => {
          let Router

          beforeEach(() => {
            Router = require(`../../versions/koa-router@${routerVersion}`).get()
          })

          it('should do automatic instrumentation on routers', done => {
            const app = new Koa()
            const router = new Router()

            router.get('/user/:id', (ctx, next) => {
              ctx.body = ''
            })

            app
              .use(router.routes())
              .use(router.allowedMethods())

            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', 'GET /user/:id')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
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
                expect(traces[0][0]).to.have.property('resource', 'GET /user/:id')
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
                expect(traces[0][0]).to.have.property('resource', 'GET /forums/:fid/posts/:pid')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/forums/123/posts/456`)
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
                expect(traces[0][0]).to.have.property('resource', 'GET /forums/:fid/posts/:pid')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/forums/123/posts/456`)
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
                expect(traces[0][0]).to.have.property('resource', 'GET /user/:id')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })

          it('should handle errors', done => {
            const app = new Koa()
            const router = new Router({
              prefix: '/user'
            })

            router.get('/:id', (ctx, next) => {
              throw new Error()
            })

            app.silent = true
            app
              .use(router.routes())
              .use(router.allowedMethods())

            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', 'GET /user/:id')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
                expect(traces[0][0].error).to.equal(1)
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
              WebSocket = require(`../../versions/ws@6.1.0`).get()
              websockify = require(`../../versions/koa-websocket@${wsVersion}`).get()
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
    })
  })
})
