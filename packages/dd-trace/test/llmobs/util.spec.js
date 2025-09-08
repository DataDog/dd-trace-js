'use strict'

const { expect } = require('chai')
const { describe, it, before } = require('mocha')

const {
  encodeUnicode,
  getFunctionArguments,
  validateKind,
  spanHasError
} = require('../../src/llmobs/util')

describe('util', () => {
  describe('encodeUnicode', () => {
    it('should encode unicode characters', () => {
      expect(encodeUnicode('😀')).to.equal('\\ud83d\\ude00')
    })

    it('should encode only unicode characters in a string', () => {
      expect(encodeUnicode('test 😀')).to.equal('test \\ud83d\\ude00')
    })
  })

  describe('validateKind', () => {
    for (const kind of ['llm', 'agent', 'task', 'tool', 'workflow', 'retrieval', 'embedding']) {
      it(`should return true for valid kind: ${kind}`, () => {
        expect(validateKind(kind)).to.equal(kind)
      })
    }

    it('should throw for an empty string', () => {
      expect(() => validateKind('')).to.throw()
    })

    it('should throw for an invalid kind', () => {
      expect(() => validateKind('invalid')).to.throw()
    })

    it('should throw for an undefined kind', () => {
      expect(() => validateKind()).to.throw()
    })
  })

  describe('getFunctionArguments', () => {
    describe('functionality', () => {
      it('should return undefined for a function without arguments', () => {
        expect(getFunctionArguments(() => {})).to.deep.equal(undefined)
      })

      it('should capture a single argument only by its value', () => {
        expect(getFunctionArguments((arg) => {}, ['bar'])).to.deep.equal('bar')
      })

      it('should capture multiple arguments by name', () => {
        expect(getFunctionArguments((foo, bar) => {}, ['foo', 'bar'])).to.deep.equal({ foo: 'foo', bar: 'bar' })
      })

      it('should ignore arguments not passed in', () => {
        expect(getFunctionArguments((foo, bar, baz) => {}, ['foo', 'bar'])).to.deep.equal({ foo: 'foo', bar: 'bar' })
      })

      it('should capture spread arguments', () => {
        expect(
          getFunctionArguments((foo, bar, ...args) => {}, ['foo', 'bar', 1, 2, 3])
        ).to.deep.equal({ foo: 'foo', bar: 'bar', args: [1, 2, 3] })
      })
    })

    describe('parsing configurations', () => {
      it('should parse multiple arguments with single-line comments', () => {
        function foo (
          bar, // bar comment
          baz // baz comment
        ) {}

        expect(getFunctionArguments(foo, ['bar', 'baz'])).to.deep.equal({ bar: 'bar', baz: 'baz' })
      })

      it('should parse multiple arguments with multi-line comments', () => {
        function foo (
          bar, /* bar comment */
          baz /* baz comment */
        ) {}

        expect(getFunctionArguments(foo, ['bar', 'baz'])).to.deep.equal({ bar: 'bar', baz: 'baz' })
      })

      it('should parse multiple arguments with stacked multi-line comments', () => {
        function foo (
          /**
           * hello
           */
          bar,
          /**
           * world
           */
          baz
        ) {}

        expect(getFunctionArguments(foo, ['bar', 'baz'])).to.deep.equal({ bar: 'bar', baz: 'baz' })
      })

      it('parses when simple default values are present', () => {
        function foo (bar = 'baz') {}

        expect(getFunctionArguments(foo, ['bar'])).to.deep.equal('bar')
      })

      it('should ignore the default value when no argument is passed', () => {
        function foo (bar = 'baz') {}

        expect(getFunctionArguments(foo, [])).to.deep.equal(undefined)
      })

      it('parses when a default value is a function', () => {
        function foo (bar = () => {}, baz = 4) {}

        expect(getFunctionArguments(foo, ['bar'])).to.deep.equal('bar')
      })

      it('parses when a simple object is passed in', () => {
        function foo (bar = { baz: 4 }) {}

        expect(getFunctionArguments(foo, ['bar'])).to.deep.equal('bar')
      })

      it('parses when a complex object is passed in', () => {
        function foo (bar = { baz: { a: 5, b: { c: 4 } }, bat: 0 }, baz) {}

        expect(getFunctionArguments(foo, [{ bar: 'baz' }, 'baz'])).to.deep.equal({ bar: { bar: 'baz' }, baz: 'baz' })
      })

      it('parses when one of the arguments is an arrow function', () => {
        function foo (fn = (a, b, c) => {}, ctx) {}

        expect(getFunctionArguments(foo, ['fn', 'ctx'])).to.deep.equal({ fn: 'fn', ctx: 'ctx' })
      })

      it('parses when one of the arguments is a function', () => {
        function foo (fn = function (a, b, c) {}, ctx) {}

        expect(getFunctionArguments(foo, ['fn', 'ctx'])).to.deep.equal({ fn: 'fn', ctx: 'ctx' })
      })
    })
  })

  describe('spanHasError', () => {
    let Span
    let ps

    before(() => {
      Span = require('../../src/opentracing/span')
      ps = {
        sample () {}
      }
    })

    it('returns false when there is no error', () => {
      const span = new Span(null, null, ps, {})
      expect(spanHasError(span)).to.equal(false)
    })

    it('returns true if the span has an "error" tag', () => {
      const span = new Span(null, null, ps, {})
      span.setTag('error', true)
      expect(spanHasError(span)).to.equal(true)
    })

    it('returns true if the span has the error properties as tags', () => {
      const err = new Error('boom')
      const span = new Span(null, null, ps, {})

      span.setTag('error.type', err.name)
      span.setTag('error.msg', err.message)
      span.setTag('error.stack', err.stack)

      expect(spanHasError(span)).to.equal(true)
    })
  })
})
