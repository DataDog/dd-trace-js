'use strict'

const axios = require('axios')
const agent = require('../../dd-trace/test/plugins/agent')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

require('./setup/tap')

describe('Remove Span.kind Internal Spans', () => {
  let express
  let appListener

  describe('with express application ', () => {
    afterEach(() => {
      appListener && appListener.close()
      appListener = null
    })

    describe('without configuration', () => {
      before(() => {
        return agent.load(['express', 'http'])
      })

      before(() => {
        require('../../dd-trace').init({})
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        express = require('../../../versions/express').get()
      })

      it('should not skip the creation of any span.kind internal spans when the configuration is disabled', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        appListener = app.listen(0, 'localhost', () => {
          const port = appListener.address().port

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.property('length', 5)

              expect(spans[0]).to.have.property('name', 'express.request')
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('type', 'web')
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('component', 'express')
              expect(spans[0].meta).to.have.property('span.kind', 'server')

              for (let i = 1; i < 5; i++) {
                expect(spans[i]).to.have.property('name', 'express.middleware')
                expect(spans[i].meta).to.have.property('component', 'express')
                expect(spans[i].meta).to.not.have.property('span.kind')
              }
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://localhost:${port}/user`)
            .catch(done)
        })
      })
    })

    describe('with configuration', () => {
      before(() => {
        return agent.load(['express', 'http'], [{}, {}], { 'experimental.removeInternalSpans': true })
      })

      before(() => {
        require('../../dd-trace').init({ 'experimental.removeInternalSpans': true })
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        express = require('../../../versions/express').get()
      })

      it('should skip the creation of span.kind internal (middleware) spans when the config is enabled', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        appListener = app.listen(0, 'localhost', () => {
          const port = appListener.address().port

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.property('length', 1)

              expect(spans[0]).to.have.property('name', 'express.request')
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('type', 'web')
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('component', 'express')
              expect(spans[0].meta).to.have.property('span.kind', 'server')
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://localhost:${port}/user`)
            .catch(done)
        })
      })
    })
  })
})
