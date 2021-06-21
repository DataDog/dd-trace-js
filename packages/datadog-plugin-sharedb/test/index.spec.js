'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let ShareDB
  let tracer

  describe('sharedb', () => {
    withVersions(plugin, 'sharedb', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        let backend
        let connection

        before(() => {
          return agent.load('sharedb')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          ShareDB = require(`../../../versions/sharedb@${version}`).get()

          backend = new ShareDB({ presence: true });
          connection = backend.connect();
        })

        afterEach(() => {
          connection.close()
        })

        it('should do automatic instrumentation', done => {
          const doc = connection.get('some-collection', 'some-id');

          doc.fetch(function(err) {
            if (err) { throw err }

            agent.use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-sharedb')
              expect(traces[0][0]).to.have.property('resource', 'fetch some-collection')
              expect(traces[0][0]).to.have.property('type', 'sharedb.request')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('service', 'test')
              expect(traces[0][0].meta).to.have.property('resource.method', 'fetch')

              done()
            })
          });
        })
      })
    })
  })
})
