'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/q')

wrapIt()

describe('Plugin', () => {
  let Q
  let tracer

  describe('q', () => {
    withVersions(plugin, 'q', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        return agent.close()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, 'q')
            .then(() => {
              Q = require(`../../versions/q@${version}`).get()
            })
        })

        it('should run the then() callback in context where then() was called', () => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

          const span = {}
          const deferred = Q.defer()
          const promise = deferred.promise

          setImmediate(() => {
            tracer.scope().activate({}, () => {
              deferred.resolve()
            })
          })

          return tracer.scope().activate(span, () => {
            return promise
              .then(() => {
                expect(tracer.scope().active()).to.equal(span)
              })
          })
        })

        it('should run the catch() callback in context where catch() was called', () => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

          const span = {}
          const deferred = Q.defer()
          const promise = deferred.promise

          setImmediate(() => {
            tracer.scope().activate({}, () => {
              deferred.reject(new Error())
            })
          })

          return tracer.scope().activate(span, () => {
            return promise
              .catch(() => {
                expect(tracer.scope().active()).to.equal(span)
              })
          })
        })
      })
    })
  })
})
