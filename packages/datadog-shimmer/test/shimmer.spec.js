'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')

const shimmer = require('../src/shimmer')
describe('shimmer', () => {
  describe('with a method', () => {
    it('should wrap getter method', () => {
      let index = 0
      let called = false
      const obj = { get increment () { return () => index++ } }

      shimmer.wrap(obj, 'increment', getter => () => {
        called = true
        return getter()
      })

      assert.strictEqual(index, 0)
      assert.strictEqual(called, false)
      const method = obj.increment
      assert.strictEqual(index, 0)
      assert.strictEqual(called, true)
      method()
      assert.strictEqual(index, 1)
      assert.strictEqual(called, true)
    })

    it('should replace getter method when using replaceGetter option', () => {
      let index = 0
      let called = 0
      const returned = () => { assert.strictEqual(called, 0) }

      const obj = {
        get method () {
          index++
          return returned
        }
      }

      shimmer.wrap(obj, 'method', method => () => {
        called++
        return method
      }, { replaceGetter: true })

      assert.strictEqual(index, 1)
      assert.strictEqual(called, 0)
      const fn = obj.method
      assert.strictEqual(fn.name, returned.name)
      assert.strictEqual(index, 1)
      assert.strictEqual(called, 0)
      fn()
      assert.strictEqual(index, 1)
      assert.strictEqual(called, 1)
    })

    it('should not wrap setter only method', () => {
      // eslint-disable-next-line accessor-pairs
      const obj = { set setter (_method_) {} }

      assert.throws(() => shimmer.wrap(obj, 'setter', setter => () => {}), {
        message: 'Replacing setters is not supported. Implement if required.'
      })
    })

    it('should wrap the method', () => {
      const count = inc => inc
      const obj = { count }

      shimmer.wrap(obj, 'count', count => inc => count(inc) + 1)

      assert.strictEqual(obj.count(1), 2)
    })

    it('should wrap the method on a frozen object', () => {
      const count = inc => inc

      let obj = { count, foo: 42 }

      Object.freeze(obj)

      obj = shimmer.wrap(obj, 'count', count => inc => count(inc) + 1)

      assert.strictEqual(obj.count(1), 2)
      assert.strictEqual(obj.foo, 42)
      assert.strictEqual(Object.hasOwn(obj, 'foo'), true)
    })

    it('should wrap the method on a frozen method', () => {
      const count = inc => inc

      function abc () { return this.answer }

      let method = abc
      method.count = count
      method.foo = 'bar'
      method.answer = 42

      Object.freeze(method)

      method = shimmer.wrap(method, 'count', count => inc => count(inc) + 1)

      assert.strictEqual(method.count(1), 2)
      assert.strictEqual(method.foo, 'bar')
      assert.strictEqual(method.name, 'abc')
      assert.notStrictEqual(method, abc)
      assert.strictEqual(method(), 42)
    })

    it('should mass wrap targets', () => {
      const count = inc => inc
      const foo = { count }
      const bar = { count }

      shimmer.massWrap([foo, bar], 'count', count => inc => count(inc) + 1)

      assert.strictEqual(foo.count(1), 2)
      assert.strictEqual(bar.count(1), 2)
    })

    it('should mass wrap methods', () => {
      const count = inc => inc
      const obj = { count, increment: count }

      shimmer.massWrap(obj, ['count', 'increment'], count => inc => count(inc) + 1)

      assert.strictEqual(obj.count(1), 2)
      assert.strictEqual(obj.increment(1), 2)
    })

    it('should wrap the method on functions', () => {
      const count = inc => inc
      const obj = () => {}

      obj.count = count

      shimmer.wrap(obj, 'count', count => inc => count(inc) + 1)

      assert.strictEqual(obj.count(1), 2)
    })

    it('should bail, if not receiving a target', () => {
      const fail = () => { throw new Error() }

      shimmer.wrap(undefined, 'count', fail)
    })

    it('should wrap the method from the prototype', () => {
      const count = inc => inc
      const obj = Object.create({ count })

      shimmer.wrap(obj, 'count', count => inc => count(inc) + 1)

      assert.strictEqual(obj.count(1), 2)
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

      assert.strictEqual(counter.value, 2)
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

      assert.ok(counter instanceof SubCounter)
      assert.ok(counter instanceof Counter)
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

      assert.strictEqual(obj.count.foo, 'foo')
      assert.strictEqual(obj.count.bar, 'bar')
      assert.strictEqual(bar.enumerable, false)
      assert.strictEqual(obj.count[sym], 'sym')
      assert.strictEqual(obj.count.test, 'test')
    })

    it('should preserve the original function length', () => {
      const obj = { count: (a, b, c) => {} }

      shimmer.wrap(obj, 'count', () => () => {})

      assert.strictEqual(obj.count.length, 3)
    })

    it('should preserve the original function name', () => {
      const obj = { count (a, b, c) {} }

      shimmer.wrap(obj, 'count', () => () => {})

      assert.strictEqual(obj.count.name, 'count')
    })

    it('should inherit from the original method prototype', () => {
      const obj = { count: () => {} }

      Object.getPrototypeOf(obj.count).test = 'test'

      shimmer.wrap(obj, 'count', () => () => {})

      assert.strictEqual(obj.count.test, 'test')
      expect(Object.getOwnPropertyNames(obj.count)).to.not.include('test')
    })

    it('should inherit from the original method prototype 2', () => {
      class ExtendedAsyncFunction extends Function {
        foo = 42
      }

      const obj = { count: new ExtendedAsyncFunction() }

      Object.getPrototypeOf(obj.count).test = 'test'

      shimmer.wrap(obj, 'count', () => () => {})

      assert.strictEqual(obj.count.test, 'test')
      assert.strictEqual(obj.count.foo, 42)
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

      assert.strictEqual(count.enumerable, false)
      assert.strictEqual(count.writable, false)
    })

    it('should handle writable non-configurable properties well', () => {
      const obj = {}

      Object.defineProperty(obj, 'count', {
        value: () => {},
        writable: true,
        configurable: false
      })

      shimmer.wrap(obj, 'count', () => () => {})

      const count = Object.getOwnPropertyDescriptor(obj, 'count')

      assert.strictEqual(count.enumerable, false)
      assert.strictEqual(count.writable, true)
      assert.strictEqual(count.configurable, false)
    })

    it('should skip non-configurable/writable string keyed methods', () => {
      const obj = {
        configurable () {}
      }
      Object.defineProperty(obj, 'count', {
        value: () => {},
        configurable: false, // Explicit, even if it's the default
        writable: false
      })

      const countDescriptorBefore = Object.getOwnPropertyDescriptor(obj, 'count')
      shimmer.wrap(obj, 'count', () => () => {})
      const countDescriptorAfter = Object.getOwnPropertyDescriptor(obj, 'count')

      assert.deepStrictEqual(countDescriptorBefore, countDescriptorAfter)

      const configurableDescriptorBefore = Object.getOwnPropertyDescriptor(obj, 'configurable')
      shimmer.wrap(obj, 'configurable', () => () => {})
      const configurableDescriptorAfter = Object.getOwnPropertyDescriptor(obj, 'configurable')

      assert.notDeepStrictEqual(configurableDescriptorBefore.value, configurableDescriptorAfter.value)
      configurableDescriptorAfter.value = configurableDescriptorBefore.value

      assert.deepStrictEqual(configurableDescriptorBefore, configurableDescriptorAfter)
    })

    it('should skip non-configurable/writable symbol keyed methods', () => {
      const configurable = Symbol('configurable')
      const obj = {
        [configurable] () {}
      }
      const symbol = Symbol('count')
      Object.defineProperty(obj, symbol, {
        value: () => {},
        configurable: false, // Explicit, even if it's the default
        writable: false
      })

      const descriptorBefore = Object.getOwnPropertyDescriptor(obj, symbol)
      shimmer.wrap(obj, symbol, () => () => {})
      const descriptorAfter = Object.getOwnPropertyDescriptor(obj, symbol)

      assert.deepStrictEqual(descriptorBefore, descriptorAfter)

      const configurableDescriptorBefore = Object.getOwnPropertyDescriptor(obj, configurable)
      shimmer.wrap(obj, configurable, () => () => {})
      const configurableDescriptorAfter = Object.getOwnPropertyDescriptor(obj, configurable)

      assert.notDeepStrictEqual(configurableDescriptorBefore.value, configurableDescriptorAfter.value)
      configurableDescriptorAfter.value = configurableDescriptorBefore.value

      assert.deepStrictEqual(configurableDescriptorBefore, configurableDescriptorAfter)
    })

    it('should validate that there is a target object', () => {
      assert.throws(() => shimmer.wrap())
    })

    it('should validate that the target object is valid', () => {
      assert.throws(() => shimmer.wrap('invalid'))
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
  })

  describe('with a function', () => {
    it('should not work with a wrap()', () => {
      expect(() => shimmer.wrap(() => {}, () => {})).to.throw()
    })

    it('should not work with null instead of function', () => {
      const a = null
      const wrapped = shimmer.wrapFunction(a, x => () => x)
      assert.notStrictEqual(typeof wrapped, 'function')
    })

    it('should not work with an object', () => {
      const a = { b: 1 }
      const wrapped = shimmer.wrapFunction(a, x => () => x)
      assert.notStrictEqual(typeof wrapped, 'function')
    })

    it('should wrap the function', () => {
      const count = inc => inc

      const wrapped = shimmer.wrapFunction(count, count => inc => count(inc) + 1)

      assert.notStrictEqual(wrapped, count)
      assert.strictEqual(wrapped(1), 2)
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

      assert.strictEqual(counter.value, 2)
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

      assert.strictEqual(wrapped.foo, 'foo')
      assert.strictEqual(wrapped.bar, 'bar')
      assert.strictEqual(bar.enumerable, false)
      assert.strictEqual(wrapped[sym], 'sym')
      assert.strictEqual(wrapped.test, 'test')
    })

    it('should preserve the original function length', () => {
      const count = (a, b, c) => {}

      const wrapped = shimmer.wrapFunction(count, count => () => {})

      assert.strictEqual(wrapped.length, 3)
    })

    it('should preserve the original function name', () => {
      const count = function count (a, b, c) {}

      const wrapped = shimmer.wrapFunction(count, count => () => {})

      assert.strictEqual(wrapped.name, 'count')
    })

    it('should inherit from the original prototype', () => {
      const count = () => {}

      Object.getPrototypeOf(count).test = 'test'

      const wrapped = shimmer.wrapFunction(count, count => () => {})

      assert.strictEqual(wrapped.test, 'test')
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

      assert.strictEqual(foo.a(), 'wrapped')
      assert.strictEqual(foo.b(), 'wrapped')
      assert.strictEqual(bar.a(), 'wrapped')
      assert.strictEqual(bar.b(), 'wrapped')
    })

    it('should validate that the function wrapper exists', () => {
      expect(() => shimmer.wrap(() => {})).to.throw()
    })

    it('should validate that the function wrapper is a function', () => {
      expect(() => shimmer.wrap(() => {}, 'a')).to.throw()
    })
  })
})
