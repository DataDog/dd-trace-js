'use strict'

const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  let id
  let tracer
  let collection

  describe('mongoose', () => {
    withVersions('mongoose', ['mongoose'], (version) => {
      let mongoose

      // This needs to be called synchronously right before each test to make
      // sure a connection is not already established and the request is added
      // to the queue.
      function connect () {
        mongoose.connect(`mongodb://localhost:27017/${collection}`, {
          useNewUrlParser: true,
          useUnifiedTopology: true
        })
      }

      before(() => {
        return agent.load(['mongodb-core'])
      })

      before(() => {
        id = require('../../dd-trace/src/id')
        tracer = require('../../dd-trace')

        collection = id().toString()

        mongoose = require(`../../../versions/mongoose@${version}`).get()

        connect()
      })

      after(() => {
        return mongoose.disconnect()
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      it('should propagate context with write operations', () => {
        const Cat = mongoose.model('Cat1', { name: String })

        const span = tracer.startSpan('parent')
        const kitty = new Cat({ name: 'Zildjian' })

        return tracer.scope().activate(span, () => {
          return kitty.save().then(() => {
            expect(tracer.scope().active()).to.equal(span)
          })
        })
      })

      it('should propagate context with queries', done => {
        const Cat = mongoose.model('Cat2', { name: String })

        const span = tracer.startSpan('parent')

        tracer.scope().activate(span, () => {
          Cat.find({ name: 'Zildjian' }).exec(() => {
            try {
              expect(tracer.scope().active()).to.equal(span)
              done()
            } catch (e) {
              done(e)
            }
          })
        })
      })

      it('should propagate context with aggregations', done => {
        const Cat = mongoose.model('Cat3', { name: String })

        const span = tracer.startSpan('parent')

        tracer.scope().activate(span, () => {
          Cat.aggregate([{ $match: { name: 'Zildjian' } }]).exec(() => {
            try {
              expect(tracer.scope().active()).to.equal(span)
              done()
            } catch (e) {
              done(e)
            }
          })
        })
      })

      it('should propagate context with promises', () => {
        if (!mongoose.Promise.ES6) return // native promises

        const promise = new mongoose.Promise.ES6((resolve) => {
          setImmediate(resolve)
        })

        const span = tracer.startSpan('parent')

        return tracer.scope().activate(span, () => {
          return promise.then(() => {
            expect(tracer.scope().active()).to.equal(span)
          })
        })
      })
    })
  })
})
