'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')

const shimmer = require('../src/shimmer')
const { assertObjectContains } = require('../../../integration-tests/helpers')

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
        },
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

    it('should wrap a lazy getter/setter pair while preserving the accessor shape', () => {
      // Mirrors Node 20's `fs.opendir`: a lazy accessor that resolves the real
      // function on first read and self-replaces with a data property on write.
      // The wrap must keep it an accessor pair so the descriptor shape stays
      // observationally identical for downstream consumers on that Node version.
      const target = () => 'original'
      const obj = {}
      Object.defineProperty(obj, 'method', {
        configurable: true,
        enumerable: true,
        get () { return target },
        set (value) {
          Object.defineProperty(obj, 'method', { configurable: true, enumerable: true, writable: true, value })
        },
      })

      let called = 0
      shimmer.wrap(obj, 'method', method => (...args) => {
        called++
        return method(...args)
      }, { replaceGetter: true })

      // Still an accessor pair, with the original configurable/enumerable flags.
      const descriptor = Object.getOwnPropertyDescriptor(obj, 'method')
      assert.strictEqual(typeof descriptor.get, 'function')
      assert.strictEqual(typeof descriptor.set, 'function')
      assert.strictEqual(descriptor.configurable, true)
      assert.strictEqual(descriptor.enumerable, true)

      // Reading returns the wrapped method.
      assert.strictEqual(obj.method.name, target.name)
      assert.strictEqual(obj.method(), 'original')
      assert.strictEqual(called, 1)

      // Assignment mirrors the native lazy contract: it materializes the property
      // as a writable data property holding exactly what was set (unwrapped).
      const replacement = () => 'replacement'
      obj.method = replacement
      const afterSet = Object.getOwnPropertyDescriptor(obj, 'method')
      assert.strictEqual(afterSet.get, undefined)
      assert.strictEqual(afterSet.set, undefined)
      assert.strictEqual(afterSet.writable, true)
      assert.strictEqual(obj.method, replacement)
      assert.strictEqual(obj.method(), 'replacement')
      assert.strictEqual(called, 1, 'a caller-supplied replacement is not wrapped')
    })

    it('should wrap a getter/setter pair in place without the replaceGetter option', () => {
      // Mirrors `url.js` wrapping the `URL.prototype` `host`/`hostname` getters,
      // which are getter+setter accessor pairs. Each read must run the wrapper,
      // and the original setter is left untouched.
      let setValue
      const obj = {}
      Object.defineProperty(obj, 'method', {
        configurable: true,
        enumerable: true,
        get () { return 'original' },
        set (value) { setValue = value },
      })

      let called = 0
      shimmer.wrap(obj, 'method', getter => function () {
        called++
        return getter.call(this)
      })

      const descriptor = Object.getOwnPropertyDescriptor(obj, 'method')
      assert.strictEqual(typeof descriptor.get, 'function')
      assert.strictEqual(typeof descriptor.set, 'function')

      assert.strictEqual(obj.method, 'original')
      assert.strictEqual(called, 1)
      assert.strictEqual(obj.method, 'original')
      assert.strictEqual(called, 2)

      obj.method = 42
      assert.strictEqual(setValue, 42)
      assert.strictEqual(typeof Object.getOwnPropertyDescriptor(obj, 'method').set, 'function')
    })

    it('should not wrap setter only method', () => {
      // eslint-disable-next-line accessor-pairs
      const obj = { set setter (_method_) {} }

      assert.throws(() => shimmer.wrap(obj, 'setter', setter => () => {}), {
        message: 'Replacing setters is not supported. Implement if required.',
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

      shimmer.wrap(obj, 'Counter', Counter => function (...args) {
        Counter.apply(this, args)
        this.value++
      })

      const counter = new obj.Counter(1)

      assert.strictEqual(counter.value, 2)
      assert.ok(counter instanceof Counter)
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
      assert.strictEqual(Object.hasOwn(obj.count, 'test'), false)
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
      assert.strictEqual(Object.hasOwn(obj.count, 'test'), false)
    })

    it('should preserve the property descriptor of the original', () => {
      const obj = {}

      Object.defineProperty(obj, 'count', {
        value: () => {},
        configurable: true,
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
        configurable: false,
      })

      shimmer.wrap(obj, 'count', () => () => {})

      const count = Object.getOwnPropertyDescriptor(obj, 'count')

      assertObjectContains(count, {
        enumerable: false,
        writable: true,
        configurable: false,
      })
    })

    it('should wrap writable non-configurable module namespace exports', async () => {
      const namespace = await import('data:text/javascript,export function count() { return 1 }')

      /** @param {Function} count */
      const increment = count => () => count() + 1
      const wrapped = shimmer.wrap(namespace, 'count', increment)

      assert.strictEqual(namespace.count(), 1)
      assert.strictEqual(wrapped.count(), 2)
      assert.notStrictEqual(wrapped, namespace)
    })

    it('should skip non-configurable/writable string keyed methods', () => {
      const obj = {
        configurable () {},
      }
      Object.defineProperty(obj, 'count', {
        value: () => {},
        configurable: false, // Explicit, even if it's the default
        writable: false,
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
        [configurable] () {},
      }
      const symbol = Symbol('count')
      Object.defineProperty(obj, symbol, {
        value: () => {},
        configurable: false, // Explicit, even if it's the default
        writable: false,
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
      assert.throws(() => shimmer.wrap({}, 'invalid', () => () => {}))
    })

    it('should validate that the target method is a function', () => {
      assert.throws(() => shimmer.wrap({ a: 1234 }, 'a', () => () => {}))
    })

    it('should validate that the method wrapper is passed', () => {
      assert.throws(() => shimmer.wrap({ a: () => {} }, 'a'))
    })

    it('should validate that the method wrapper is a function', () => {
      assert.throws(() => shimmer.wrap({ a: () => {} }, 'a', 'notafunction'))
    })
  })

  describe('with a function', () => {
    it('should not work with a wrap()', () => {
      assert.throws(() => shimmer.wrap(() => {}, () => {}))
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
      assert.ok(counter instanceof Counter)
    })

    it('should not wrap the class constructor', () => {
      class Counter {
        constructor (start) {
          this.value = start
        }
      }

      assert.throws(() => shimmer.wrapFunction(Counter, Counter => function () {}), /Target is a native class constructor and cannot be wrapped\./)
    })

    it('should not wrap the class constructor with invalid toString()', () => {
      class Counter {
        constructor (start) {
          this.value = start
        }
      }

      Counter.toString = 'invalid'

      assert.throws(() => shimmer.wrapFunction(Counter, Counter => function () {}), /Target is a native class constructor and cannot be wrapped\./)
    })

    it('should detect class constructors without materializing the source', () => {
      const spy = sinon.spy(Function.prototype, 'toString')
      try {
        const count = inc => inc
        shimmer.wrapFunction(count, count => () => {})

        function legacyCtor (start) { this.value = start }
        shimmer.wrapFunction(legacyCtor, ctor => function (...args) { ctor.apply(this, args) })

        class Counter {}
        assert.throws(
          () => shimmer.wrapFunction(Counter, Counter => function () {}),
          /Target is a native class constructor and cannot be wrapped\./
        )

        assert.strictEqual(spy.callCount, 0)
      } finally {
        spy.restore()
      }
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
      assert.strictEqual(Object.hasOwn(wrapped, 'test'), false)
    })

    it('should mass wrap methods on objects', () => {
      const foo = {
        a: () => 'original',
        b: () => 'original',
      }

      const bar = {
        a: () => 'original',
        b: () => 'original',
      }

      shimmer.massWrap([foo, bar], ['a', 'b'], () => () => 'wrapped')

      assert.strictEqual(foo.a(), 'wrapped')
      assert.strictEqual(foo.b(), 'wrapped')
      assert.strictEqual(bar.a(), 'wrapped')
      assert.strictEqual(bar.b(), 'wrapped')
    })

    it('should validate that the function wrapper exists', () => {
      assert.throws(() => shimmer.wrap(() => {}))
    })

    it('should validate that the function wrapper is a function', () => {
      assert.throws(() => shimmer.wrap(() => {}, 'a'))
    })
  })

  describe('wrapCallback', () => {
    it('preserves the empty name of an anonymous arrow even when the wrapper closure has a name', () => {
      // Inline arrow has no V8-lifted assignment-target name, so `original.name === ''`.
      // The wrapper closure is named to force the `wrapped.name !== original.name` branch.
      const wrapped = shimmer.wrapCallback((a, b) => a + b, () => function wrappedNamed () {})
      assert.strictEqual(wrapped.name, '')
    })

    it('preserves the name of a named function expression', () => {
      const original = function namedOriginal (a, b) { return a + b }
      const wrapped = shimmer.wrapCallback(original, () => (a, b) => a + b)
      assert.strictEqual(wrapped.name, 'namedOriginal')
    })

    it('preserves the name of a function declaration', () => {
      function declaredOriginal (a, b) { return a + b }
      const wrapped = shimmer.wrapCallback(declaredOriginal, () => (a, b) => a + b)
      assert.strictEqual(wrapped.name, 'declaredOriginal')
    })

    it('preserves the name of a .bind() result', () => {
      function declaredOriginal (a, b) { return a + b }
      const bound = declaredOriginal.bind(null)
      const wrapped = shimmer.wrapCallback(bound, () => (a, b) => a + b)
      assert.strictEqual(bound.name, 'bound declaredOriginal')
      assert.strictEqual(wrapped.name, 'bound declaredOriginal')
    })

    it('preserves length 0, 1, 2, 3 on the wrapper', () => {
      const wrapped0 = shimmer.wrapCallback(() => {}, () => (a, b) => a + b)
      const wrapped1 = shimmer.wrapCallback((a) => a, () => (a, b) => a + b)
      const wrapped2 = shimmer.wrapCallback((a, b) => a + b, () => () => {})
      const wrapped3 = shimmer.wrapCallback((a, b, c) => a + b + c, () => () => {})

      assert.strictEqual(wrapped0.length, 0)
      assert.strictEqual(wrapped1.length, 1)
      assert.strictEqual(wrapped2.length, 2)
      assert.strictEqual(wrapped3.length, 3)
    })

    it('forwards `this` via .apply()', () => {
      let observed
      const original = function (a) { observed = this }
      const wrapped = shimmer.wrapCallback(original, original => function (a) {
        return original.apply(this, arguments)
      })

      const target = { name: 'target' }
      wrapped.apply(target, [1])

      assert.strictEqual(observed, target)
    })

    it('forwards arguments unchanged to the original', () => {
      let observed
      const original = function (...args) { observed = args }
      const wrapped = shimmer.wrapCallback(original, original => function () {
        return original.apply(this, arguments)
      })

      wrapped(1, 'two', { three: 3 }, [4])

      assert.deepStrictEqual(observed, [1, 'two', { three: 3 }, [4]])
    })

    it('does not copy custom own properties from the original', () => {
      const original = function () {}
      original.foo = 1
      original[Symbol.for('shimmer.wrapCallback.test')] = 'sym'

      const wrapped = shimmer.wrapCallback(original, () => () => {})

      assert.strictEqual(wrapped.foo, undefined)
      assert.strictEqual(wrapped[Symbol.for('shimmer.wrapCallback.test')], undefined)
    })

    it('propagates the wrapper return value', () => {
      const wrapped = shimmer.wrapCallback(() => 1, () => () => 42)

      assert.strictEqual(wrapped(), 42)
    })

    it('skips defineProperty when name and length already match', () => {
      // Sanity: wrapper closure built with the same shape pays no overhead.
      // defineProperty would make name / length configurable: true; the
      // autogenerated descriptors remain configurable: true either way, so
      // the user-visible value-check is what we assert here.
      function original (a, b) { return a + b }
      const wrapped = shimmer.wrapCallback(original, () => function original (a, b) {})

      assert.strictEqual(wrapped.name, 'original')
      assert.strictEqual(wrapped.length, 2)
    })
  })
})
