'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/when')

wrapIt()

describe('Plugin', () => {
  let when
  let tracer

  describe('when', () => {
    withVersions(plugin, 'when', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        return agent.close()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, 'when')
            .then(() => {
              when = require(`../../versions/when@${version}`).get()
            })
        })

        it('should run the then() callback in context where then() was called', () => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

          const span = {}
          const deferred = when.defer()
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
          const deferred = when.defer()
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

        it('should run the onProgress callback in context where then() was called', () => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

          const span = {}
          const deferred = when.defer()
          const promise = deferred.promise

          setImmediate(() => {
            tracer.scope().activate({}, () => {
              deferred.resolve()
            })
          })

          return tracer.scope().activate(span, () => {
            return promise
              .then(() => {}, () => {}, () => {
                expect(tracer.scope().active()).to.equal(span)
              })
          })
        })
      })
    })
  })
})
