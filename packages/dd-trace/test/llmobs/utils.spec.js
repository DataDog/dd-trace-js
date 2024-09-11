'use strict'

const {
  validKind,
  getName,
  getLLMObsParentId,
  isLLMSpan,
  getMlApp,
  getSessionId,
  encodeUnicode,
  getFunctionArguments
} = require('../../src/llmobs/util')

const { SPAN_TYPE } = require('../../../../ext/tags')
const { PARENT_ID_KEY, PROPAGATED_PARENT_ID_KEY, ML_APP, SESSION_ID } = require('../../src/llmobs/constants')

describe('util', () => {
  describe('validKind', () => {
    for (const kind of ['llm', 'agent', 'task', 'tool', 'workflow', 'retrieval', 'embedding']) {
      it(`should return true for valid kind: ${kind}`, () => {
        expect(validKind(kind)).to.equal(true)
      })
    }

    it('should return false for an empty string', () => {
      expect(validKind('')).to.equal(false)
    })

    it('should return false for an invalid kind', () => {
      expect(validKind('invalid')).to.equal(false)
    })

    it('should return false for an undefined kind', () => {
      expect(validKind(undefined)).to.equal(false)
    })
  })

  describe('getName', () => {
    it('should return the name from options', () => {
      expect(getName('llm', { name: 'test' })).to.equal('test')
    })

    it('should return the name from the function', () => {
      expect(getName('llm', {}, function test () {})).to.equal('test')
    })

    it('should return the kind', () => {
      expect(getName('llm')).to.equal('llm')
    })
  })

  describe('getLLMObsParentId', () => {
    it('should return undefined for an undefined span', () => {
      expect(getLLMObsParentId(undefined)).to.equal(undefined)
    })

    it('should return the parent ID from the span context', () => {
      const span = { context: () => ({ _tags: { [PARENT_ID_KEY]: '1234' } }) }
      expect(getLLMObsParentId(span)).to.equal('1234')
    })

    it('should return the span ID from the nearest LLM span', () => {
      const span = {
        context: () => ({ _tags: {} }),
        _store: {
          span: {
            context: () => ({
              toSpanId: () => '1234',
              _tags: {} // apm span
            }),
            _store: {
              span: {
                context: () => ({
                  toSpanId: () => '5678',
                  _tags: { [SPAN_TYPE]: 'llm' }
                })
              }
            }
          }
        }
      }
      expect(getLLMObsParentId(span)).to.equal('5678')
    })

    it('should return the propagated parent ID from the span context', () => {
      const span = {
        context: () => ({ _tags: {}, _trace: { tags: { [PROPAGATED_PARENT_ID_KEY]: '1234' } } })
      }

      expect(getLLMObsParentId(span)).to.equal('1234')
    })
  })

  describe('isLLMSpan', () => {
    it('should return false for an undefined span', () => {
      expect(isLLMSpan(undefined)).to.equal(false)
    })

    it('should return false for a span without a SPAN_KIND tag', () => {
      const span = { context: () => ({ _tags: {} }) }
      expect(isLLMSpan(span)).to.equal(false)
    })

    it('should return false for a span with an invalid span type', () => {
      const span = { context: () => ({ _tags: { [SPAN_TYPE]: 'invalid' } }) }
      expect(isLLMSpan(span)).to.equal(false)
    })

    for (const spanType of ['llm', 'openai']) {
      it(`should return true for a span with a valid span type: ${spanType}`, () => {
        const span = { context: () => ({ _tags: { [SPAN_TYPE]: spanType } }) }
        expect(isLLMSpan(span)).to.equal(true)
      })
    }
  })

  describe('getMlApp', () => {
    it('should return the ml app from the span context', () => {
      const span = { context: () => ({ _tags: { [ML_APP]: 'test' } }) }
      expect(getMlApp(span)).to.equal('test')
    })

    it('should return the ml app from the nearest LLM span', () => {
      const span = {
        context: () => ({ _tags: {} }),
        _store: {
          span: {
            context: () => ({
              _tags: {} // apm span
            }),
            _store: {
              span: {
                context: () => ({
                  _tags: { [SPAN_TYPE]: 'llm', [ML_APP]: 'test' }
                })
              }
            }
          }
        }
      }
      expect(getMlApp(span)).to.equal('test')
    })

    it('should return the default ml app', () => {
      const span = { context: () => ({ _tags: { [SPAN_TYPE]: 'llm' } }) }
      expect(getMlApp(span, 'default')).to.equal('default')
    })
  })

  describe('getSessionId', () => {
    it('should return the session ID from the span context', () => {
      const span = { context: () => ({ _tags: { [SESSION_ID]: 'test' } }) }
      expect(getSessionId(span)).to.equal('test')
    })

    it('should return the session ID from the nearest LLM span', () => {
      const span = {
        context: () => ({ _tags: {} }),
        _store: {
          span: {
            context: () => ({
              _tags: {} // apm span
            }),
            _store: {
              span: {
                context: () => ({
                  _tags: { [SPAN_TYPE]: 'llm', [SESSION_ID]: '1' }
                })
              }
            }
          }
        }
      }
      expect(getSessionId(span)).to.equal('1')
    })
  })

  describe('encodeUnicode', () => {
    it('should encode unicode characters', () => {
      expect(encodeUnicode('😀')).to.equal('\\ud83d\\ude00')
    })

    it('should encode only unicode characters in a string', () => {
      expect(encodeUnicode('test 😀')).to.equal('test \\ud83d\\ude00')
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
})
