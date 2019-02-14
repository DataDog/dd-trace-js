'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/bluebird')

wrapIt()

describe('Plugin', () => {
  let Promise
  let tracer

  describe('bluebird', () => {
    withVersions(plugin, 'bluebird', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        return agent.close()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, 'bluebird')
            .then(() => {
              Promise = require(`../../versions/bluebird@${version}`).get()
            })
        })

        it('should run the then() callback in context where then() was called', () => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

          const span = {}
          const promise = new Promise((resolve, reject) => {
            setImmediate(() => {
              tracer.scope().activate({}, () => {
                resolve()
              })
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
          const promise = new Promise((resolve, reject) => {
            setImmediate(() => {
              tracer.scope().activate({}, () => {
                reject(new Error())
              })
            })
          })

          return tracer.scope().activate(span, () => {
            return promise
              .catch(err => {
                throw err
              })
              .catch(() => {
                expect(tracer.scope().active()).to.equal(span)
              })
          })
        })

        it('should allow to run without a scope if not available when calling then()', () => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

          tracer.scope().activate(null, () => {
            const promise = new Promise((resolve, reject) => {
              setImmediate(() => {
                tracer.scope().activate({}, () => {
                  resolve()
                })
              })
            })

            return promise
              .then(() => {
                expect(tracer.scope().active()).to.be.null
              })
          })
        })
      })
    })
  })
})
