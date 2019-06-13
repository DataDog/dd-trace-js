'use strict'

module.exports = (name, factory) => {
  const agent = require('./agent')
  const plugin = require(`../../../datadog-plugin-${name}/src`)

  wrapIt()

  describe('Plugin', () => {
    let Promise
    let tracer

    describe(name, () => {
      withVersions(plugin, name, version => {
        beforeEach(() => {
          tracer = require('../..')
        })

        afterEach(() => {
          return agent.close()
        })

        describe('without configuration', () => {
          beforeEach(() => {
            return agent.load(plugin, name)
          })

          beforeEach(() => {
            const moduleExports = require(`../../../../versions/${name}@${version}`).get()

            Promise = factory ? factory(moduleExports) : moduleExports
          })

          it('should run the then() callbacks in the context where then() was called', () => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

            const span = {}

            let promise = new Promise((resolve, reject) => {
              setImmediate(() => {
                tracer.scope().activate({}, () => {
                  resolve()
                })
              })
            })

            return tracer.scope().activate(span, () => {
              for (let i = 0; i < promise.then.length; i++) {
                const args = new Array(i + 1)

                args[i] = () => {
                  expect(tracer.scope().active()).to.equal(span)
                }

                promise = promise.then.apply(promise, args)
              }

              return promise
            })
          })

          it('should run the catch() callback in the context where catch() was called', () => {
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
}
