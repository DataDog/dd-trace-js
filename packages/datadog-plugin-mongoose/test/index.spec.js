'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let id
  let tracer
  let collection

  describe('mongoose', () => {
    withVersions(plugin, ['mongoose'], (version) => {
      let mongoose

      beforeEach(() => {
        id = require('../../dd-trace/src/id')
        tracer = require('../../dd-trace')

        collection = id().toString()

        mongoose = require(`../../../versions/mongoose@${version}`).get()
        mongoose.connect(`mongodb://localhost:27017/${collection}`, { useNewUrlParser: true, useUnifiedTopology: true })

        return agent.load(['mongoose', 'mongodb-core'])
      })

      afterEach(() => {
        return agent.close()
      })

      it('should propagate context with write operations', () => {
        const Cat = mongoose.model('Cat', { name: String })

        const span = {}
        const kitty = new Cat({ name: 'Zildjian' })

        return tracer.scope().activate(span, () => {
          return kitty.save().then(() => {
            expect(tracer.scope().active()).to.equal(span)
          })
        })
      })

      it('should propagate context with queries', () => {
        const Cat = mongoose.model('Cat', { name: String })

        const span = {}

        return tracer.scope().activate(span, () => {
          Cat.find({ name: 'Zildjian' }).exec(() => {
            expect(tracer.scope().active()).to.equal(span)
          })
        })
      })

      it('should propagate context with aggregations', () => {
        const Cat = mongoose.model('Cat', { name: String })

        const span = {}

        return tracer.scope().activate(span, () => {
          Cat.aggregate([{ $match: { name: 'Zildjian' } }]).then(() => {
            expect(tracer.scope().active()).to.equal(span)
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
