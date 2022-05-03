'use strict'

require('../../datadog-instrumentations/src/limitd-client')

const { storage } = require('../../datadog-core')

describe('Plugin', () => {
  let LimitdClient
  let limitd

  describe('limitd-client', () => {
    withVersions('limitd-client', 'limitd-client', version => {
      beforeEach(done => {
        LimitdClient = require(`../../../versions/limitd-client@${version}`).get()
        limitd = new LimitdClient('limitd://127.0.0.1:9231', done)
      })

      afterEach(() => {
        limitd.disconnect()
      })

      it('should propagate context', done => {
        const span = {}

        storage.run(span, () => {
          limitd.take('user', 'test', function (err, resp) {
            if (err) return done(err)

            expect(storage.getStore()).to.equal(span)

            done()
          })
        })
      })
    })
  })
})
