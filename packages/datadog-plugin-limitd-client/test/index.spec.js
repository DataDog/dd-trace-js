'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

describe('Plugin', () => {
  let LimitdClient
  let limitd
  let tracer

  describe('limitd-client', () => {
    withVersions(plugin, 'limitd-client', version => {
      beforeEach(done => {
        agent.load('limitd-client')
          .then(() => {
            tracer = require('../../dd-trace')
            LimitdClient = require(`../../../versions/limitd-client@${version}`).get()
            limitd = new LimitdClient('limitd://127.0.0.1:9231', done)
          })
      })

      afterEach(() => {
        limitd.disconnect()
        return agent.close()
      })

      it('should propagate context', done => {
        const span = {}

        tracer.scope().activate(span, () => {
          limitd.take('user', 'test', function (err, resp) {
            if (err) return done(err)

            expect(tracer.scope().active()).to.equal(span)

            done()
          })
        })
      })
    })
  })
})
