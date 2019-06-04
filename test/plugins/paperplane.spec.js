'use strict'

const axios = require('axios')
const getPort = require('get-port')
const http = require('http')

const agent = require('./agent')
const plugin = require('../../src/plugins/paperplane')

wrapIt()

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let paperplane
  let server
  let tracer

  describe('paperplane', () => {
    withVersions(plugin, 'paperplane', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        server.close()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load(plugin, 'paperplane')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          paperplane = require(`../../versions/paperplane@${version}`).get()
        })

        it('should do automatic instrumentation on app routes', done => {
          const { methods, mount, routes, send } = paperplane

          const app = routes({
            '/user': methods({
              GET: () => send()
            })
          })

          server = http.createServer(mount({ app }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })
      })
    })
  })
})
