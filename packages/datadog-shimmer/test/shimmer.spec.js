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

    it('should unwrap a method', () => {
      const count = inc => inc
      const obj = { count }

      shimmer.wrap(obj, 'count', count => inc => count(inc) + 1)
      shimmer.unwrap(obj, 'count')

      expect(obj.count(1)).to.equal(1)
    })

    it('should validate that there is a target object', () => {
      expect(() => shimmer.wrap()).to.throw()
    })

    it('should validate that a method exists on the target object', () => {
      expect(() => shimmer.wrap({}, 'invalid', () => () => {})).to.throw()
    })

    it('should validate that the target method is a function', () => {
      expect(() => shimmer.wrap({ a: 1234 }, 'a', () => () => {})).to.throw()
    })

    it('should validate that the method wrapper is a function', () => {
      expect(() => shimmer.wrap({ a: () => {} }, 'a')).to.throw()
    })

    it('should validate that the unwrap target method is wrapped', () => {
      expect(() => shimmer.unwrap({ a: () => {} }, 'a')).to.throw()
    })
  })

  describe('with a function', () => {
    it('should wrap the function', () => {
      const count = inc => inc

      const wrapped = shimmer.wrap(count, inc => count(inc) + 1)

      expect(wrapped).to.not.equal(count)
      expect(wrapped(1)).to.equal(2)
    })

    it('should preserve property descriptors from the original', () => {
      const count = () => {}
      const sym = Symbol('sym')

      Object.defineProperty(count, 'bar', { value: 'bar' })
      Object.getPrototypeOf(count).test = 'test'

      count.foo = 'foo'
      count[sym] = 'sym'

      const wrapped = shimmer.wrap(count, () => {})
      const bar = Object.getOwnPropertyDescriptor(wrapped, 'bar')

      expect(wrapped).to.have.property('foo', 'foo')
      expect(wrapped).to.have.property('bar', 'bar')
      expect(bar).to.have.property('enumerable', false)
      expect(wrapped).to.have.property(sym, 'sym')
      expect(wrapped).to.have.property('test', 'test')
    })

    it('should preserve the original function length', () => {
      const count = (a, b, c) => {}

      const wrapped = shimmer.wrap(count, () => {})

      expect(wrapped).to.have.length(3)
    })

    it('should inherit from the original prototype', () => {
      const count = () => {}

      Object.getPrototypeOf(count).test = 'test'

      const wrapped = shimmer.wrap(count, () => {})

      expect(wrapped).to.have.property('test', 'test')
      expect(Object.getOwnPropertyNames(wrapped)).to.not.include('test')
    })

    it('should unwrap a function', () => {
      const count = inc => inc

      const wrapped = shimmer.wrap(count, inc => count(inc) + 1)
      const original = shimmer.unwrap(wrapped)

      expect(wrapped).to.not.equal(count)
      expect(original).to.equal(count)
      expect(wrapped(1)).to.equal(1)
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
      shimmer.massUnwrap([foo, bar], ['a', 'b'])

      expect(foo.a()).to.equal('original')
      expect(foo.b()).to.equal('original')
      expect(bar.a()).to.equal('original')
      expect(bar.b()).to.equal('original')
    })

    it('should validate that the function wrapper exists', () => {
      expect(() => shimmer.wrap(() => {})).to.throw()
    })

    it('should validate that the function wrapper is a function', () => {
      expect(() => shimmer.wrap(() => {}, 'a')).to.throw()
    })

    it('should validate that the unwrap target function is wrapped', () => {
      expect(() => shimmer.unwrap(() => {})).to.throw()
    })
  })
})
