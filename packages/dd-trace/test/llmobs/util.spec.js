'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')

const getConfig = require('../../src/config')
const {
  audioMimeTypeFromFormat,
  encodeUnicode,
  findGenAIAncestorSpanId,
  formatAudioPart,
  getFunctionArguments,
  validateCostTags,
  safeJsonParse,
  validateKind,
  spanHasError,
  writeBridgeTags,
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

  describe('writeBridgeTags', () => {
    function makeSpan (traceTags = {}) {
      return {
        context () {
          return {
            _trace: { tags: traceTags },
            toTraceId () { return '00000000000000001111111111111111' },
            toSpanId () { return '2222222222222222' },
          }
        },
      }
    }

    it('writes llmobs_trace_id and llmobs_parent_id to _trace.tags', () => {
      const traceTags = {}
      writeBridgeTags(makeSpan(traceTags))
      assert.strictEqual(traceTags.llmobs_trace_id, '00000000000000001111111111111111')
      assert.strictEqual(traceTags.llmobs_parent_id, '2222222222222222')
    })

    it('does not overwrite bridge tags when already set', () => {
      const traceTags = { llmobs_trace_id: 'preexisting', llmobs_parent_id: 'preexisting' }
      writeBridgeTags(makeSpan(traceTags))
      assert.strictEqual(traceTags.llmobs_trace_id, 'preexisting')
      assert.strictEqual(traceTags.llmobs_parent_id, 'preexisting')
    })

    it('is a no-op when _trace.tags is absent', () => {
      const span = { context () { return { _trace: undefined } } }
      writeBridgeTags(span)
    })

    it('is a no-op when span is undefined', () => {
      writeBridgeTags(undefined)
    })

    it('omits llmobs_parent_id when includeParentId is false', () => {
      const traceTags = {}
      writeBridgeTags(makeSpan(traceTags), { includeParentId: false })
      assert.strictEqual(traceTags.llmobs_trace_id, '00000000000000001111111111111111')
      assert.strictEqual(traceTags.llmobs_parent_id, undefined)
    })
  })

  describe('findGenAIAncestorSpanId', () => {
    // Build a minimal Datadog-shaped span fixture: each span has `_spanId`,
    // optional `_parentId`, `_tags`, and shares the `_trace.started` array
    // so the helper can walk up the chain via `_parentId` lookup.
    function makeTrace (spanDefs) {
      const started = []
      const trace = { started, tags: {} }
      for (const def of spanDefs) {
        const tags = def.tags || {}
        started.push({
          context: () => ({
            _spanId: { toString: () => def.spanId },
            _parentId: def.parentId ? { toString: () => def.parentId } : null,
            getTags () { return tags },
            _trace: trace,
          }),
        })
      }
      return started
    }

    it('returns the nearest gen_ai.* ancestor span_id', () => {
      const [root, agent, workflow, leaf] = makeTrace([
        { spanId: '100', tags: {} }, // http.request
        { spanId: '200', parentId: '100', tags: { 'gen_ai.operation.name': 'invoke_agent' } },
        { spanId: '300', parentId: '200', tags: { 'gen_ai.operation.name': 'workflow' } },
        { spanId: '400', parentId: '300', tags: {} }, // the LLMObs leaf
      ])
      void root; void agent; void workflow
      assert.strictEqual(findGenAIAncestorSpanId(leaf), '300')
    })

    it('skips non-gen_ai ancestors and returns the first gen_ai.* match', () => {
      const [root, plain, agent, leaf] = makeTrace([
        { spanId: '100', tags: {} },
        { spanId: '200', parentId: '100', tags: { 'http.method': 'GET' } },
        { spanId: '300', parentId: '200', tags: { 'gen_ai.system': 'gemini' } },
        { spanId: '400', parentId: '300', tags: {} },
      ])
      void root; void plain; void agent
      assert.strictEqual(findGenAIAncestorSpanId(leaf), '300')
    })

    it('returns null when no ancestor has gen_ai.* tags', () => {
      const [root, plain, leaf] = makeTrace([
        { spanId: '100', tags: { 'service.name': 'web' } },
        { spanId: '200', parentId: '100', tags: { 'http.method': 'GET' } },
        { spanId: '300', parentId: '200', tags: {} },
      ])
      void root; void plain
      assert.strictEqual(findGenAIAncestorSpanId(leaf), null)
    })

    it('returns null when the span has no parent', () => {
      const [orphan] = makeTrace([
        { spanId: '100', tags: {} },
      ])
      assert.strictEqual(findGenAIAncestorSpanId(orphan), null)
    })

    it('is a no-op-safe when span has no context', () => {
      assert.strictEqual(findGenAIAncestorSpanId(undefined), null)
      assert.strictEqual(findGenAIAncestorSpanId({}), null)
    })
  })

  describe('audioMimeTypeFromFormat', () => {
    it('maps mp3 to audio/mpeg', () => {
      assert.strictEqual(audioMimeTypeFromFormat('mp3'), 'audio/mpeg')
    })

    it('maps other formats to audio/<format>', () => {
      assert.strictEqual(audioMimeTypeFromFormat('wav'), 'audio/wav')
      assert.strictEqual(audioMimeTypeFromFormat('opus'), 'audio/opus')
    })

    it('normalizes whitespace and case', () => {
      assert.strictEqual(audioMimeTypeFromFormat('  MP3 '), 'audio/mpeg')
      assert.strictEqual(audioMimeTypeFromFormat('WAV'), 'audio/wav')
    })

    it('defaults to audio/wav for missing or non-string formats', () => {
      assert.strictEqual(audioMimeTypeFromFormat(''), 'audio/wav')
      assert.strictEqual(audioMimeTypeFromFormat('   '), 'audio/wav')
      assert.strictEqual(audioMimeTypeFromFormat(undefined), 'audio/wav')
      assert.strictEqual(audioMimeTypeFromFormat(5), 'audio/wav')
    })
  })

  describe('formatAudioPart', () => {
    it('passes through an existing base64 string', () => {
      assert.deepStrictEqual(
        formatAudioPart('aGVsbG8=', 'audio/wav'),
        { mimeType: 'audio/wav', content: 'aGVsbG8=' }
      )
    })

    it('base64-encodes Buffer and Uint8Array input', () => {
      const expected = Buffer.from('hello').toString('base64')
      assert.deepStrictEqual(
        formatAudioPart(Buffer.from('hello'), 'audio/mpeg'),
        { mimeType: 'audio/mpeg', content: expected }
      )
      assert.deepStrictEqual(
        formatAudioPart(new Uint8Array([104, 101, 108, 108, 111]), 'audio/mpeg'),
        { mimeType: 'audio/mpeg', content: expected }
      )
    })

    it('passes through non-binary, non-string input unchanged (tagger soft-skips it)', () => {
      const result = formatAudioPart(5, 'audio/wav')
      assert.deepStrictEqual(result, { mimeType: 'audio/wav', content: 5 })
    })
  })
})
