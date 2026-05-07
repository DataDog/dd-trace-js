'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')

const getConfig = require('../../src/config')
const {
  encodeUnicode,
  getFunctionArguments,
  validateCostTags,
  safeJsonParse,
  validateKind,
  spanHasError,
} = require('../../src/llmobs/util')

describe('util', () => {
  describe('encodeUnicode', () => {
    it('should encode unicode characters', () => {
      assert.strictEqual(encodeUnicode('😀'), '\\ud83d\\ude00')
    })

    it('should encode only unicode characters in a string', () => {
      assert.strictEqual(encodeUnicode('test 😀'), 'test \\ud83d\\ude00')
    })
  })

  describe('validateKind', () => {
    for (const kind of ['llm', 'agent', 'task', 'tool', 'workflow', 'retrieval', 'embedding']) {
      it(`should return true for valid kind: ${kind}`, () => {
        assert.strictEqual(validateKind(kind), kind)
      })
    }

    it('should throw for an empty string', () => {
      assert.throws(() => validateKind(''))
    })

    it('should throw for an invalid kind', () => {
      assert.throws(() => validateKind('invalid'))
    })

    it('should throw for an undefined kind', () => {
      assert.throws(() => validateKind())
    })
  })

  describe('validateCostTags', () => {
    const span = {}

    it('should return cost tags that reference span tags', () => {
      const costTags = validateCostTags(span, ['team', 'feature'], 'annotate', {
        team: 'ml',
        feature: 'chatbot',
      })

      assert.deepStrictEqual(costTags, ['team', 'feature'])
    })

    it('should skip invalid cost tags', () => {
      const costTags = validateCostTags(span, ['team', 'missing', 123], 'annotate', { team: 'ml' })

      assert.deepStrictEqual(costTags, ['team'])
    })

    it('should reject non-array cost tags', () => {
      const costTags = validateCostTags(span, 'team', 'annotate', { team: 'ml' })

      assert.deepStrictEqual(costTags, [])
    })

    it('should return an empty list for an empty list', () => {
      const costTags = validateCostTags(span, [], 'annotate', { team: 'ml' })

      assert.deepStrictEqual(costTags, [])
    })
  })

  describe('getFunctionArguments', () => {
    describe('functionality', () => {
      it('should return undefined for a function without arguments', () => {
        assert.deepStrictEqual(getFunctionArguments(() => {}), undefined)
      })

      it('should capture a single argument only by its value', () => {
        assert.deepStrictEqual(getFunctionArguments((arg) => {}, ['bar']), 'bar')
      })

      it('should capture multiple arguments by name', () => {
        assert.deepStrictEqual(getFunctionArguments((foo, bar) => {}, ['foo', 'bar']), { foo: 'foo', bar: 'bar' })
      })

      it('should ignore arguments not passed in', () => {
        assert.deepStrictEqual(getFunctionArguments((foo, bar, baz) => {}, ['foo', 'bar']), { foo: 'foo', bar: 'bar' })
      })

      it('should capture spread arguments', () => {
        assert.deepStrictEqual(
          getFunctionArguments((foo, bar, ...args) => {}, ['foo', 'bar', 1, 2, 3]),
          { foo: 'foo', bar: 'bar', args: [1, 2, 3] }
        )
      })
    })

    describe('parsing configurations', () => {
      it('should parse multiple arguments with single-line comments', () => {
        function foo (
          bar, // bar comment
          baz // baz comment
        ) {}

        assert.deepStrictEqual(getFunctionArguments(foo, ['bar', 'baz']), { bar: 'bar', baz: 'baz' })
      })

      it('should parse multiple arguments with multi-line comments', () => {
        function foo (
          bar, /* bar comment */
          baz /* baz comment */
        ) {}

        assert.deepStrictEqual(getFunctionArguments(foo, ['bar', 'baz']), { bar: 'bar', baz: 'baz' })
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

        assert.deepStrictEqual(getFunctionArguments(foo, ['bar', 'baz']), { bar: 'bar', baz: 'baz' })
      })

      it('parses when simple default values are present', () => {
        function foo (bar = 'baz') {}

        assert.deepStrictEqual(getFunctionArguments(foo, ['bar']), 'bar')
      })

      it('should ignore the default value when no argument is passed', () => {
        function foo (bar = 'baz') {}

        assert.deepStrictEqual(getFunctionArguments(foo, []), undefined)
      })

      it('parses when a default value is a function', () => {
        function foo (bar = () => {}, baz = 4) {}

        assert.deepStrictEqual(getFunctionArguments(foo, ['bar']), 'bar')
      })

      it('parses when a simple object is passed in', () => {
        function foo (bar = { baz: 4 }) {}

        assert.deepStrictEqual(getFunctionArguments(foo, ['bar']), 'bar')
      })

      it('parses when a complex object is passed in', () => {
        function foo (bar = { baz: { a: 5, b: { c: 4 } }, bat: 0 }, baz) {}

        assert.deepStrictEqual(getFunctionArguments(foo, [{ bar: 'baz' }, 'baz']), { bar: { bar: 'baz' }, baz: 'baz' })
      })

      it('parses when one of the arguments is an arrow function', () => {
        function foo (fn = (a, b, c) => {}, ctx) {}

        assert.deepStrictEqual(getFunctionArguments(foo, ['fn', 'ctx']), { fn: 'fn', ctx: 'ctx' })
      })

      it('parses when one of the arguments is a function', () => {
        function foo (fn = function (a, b, c) {}, ctx) {}

        assert.deepStrictEqual(getFunctionArguments(foo, ['fn', 'ctx']), { fn: 'fn', ctx: 'ctx' })
      })
    })
  })

  describe('safeJsonParse', () => {
    it('parses valid JSON strings', () => {
      assert.deepStrictEqual(safeJsonParse('{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] })
    })

    it('returns the explicit fallback on malformed JSON', () => {
      assert.deepStrictEqual(safeJsonParse('{not json', {}), {})
    })

    it('returns the input string when no fallback is provided and parsing fails', () => {
      assert.strictEqual(safeJsonParse('{not json'), '{not json')
    })

    it('returns non-string inputs unchanged without parsing', () => {
      const obj = { already: 'parsed' }
      assert.strictEqual(safeJsonParse(obj), obj)
      assert.strictEqual(safeJsonParse(undefined), undefined)
      assert.strictEqual(safeJsonParse(null), null)
    })
  })

  describe('spanHasError', () => {
    let Span
    let tracer
    let ps

    before(() => {
      Span = require('../../src/opentracing/span')
      tracer = { _config: getConfig() }
      ps = {
        sample () {},
      }
    })

    it('returns false when there is no error', () => {
      const span = new Span(tracer, null, ps, {})
      assert.strictEqual(spanHasError(span), false)
    })

    it('returns true if the span has an "error" tag', () => {
      const span = new Span(tracer, null, ps, {})
      span.setTag('error', true)
      assert.strictEqual(spanHasError(span), true)
    })

    it('returns true if the span has the error properties as tags', () => {
      const err = new Error('boom')
      const span = new Span(tracer, null, ps, {})

      span.setTag('error.type', err.name)
      span.setTag('error.msg', err.message)
      span.setTag('error.stack', err.stack)

      assert.strictEqual(spanHasError(span), true)
    })
  })
})
