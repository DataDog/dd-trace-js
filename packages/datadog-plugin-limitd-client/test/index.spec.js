'use strict'

const { storage, SPAN_NAMESPACE } = require('../../datadog-core')
const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  let LimitdClient
  let limitd

  describe('limitd-client', () => {
    withVersions('limitd-client', 'limitd-client', version => {
      before(() => {
        return agent.load('limitd-client')
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(done => {
        LimitdClient = require(`../../../versions/limitd-client@${version}`).get()
        limitd = new LimitdClient('limitd://127.0.0.1:9231', () => done())
      })

      afterEach(() => {
        limitd.disconnect()
      })

      it('should propagate context', done => {
        const span = {}

        storage(SPAN_NAMESPACE).run(span, () => {
          limitd.take('user', 'test', function (err, resp) {
            if (err) return done(err)

            try {
              expect(storage(SPAN_NAMESPACE).getStore()).to.equal(span)
              done()
            } catch (e) {
              done(e)
            }
          })
        })
      })
    })
  })
})
