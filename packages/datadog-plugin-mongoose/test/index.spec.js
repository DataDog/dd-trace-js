'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const semver = require('semver')

const { withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const id = require('../../dd-trace/src/id')

describe('Plugin', () => {
  let tracer
  let dbName

  describe('mongoose', () => {
    withVersions('mongoose', ['mongoose'], (version) => {
      let mongoose

      // This needs to be called synchronously right before each test to make
      // sure a connection is not already established and the request is added
      // to the queue.
      function connect () {
        // mongoose.connect('mongodb://username:password@host:port/database?options...');
        // actually the first part of the path is the dbName and not the collection
        return mongoose.connect(`mongodb://localhost:27017/${dbName}`, {
          bufferCommands: false,
          useNewUrlParser: true,
          useUnifiedTopology: true
        })
      }

      beforeEach(() => {
        return agent.load(['mongodb-core', 'mongoose'])
      })

      beforeEach(async () => {
        tracer = require('../../dd-trace')

        mongoose = require(`../../../versions/mongoose@${version}`).get()

        dbName = id().toString()

        await connect()
      })

      afterEach(async () => {
        return await mongoose.disconnect()
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      withPeerService(
        () => tracer,
        'mongodb-core',
        () => {
          const PeerCat = mongoose.model('PeerCat', { name: String })
          return new PeerCat({ name: 'PeerCat' }).save()
        },
        () => dbName,
        'peer.service')

      it('should propagate context with write operations', () => {
        const Cat = mongoose.model('Cat1', { name: String })

        const span = {}
        const kitty = new Cat({ name: 'Zildjian' })

        return tracer.scope().activate(span, () => {
          return kitty.save().then(() => {
            expect(tracer.scope().active()).to.equal(span)
          })
        })
      })

      if (!semver.intersects(version, '>=7')) {
        it('should propagate context with queries', done => {
          const Cat = mongoose.model('Cat2', { name: String })

          const span = {}

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

          const span = {}

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
      } else {
        it('should propagate context with queries', () => {
          const Cat = mongoose.model('Cat2', { name: String })

          const span = {}

          return tracer.scope().activate(span, () => {
            return Cat.find({ name: 'Zildjian' }).exec().then(() => {
              expect(tracer.scope().active()).to.equal(span)
            })
          })
        })

        it('should propagate context with aggregations', () => {
          const Cat = mongoose.model('Cat3', { name: String })

          const span = {}

          return tracer.scope().activate(span, () => {
            return Cat.aggregate([{ $match: { name: 'Zildjian' } }]).exec().then(() => {
              expect(tracer.scope().active()).to.equal(span)
            })
          })
        })
      }
    })
  })
})
