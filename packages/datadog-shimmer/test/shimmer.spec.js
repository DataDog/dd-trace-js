'use strict'

const { expect } = require('chai')
const shimmer = require('../src/shimmer')

describe('shimmer', () => {
  describe('with a method', () => {
    it('should wrap the method', () => {
      const count = inc => inc
      const obj = { count }

      shimmer.wrap(obj, 'count', count => inc => count(inc) + 1)

      expect(obj.count(1)).to.equal(2)
    })

    it('should wrap the method on a frozen object', () => {
      const count = inc => inc

      let obj = { count }

      Object.freeze(obj)

      obj = shimmer.wrap(obj, 'count', count => inc => count(inc) + 1)

      expect(obj.count(1)).to.equal(2)
    })

    it('should mass wrap targets', () => {
      const count = inc => inc
      const foo = { count }
      const bar = { count }

      shimmer.massWrap([foo, bar], 'count', count => inc => count(inc) + 1)

      expect(foo.count(1)).to.equal(2)
      expect(bar.count(1)).to.equal(2)
    })

    it('should mass wrap methods', () => {
      const count = inc => inc
      const obj = { count, increment: count }

      shimmer.massWrap(obj, ['count', 'increment'], count => inc => count(inc) + 1)

      expect(obj.count(1)).to.equal(2)
      expect(obj.increment(1)).to.equal(2)
    })

    it('should wrap the method on functions', () => {
      const count = inc => inc
      const obj = () => {}

      obj.count = count

      shimmer.wrap(obj, 'count', count => inc => count(inc) + 1)

      expect(obj.count(1)).to.equal(2)
    })

    it('should wrap the method from the prototype', () => {
      const count = inc => inc
      const obj = Object.create({ count })

      shimmer.wrap(obj, 'count', count => inc => count(inc) + 1)

      expect(obj.count(1)).to.equal(2)
    })

    it('should wrap a constructor', () => {
      const Counter = function (start) {
        this.value = start
      }
      const obj = { Counter }

      shimmer.wrap(obj, 'Counter', Counter => function () {
        Counter.apply(this, arguments)
        this.value++
      })

      const counter = new obj.Counter(1)

      expect(counter.value).to.equal(2)
      expect(counter).to.be.an.instanceof(Counter)
    })

    it('should wrap a class constructor', () => {
      class Counter {
        constructor (start) {
          this.value = start
        }
      }

      class SubCounter extends Counter {}

      const obj = { Counter }

      shimmer.wrap(obj, 'Counter', () => SubCounter)

      const counter = new obj.Counter()

      expect(counter).to.be.instanceof(SubCounter)
      expect(counter).to.be.instanceof(Counter)
    })

    it('should preserve property descriptors from the original', () => {
      const obj = { count: () => {} }
      const sym = Symbol('sym')

      Object.defineProperty(obj.count, 'bar', { value: 'bar' })
      Object.getPrototypeOf(obj.count).test = 'test'

      obj.count.foo = 'foo'
      obj.count[sym] = 'sym'

      shimmer.wrap(obj, 'count', () => () => {})

      const bar = Object.getOwnPropertyDescriptor(obj.count, 'bar')

      expect(obj.count).to.have.property('foo', 'foo')
      expect(obj.count).to.have.property('bar', 'bar')
      expect(bar).to.have.property('enumerable', false)
      expect(obj.count).to.have.property(sym, 'sym')
      expect(obj.count).to.have.property('test', 'test')
    })

    it('should preserve the original function length', () => {
      const obj = { count: (a, b, c) => {} }

      shimmer.wrap(obj, 'count', () => () => {})

      expect(obj.count).to.have.length(3)
    })

    it('should preserve the original function name', () => {
      const obj = { count (a, b, c) {} }

      shimmer.wrap(obj, 'count', () => () => {})

      expect(obj.count).to.have.property('name', 'count')
    })

    it('should inherit from the original prototype', () => {
      const obj = { count: () => {} }

      Object.getPrototypeOf(obj.count).test = 'test'

      shimmer.wrap(obj, 'count', () => () => {})

      expect(obj.count).to.have.property('test', 'test')
      expect(Object.getOwnPropertyNames(obj.count)).to.not.include('test')
    })

    it('should preserve the property descriptor of the original', () => {
      const obj = {}

      Object.defineProperty(obj, 'count', {
        value: () => {},
        configurable: true
      })

      shimmer.wrap(obj, 'count', () => () => {})

      const count = Object.getOwnPropertyDescriptor(obj, 'count')

      expect(count).to.have.property('enumerable', false)
    })

    it('should validate that there is a target object', () => {
      expect(() => shimmer.wrap()).to.throw()
    })

    it('should validate that the target object is valid', () => {
      expect(() => shimmer.wrap('invalid')).to.throw()
    })

    it('should validate that a method exists on the target object', () => {
      expect(() => shimmer.wrap({}, 'invalid', () => () => {})).to.throw()
    })

    it('should validate that the target method is a function', () => {
      expect(() => shimmer.wrap({ a: 1234 }, 'a', () => () => {})).to.throw()
    })

    it('should validate that the method wrapper is passed', () => {
      expect(() => shimmer.wrap({ a: () => {} }, 'a')).to.throw()
    })

    it('should validate that the method wrapper is a function', () => {
      expect(() => shimmer.wrap({ a: () => {} }, 'a', 'notafunction')).to.throw()
    })

    describe('safe mode', () => {
      let obj

      before(() => {
        shimmer.setSafe(true)
      })

      after(() => {
        shimmer.setSafe(false)
      })

      describe('sync', () => {
        beforeEach(() => {
          obj = { count: () => 3 }
        })

        it('should not throw when wrapper code is throwing', () => {
          shimmer.wrap(obj, 'count', () => {
            return () => {
              throw new Error('wrapper error')
            }
          })

          expect(obj.count()).to.equal(3)
        })

        it('should not throw when wrapper code is throwing after return', () => {
          shimmer.wrap(obj, 'count', (count) => {
            return () => {
              count()
              throw new Error('wrapper error')
            }
          })

          expect(obj.count()).to.equal(3)
        })
      })

      describe('sync recursive', () => {
        beforeEach(() => {
          obj = { count: (x = 1) => x === 3 ? 3 : obj.count(x + 1) }
        })

        it('should not throw when wrapper code is throwing', () => {
          shimmer.wrap(obj, 'count', (count) => {
            return function (x) {
              if (x === 2) {
                throw new Error('wrapper error')
              }
              return count.apply(this, arguments)
            }
          })

          expect(obj.count()).to.equal(3)
        })

        it('should not throw when wrapper code is throwing mid-recursion', () => {
          shimmer.wrap(obj, 'count', (count) => {
            return function (x) {
              const returnValue = count.apply(this, arguments)
              if (x === 2) {
                throw new Error('wrapper error')
              }
              return returnValue
            }
          })

          expect(obj.count()).to.equal(3)
        })

        it('should not throw when wrapper code is throwing after return', () => {
          shimmer.wrap(obj, 'count', (count) => {
            return function (x) {
              const returnValue = count.apply(this, arguments)
              if (x === 3) {
                throw new Error('wrapper error')
              }
              return returnValue
            }
          })

          expect(obj.count()).to.equal(3)
        })
      })

      describe('async', () => {
        beforeEach(() => {
          obj = { count: async () => await Promise.resolve(3) }
        })

        it('should not throw when wrapper code is throwing', async () => {
          shimmer.wrap(obj, 'count', (count) => {
            return async function (x) {
              if (x === 2) {
                throw new Error('wrapper error')
              }
              return await count.apply(this, arguments)
            }
          })

          expect(await obj.count()).to.equal(3)
        })

        it('should not throw when wrapper code is throwing after return', async () => {
          shimmer.wrap(obj, 'count', (count) => {
            return async () => {
              await count()
              throw new Error('wrapper error')
            }
          })

          expect(await obj.count()).to.equal(3)
        })
      })

      describe('async recursion', () => {
        beforeEach(() => {
          obj = {
            async count (x = 1) {
              if (x === 3) return await Promise.resolve(3)
              else return await obj.count(x + 1)
            }
          }
        })

        it('should not throw when wrapper code is throwing', async () => {
          shimmer.wrap(obj, 'count', (count) => {
            return async function (x) {
              if (x === 2) {
                throw new Error('wrapper error')
              }
              return await count.apply(this, arguments)
            }
          })

          expect(await obj.count()).to.equal(3)
        })

        it('should not throw when wrapper code is throwing mid-recursion', async () => {
          shimmer.wrap(obj, 'count', (count) => {
            return async function (x) {
              const returnValue = await count.apply(this, arguments)
              if (x === 2) {
                throw new Error('wrapper error')
              }
              return returnValue
            }
          })

          expect(await obj.count()).to.equal(3)
        })

        it('should not throw when wrapper code is throwing after return', async () => {
          shimmer.wrap(obj, 'count', (count) => {
            return async function (x) {
              const returnValue = await count.apply(this, arguments)
              if (x === 3) {
                throw new Error('wrapper error')
              }
              return returnValue
            }
          })

          expect(await obj.count()).to.equal(3)
        })
      })
      // describe('callback', () => {
      //   it('should not throw when wrapper code is throwing', (done) => {
      //     const obj = { count: cb => setImmediate(() => cb(null, 3)) }

      //     shimmer.wrap(obj, 'count', () => {
      //       return () => {
      //         throw new Error('wrapper error')
      //       }
      //     })

      //     obj.count((err, res) => {
      //       expect(res).to.equal(3)
      //       done()
      //     })
      //   })
      //   it('should not throw when wrapper code calls cb with error', async () => {
      //     const obj = { count: cb => setImmediate(() => cb(null, 3)) }

      //     shimmer.wrap(obj, 'count', (count) => {
      //       return (cb) => {
      //         count((err, val) => {
      //           cb(new Error('wrapper error'))
      //         })
      //       }
      //     })

      //     obj.count((err, res) => {
      //       expect(err).to.be.undefined
      //       expect(res).to.equal(3)
      //       done()
      //     })
      //   })
      // })
    })
  })

  describe('with a function', () => {
    it('should not work with a wrap()', () => {
      expect(() => shimmer.wrap(() => {}, () => {})).to.throw()
    })

    it('should wrap the function', () => {
      const count = inc => inc

      const wrapped = shimmer.wrapFunction(count, count => inc => count(inc) + 1)

      expect(wrapped).to.not.equal(count)
      expect(wrapped(1)).to.equal(2)
    })

    it('should wrap the constructor', () => {
      const Counter = function (start) {
        this.value = start
      }

      const WrappedCounter = shimmer.wrapFunction(Counter, Counter => function (...args) {
        Counter.apply(this, arguments)
        this.value++
      })

      const counter = new WrappedCounter(1)

      expect(counter.value).to.equal(2)
      expect(counter).to.be.an.instanceof(Counter)
    })

    it('should not wrap the class constructor', () => {
      class Counter {
        constructor (start) {
          this.value = start
        }
      }

      expect(() => shimmer.wrapFunction(Counter, Counter => function () {})).to.throw(
        'Target is a native class constructor and cannot be wrapped.'
      )
    })

    it('should not wrap the class constructor with invalid toString()', () => {
      class Counter {
        constructor (start) {
          this.value = start
        }
      }

      Counter.toString = 'invalid'

      expect(() => shimmer.wrapFunction(Counter, Counter => function () {})).to.throw(
        'Target is a native class constructor and cannot be wrapped.'
      )
    })

    it('should preserve property descriptors from the original', () => {
      const count = () => {}
      const sym = Symbol('sym')

      Object.defineProperty(count, 'bar', { value: 'bar' })
      Object.getPrototypeOf(count).test = 'test'

      count.foo = 'foo'
      count[sym] = 'sym'

      const wrapped = shimmer.wrapFunction(count, count => () => {})
      const bar = Object.getOwnPropertyDescriptor(wrapped, 'bar')

      expect(wrapped).to.have.property('foo', 'foo')
      expect(wrapped).to.have.property('bar', 'bar')
      expect(bar).to.have.property('enumerable', false)
      expect(wrapped).to.have.property(sym, 'sym')
      expect(wrapped).to.have.property('test', 'test')
    })

    it('should preserve the original function length', () => {
      const count = (a, b, c) => {}

      const wrapped = shimmer.wrapFunction(count, count => () => {})

      expect(wrapped).to.have.length(3)
    })

    it('should preserve the original function name', () => {
      const count = function count (a, b, c) {}

      const wrapped = shimmer.wrapFunction(count, count => () => {})

      expect(wrapped).to.have.property('name', 'count')
    })

    it('should inherit from the original prototype', () => {
      const count = () => {}

      Object.getPrototypeOf(count).test = 'test'

      const wrapped = shimmer.wrapFunction(count, count => () => {})

      expect(wrapped).to.have.property('test', 'test')
      expect(Object.getOwnPropertyNames(wrapped)).to.not.include('test')
    })

    it('should mass wrap methods on objects', () => {
      const foo = {
        a: () => 'original',
        b: () => 'original'
      }

      const bar = {
        a: () => 'original',
        b: () => 'original'
      }

      shimmer.massWrap([foo, bar], ['a', 'b'], () => () => 'wrapped')

      expect(foo.a()).to.equal('wrapped')
      expect(foo.b()).to.equal('wrapped')
      expect(bar.a()).to.equal('wrapped')
      expect(bar.b()).to.equal('wrapped')
    })

    it('should validate that the function wrapper exists', () => {
      expect(() => shimmer.wrap(() => {})).to.throw()
    })

    it('should validate that the function wrapper is a function', () => {
      expect(() => shimmer.wrap(() => {}, 'a')).to.throw()
    })
  })
})
