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
              tracer.scopeManager().activate({})
              resolve()
            })
          })

          tracer.scopeManager().activate(span)

          return promise
            .then(() => {
              tracer.scopeManager().activate({})
            })
            .then(() => {
              const scope = tracer.scopeManager().active()

              expect(scope).to.not.be.null
              expect(scope.span()).to.equal(span)
            })
        })

        it('should run the catch() callback in context where catch() was called', () => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

          const span = {}
          const promise = new Promise((resolve, reject) => {
            setImmediate(() => {
              tracer.scopeManager().activate({})
              reject(new Error())
            })
          })

          tracer.scopeManager().activate(span)

          return promise
            .catch(err => {
              tracer.scopeManager().activate({})
              throw err
            })
            .catch(() => {
              const scope = tracer.scopeManager().active()

              expect(scope).to.not.be.null
              expect(scope.span()).to.equal(span)
            })
        })
      })
    })
  })
})
