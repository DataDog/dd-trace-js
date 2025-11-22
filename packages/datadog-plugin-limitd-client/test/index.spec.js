'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { storage } = require('../../datadog-core')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

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

        storage('legacy').run(span, () => {
          limitd.take('user', 'test', function (err, resp) {
            if (err) return done(err)

            try {
              assert.strictEqual(storage('legacy').getStore(), span)
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
