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

      beforeEach(() => {
        return agent.load(['mongodb-core'])
      })

      beforeEach(() => {
        id = require('../../dd-trace/src/id')
        tracer = require('../../dd-trace')

        collection = id().toString()

        mongoose = require(`../../../versions/mongoose@${version}`).get()
      })

      afterEach(() => {
        return mongoose.disconnect()
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      it('should propagate context with write operations', () => {
        const Cat = mongoose.model('Cat', { name: String })

        const span = {}
        const kitty = new Cat({ name: 'Zildjian' })

        connect()

        return tracer.scope().activate(span, () => {
          return kitty.save().then(() => {
            expect(tracer.scope().active()).to.equal(span)
          })
        })
      })

      it('should propagate context with queries', done => {
        const Cat = mongoose.model('Cat', { name: String })

        const span = {}

        connect()

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
        const Cat = mongoose.model('Cat', { name: String })

        const span = {}

        connect()

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

        const span = {}

        return tracer.scope().activate(span, () => {
          return promise.then(() => {
            expect(tracer.scope().active()).to.equal(span)
          })
        })
      })
    })
  })
})
