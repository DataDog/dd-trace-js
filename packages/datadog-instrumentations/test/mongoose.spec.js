'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { channel } = require('../src/helpers/instrument')
const semver = require('semver')

const startCh = channel('datadog:mongoose:model:filter:start')
const finishCh = channel('datadog:mongoose:model:filter:finish')

const sanitizeFilterFinishCh = channel('datadog:mongoose:sanitize-filter:finish')
describe('mongoose instrumentations', () => {
  // hack to be able to exclude cb test executions in >=7
  const iterationRanges = ['>4.0.0 <=6', '>=7']
  iterationRanges.forEach(range => {
    describe(range, () => {
      withVersions('mongoose', ['mongoose'], range, (version) => {
        // withVersions('mongoose', ['mongoose'], '>=6.0.0 <7', (version) => {
        let Test, dbName, id, mongoose

        function connect () {
          mongoose.connect(`mongodb://localhost:27017/${dbName}`, {
            useNewUrlParser: true,
            useUnifiedTopology: true
          })
        }

        before(() => {
          return agent.load(['mongoose'])
        })

        before(() => {
          id = require('../../dd-trace/src/id')
          dbName = id().toString()

          mongoose = require(`../../../versions/mongoose@${version}`).get()

          connect()

          Test = mongoose.model('Test', { name: String, type: String, other: String })
        })

        beforeEach((done) => {
          Test.insertMany([
            {
              name: 'test1',
              other: 'other1',
              type: 'test'
            },
            {
              name: 'test2',
              other: 'other2',
              type: 'test'
            },
            {
              name: 'test3',
              other: 'other3',
              type: 'test'
            }]).then(() => done())
        })

        afterEach((done) => {
          const deleteFilter = {
            type: 'test'
          }
          if (typeof Test.deleteMany === 'function') {
            Test.deleteMany(deleteFilter).then(() => done())
          } else {
            Test.remove(deleteFilter).then(() => done())
          }
        })

        after(() => {
          return mongoose.disconnect()
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        function testCallbacksCalled (methodName, filters, ...args) {
          if (range !== '>=7') {
            it('channel events published with cb', (done) => {
              const start = sinon.stub()
              const finish = sinon.stub()
              startCh.subscribe(start)
              finishCh.subscribe(finish)

              Test[methodName](...filters, ...args, () => {
                startCh.unsubscribe(start)
                finishCh.unsubscribe(finish)

                expect(start).to.have.been.calledOnceWith({ filters, methodName })
                expect(finish).to.have.been.calledOnce

                done()
              })
            })
          }

          it('channel events published with then', (done) => {
            const start = sinon.stub()
            const finish = sinon.stub()
            startCh.subscribe(start)
            finishCh.subscribe(finish)

            Test[methodName](...filters, ...args).then(()=> {
              startCh.unsubscribe(start)
              finishCh.unsubscribe(finish)

              expect(start).to.have.been.calledOnceWith({ filters, methodName })
              expect(finish).to.have.been.calledOnce

              done()
            })
          })
        }

        describe('Model methods', () => {
          describe('count', () => {
            if (range !== '>=7') {
              it('continue working as expected with cb', (done) => {
                Test.count({ type: 'test' }, (err, res) => {
                  expect(err).to.be.null
                  expect(res).to.be.equal(3)

                  done()
                })
              })
            }

            it('continue working as expected with promise', (done) => {
              Test.count({ type: 'test' }).then((res) => {
                expect(res).to.be.equal(3)

                done()
              })
            })

            testCallbacksCalled('count', [{ type: 'test' }])
          })

          if (semver.intersects(version, '>=6')) {
            describe('countDocuments', () => {
              if (range !== '>=7') {
                it('continue working as expected with cb', (done) => {
                  Test.countDocuments({ type: 'test' }, (err, res) => {
                    expect(err).to.be.null
                    expect(res).to.be.equal(3)

                    done()
                  })
                })
              }

              it('continue working as expected with then', (done) => {
                Test.countDocuments({ type: 'test' }).then((res) => {
                  expect(res).to.be.equal(3)

                  done()
                })
              })

              testCallbacksCalled('countDocuments', [{ type: 'test' }])
            })
          }

          if (semver.intersects(version, '>=5')) {
            describe('deleteOne', () => {
              if (range !== '>=7') {
                it('continue working as expected with cb', (done) => {
                  Test.deleteOne({ type: 'test' }, (err) => {
                    expect(err).to.be.null

                    Test.count({ type: 'test' }, (err, res) => {
                      expect(res).to.be.equal(2) // 3 -> delete 1 -> 2

                      done()
                    })
                  })
                })
              }

              it('continue working as expected with then', (done) => {
                Test.deleteOne({ type: 'test' }).then(() => {
                  Test.count({ type: 'test' }).then((res) => {
                    expect(res).to.be.equal(2) // 3 -> delete 1 -> 2

                    done()
                  })
                })
              })

              testCallbacksCalled('deleteOne', [{ type: 'test' }])
            })
          }

          describe('find', () => {
            if (range !== '>=7') {
              it('continue working as expected with cb', (done) => {
                Test.find({ type: 'test' }, (err, items) => {
                  expect(err).to.be.null
                  expect(items.length).to.be.equal(3)

                  done()
                })
              })
            }

            it('continue working as expected with then', (done) => {
              Test.find({ type: 'test' }).then((items) => {
                expect(items.length).to.be.equal(3)

                done()
              })
            })

            testCallbacksCalled('find', [{ type: 'test' }])
          })

          describe('findOne', () => {
            if (range !== '>=7') {
              it('continue working as expected with cb', (done) => {
                Test.findOne({ type: 'test' }, (err, item) => {
                  expect(err).to.be.null
                  expect(item).not.to.be.null
                  expect(item.name).to.be.equal('test1')

                  done()
                })
              })
            }

            it('continue working as expected with then', (done) => {
              Test.findOne({ type: 'test' }).then((item) => {
                expect(item).not.to.be.null
                expect(item.name).to.be.equal('test1')

                done()
              })
            })

            testCallbacksCalled('findOne', [{ type: 'test' }])
          })

          if (semver.intersects(version, '>=6')) {
            describe('findOneAndDelete', () => {
              if (range !== '>=7') {
                it('continue working as expected with cb', (done) => {
                  Test.findOneAndDelete({ type: 'test' }, (err, item) => {
                    expect(err).to.be.null
                    expect(item).not.to.be.null
                    expect(item.name).to.be.equal('test1')

                    Test.count({ type: 'test' }, (err, res) => {
                      expect(res).to.be.equal(2) // 3 -> delete 1 -> 2

                      done()
                    })
                  })
                })
              }

              it('continue working as expected with then', (done) => {
                Test.findOneAndDelete({ type: 'test' }).then((item) => {
                  expect(item).not.to.be.null
                  expect(item.name).to.be.equal('test1')

                  Test.count({ type: 'test' }).then((res) => {
                    expect(res).to.be.equal(2) // 3 -> delete 1 -> 2

                    done()
                  })
                })
              })

              testCallbacksCalled('findOneAndDelete', [{ type: 'test' }])
            })
          }

          if (semver.intersects(version, '>=6')) {
            describe('findOneAndReplace', () => {
              if (range !== '>=7') {
                it('continue working as expected with cb', (done) => {
                  Test.findOneAndReplace({ name: 'test1' }, {
                    name: 'test1-modified',
                    type: 'test'
                  }, (err) => {
                    expect(err).to.be.null

                    Test.find({ name: 'test1-modified' }, (err, item) => {
                      expect(err).to.be.null
                      expect(item).not.to.be.null

                      done()
                    })
                  })
                })
              }

              it('continue working as expected with then', (done) => {
                Test.findOneAndReplace({ name: 'test1' }, {
                  name: 'test1-modified',
                  type: 'test'
                }).then(() => {
                  Test.find({ name: 'test1-modified' }).then((item) => {
                    expect(item).not.to.be.null

                    done()
                  })
                })
              })

              testCallbacksCalled('findOneAndDelete', [{ type: 'test' }], {
                name: 'test1-modified',
                type: 'test'
              })
            })
          }

          if (semver.intersects(version, '>=5')) {
            describe('replaceOne', () => {
              if (range !== '>=7') {
                it('continue working as expected with cb', (done) => {
                  Test.replaceOne({ name: 'test1' }, {
                    name: 'test1-modified',
                    type: 'test'
                  }, (err) => {
                    expect(err).to.be.null

                    Test.find({ name: 'test1-modified' }, (err, item) => {
                      expect(err).to.be.null
                      expect(item).not.to.be.null

                      done()
                    })
                  })
                })
              }

              it('continue working as expected with then', (done) => {
                Test.replaceOne({ name: 'test1' }, {
                  name: 'test1-modified',
                  type: 'test'
                }).then(() => {
                  Test.find({ name: 'test1-modified' }).then((item) => {
                    expect(item).not.to.be.null

                    done()
                  })
                })
              })

              testCallbacksCalled('replaceOne', [{ type: 'test' }], {
                name: 'test1-modified',
                type: 'test'
              })
            })
          }

          describe('findOneAndUpdate', () => {
            if (range !== '>=7') {
              it('continue working as expected with cb', (done) => {
                Test.findOneAndUpdate({ name: 'test1' }, { '$set': { name: 'test1-modified' } }, (err) => {
                  expect(err).to.be.null

                  Test.findOne({ name: 'test1-modified' }, (err, item) => {
                    expect(err).to.be.null
                    expect(item).not.to.be.null

                    done()
                  })
                })
              })
            }

            it('continue working as expected with then', (done) => {
              Test.findOneAndUpdate({ name: 'test1' }, { '$set': { name: 'test1-modified' } }).then((res) => {
                Test.findOne({ name: 'test1-modified' }).then((item) => {
                  expect(item).not.to.be.null

                  done()
                })
              })
            })

            testCallbacksCalled('findOneAndUpdate', [{ type: 'test' }, { '$set': { name: 'test1-modified' } }])
          })

          if (semver.intersects(version, '>=5')) {
            describe('updateMany', () => {
              if (range !== '>=7') {
                it('continue working as expected with cb', (done) => {
                  Test.updateMany({ type: 'test' }, {
                    '$set': {
                      other: 'modified-other'
                    }
                  }, (err) => {
                    expect(err).to.be.null

                    Test.find({ type: 'test' }, (err, items) => {
                      expect(err).to.be.null
                      expect(items.length).to.be.equal(3)

                      items.forEach(item => {
                        expect(item.other).to.be.equal('modified-other')
                      })

                      done()
                    })
                  })
                })
              }

              it('continue working as expected with then', (done) => {
                Test.updateMany({ type: 'test' }, {
                  '$set': {
                    other: 'modified-other'
                  }
                }).then((err) => {
                  Test.find({ type: 'test' }).then((items) => {
                    expect(items.length).to.be.equal(3)

                    items.forEach(item => {
                      expect(item.other).to.be.equal('modified-other')
                    })

                    done()
                  })
                })
              })

              testCallbacksCalled('updateMany', [{ type: 'test' }, { '$set': { other: 'modified-other' } }])
            })
          }

          if (semver.intersects(version, '>=5')) {
            describe('updateOne', () => {
              if (range !== '>=7') {
                it('continue working as expected with cb', (done) => {
                  Test.updateOne({ name: 'test1' }, {
                    '$set': {
                      other: 'modified-other'
                    }
                  }, (err) => {
                    expect(err).to.be.null

                    Test.findOne({ name: 'test1' }, (err, item) => {
                      expect(err).to.be.null
                      expect(item.other).to.be.equal('modified-other')

                      done()
                    })
                  })
                })
              }

              it('continue working as expected with then', (done) => {
                Test.updateOne({ name: 'test1' }, {
                  '$set': {
                    other: 'modified-other'
                  }
                }).then(() => {
                  Test.findOne({ name: 'test1' }).then((item) => {
                    expect(item.other).to.be.equal('modified-other')

                    done()
                  })
                })
              })

              testCallbacksCalled('updateOne', [{ name: 'test1' }, { '$set': { other: 'modified-other' } }])
            })
          }
        })
        if (semver.intersects(version, '>=6')) {
          describe('sanitizeFilter', () => {
            it('continues working as expected without sanitization', () => {
              const source = { 'username': 'test' }
              const expected = { 'username': 'test' }

              const sanitizedObject = mongoose.sanitizeFilter(source)

              expect(sanitizedObject).to.be.deep.equal(expected)
            })

            it('continues working as expected without sanitization', () => {
              const source = { 'username': { '$ne': 'test' } }
              const expected = { 'username': { '$eq': { '$ne': 'test' } } }

              const sanitizedObject = mongoose.sanitizeFilter(source)

              expect(sanitizedObject).to.be.deep.equal(expected)
            })

            it('channel is published with the result object', () => {
              const source = { 'username': { '$ne': 'test' } }

              const listener = sinon.stub()
              sanitizeFilterFinishCh.subscribe(listener)
              const sanitizedObject = mongoose.sanitizeFilter(source)

              sanitizeFilterFinishCh.unsubscribe(listener)

              expect(listener).to.have.been.calledOnceWith({ sanitizedObject })
            })
          })
        }
      })
    })
  })
})
