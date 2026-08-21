'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')

const getConfig = require('../../src/config')
const {
  agentNameWireSafe,
  appendOptionalPropagatedTag,
  audioMimeTypeFromFormat,
  encodeUnicode,
  findGenAIAncestorSpanId,
  generateLlmObsTraceId,
  imagePartFromDataUri,
  isDataUri,
  llmObsTraceIdToWire,
  formatAudioPart,
  formatImagePart,
  getFunctionArguments,
  normalizeLlmObsTraceId,
  stripTagsetEntry,
  validateCostTags,
  safeJsonParse,
  validateKind,
  spanHasError,
  writeBridgeTags,
} = require('../../src/llmobs/util')

describe('util', () => {
  describe('LLMObs trace id propagation', () => {
    const traceId = '6a5f76e7000000001973227978d8110b'
    const wireTraceId = '141393847380800662846519802803680448779'

    it('converts a canonical hexadecimal trace id to decimal for propagation', () => {
      assert.strictEqual(llmObsTraceIdToWire(traceId), wireTraceId)
    })

    it('normalizes a propagated decimal trace id to canonical hexadecimal', () => {
      assert.strictEqual(normalizeLlmObsTraceId(wireTraceId), traceId)
    })

    it('preserves 64-bit decimal trace ids and converts the first 128-bit value', () => {
      assert.strictEqual(normalizeLlmObsTraceId('18446744073709551615'), '18446744073709551615')
      assert.strictEqual(
        normalizeLlmObsTraceId('18446744073709551616'),
        '00000000000000010000000000000000'
      )
    })

    it('preserves hexadecimal and custom trace ids while normalizing', () => {
      assert.strictEqual(normalizeLlmObsTraceId(traceId), traceId)
      assert.strictEqual(normalizeLlmObsTraceId('custom-trace-id'), 'custom-trace-id')
    })

    it('preserves custom trace ids for propagation', () => {
      assert.strictEqual(llmObsTraceIdToWire('custom-trace-id'), 'custom-trace-id')
    })

    it('returns undefined for empty trace ids', () => {
      assert.strictEqual(llmObsTraceIdToWire(''), undefined)
      assert.strictEqual(normalizeLlmObsTraceId(''), undefined)
    })

    it('generates a 128-bit trace id containing the start time', () => {
      const generatedTraceId = generateLlmObsTraceId(1_700_000_000_000)

      assert.match(generatedTraceId, /^[0-9a-f]{32}$/)
      assert.strictEqual(generatedTraceId.slice(0, 16), '6553f10000000000')
    })
  })

  describe('encodeUnicode', () => {
    it('should encode unicode characters', () => {
      assert.strictEqual(encodeUnicode('😀'), '\\ud83d\\ude00')
    })

    it('should encode only unicode characters in a string', () => {
      assert.strictEqual(encodeUnicode('test 😀'), 'test \\ud83d\\ude00')
    })
  })

  describe('agentNameWireSafe', () => {
    it('accepts a plain ascii name', () => {
      assert.strictEqual(agentNameWireSafe('my_agent'), true)
    })

    it('accepts a name containing "=" (legal in tagset values)', () => {
      assert.strictEqual(agentNameWireSafe('model=gpt4'), true)
    })

    it('rejects a name containing a comma (the tagset entry delimiter)', () => {
      assert.strictEqual(agentNameWireSafe('Researcher, v2'), false)
    })

    it('rejects a name with a byte outside 0x20-0x7E', () => {
      assert.strictEqual(agentNameWireSafe('café'), false)
      assert.strictEqual(agentNameWireSafe('tab\tname'), false)
    })

    it('accepts a name at the 256 byte cap and rejects the first byte over', () => {
      assert.strictEqual(agentNameWireSafe('a'.repeat(256)), true)
      assert.strictEqual(agentNameWireSafe('a'.repeat(257)), false)
    })
  })

  describe('appendOptionalPropagatedTag', () => {
    it('appends key=value to an empty tagset', () => {
      assert.strictEqual(appendOptionalPropagatedTag('', 'k', 'v'), 'k=v')
    })

    it('appends with a comma separator to a non-empty tagset', () => {
      assert.strictEqual(appendOptionalPropagatedTag('a=1', 'k', 'v'), 'a=1,k=v')
    })

    it('returns the original tagset when value is falsy', () => {
      assert.strictEqual(appendOptionalPropagatedTag('a=1', 'k', undefined), 'a=1')
      assert.strictEqual(appendOptionalPropagatedTag('a=1', 'k', ''), 'a=1')
    })

    it('returns the original tagset when the safeguard rejects the value', () => {
      assert.strictEqual(appendOptionalPropagatedTag('a=1', 'k', 'bad', () => false), 'a=1')
    })

    it('appends when the safeguard accepts the value', () => {
      assert.strictEqual(appendOptionalPropagatedTag('a=1', 'k', 'good', () => true), 'a=1,k=good')
    })

    it('skips the entry when it would exceed maxTagSetLength', () => {
      // 'a=1' is 3 chars; ',k=v' is 4 chars; total 7. Cap at 6 → skip.
      assert.strictEqual(appendOptionalPropagatedTag('a=1', 'k', 'v', null, 6), 'a=1')
    })

    it('appends when the entry fits exactly within maxTagSetLength', () => {
      // 'a=1' (3) + ',k=v' (4) = 7. Cap at 7 → fits.
      assert.strictEqual(appendOptionalPropagatedTag('a=1', 'k', 'v', null, 7), 'a=1,k=v')
    })
  })

  describe('stripTagsetEntry', () => {
    it('removes a key=value entry from the middle of the tagset', () => {
      assert.strictEqual(stripTagsetEntry('a=1,b=2,c=3', 'b'), 'a=1,c=3')
    })

    it('removes a key=value entry from the start of the tagset', () => {
      assert.strictEqual(stripTagsetEntry('b=2,c=3', 'b'), 'c=3')
    })

    it('removes a key=value entry from the end of the tagset', () => {
      assert.strictEqual(stripTagsetEntry('a=1,b=2', 'b'), 'a=1')
    })

    it('removes all occurrences of a duplicate key', () => {
      assert.strictEqual(stripTagsetEntry('k=old,a=1,k=new', 'k'), 'a=1')
    })

    it('returns the original tagset unchanged when the key is absent', () => {
      assert.strictEqual(stripTagsetEntry('a=1,c=3', 'b'), 'a=1,c=3')
    })

    it('returns empty string when stripping the only entry', () => {
      assert.strictEqual(stripTagsetEntry('k=v', 'k'), '')
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
    it('maps a format to audio/<format> by default', () => {
      assert.strictEqual(audioMimeTypeFromFormat('wav'), 'audio/wav')
      assert.strictEqual(audioMimeTypeFromFormat('opus'), 'audio/opus')
      assert.strictEqual(audioMimeTypeFromFormat('mp3'), 'audio/mp3')
    })

    it('prefers a provider override from mimeTypeLookup', () => {
      assert.strictEqual(audioMimeTypeFromFormat('mp3', { mp3: 'audio/mpeg' }), 'audio/mpeg')
      assert.strictEqual(audioMimeTypeFromFormat('wav', { mp3: 'audio/mpeg' }), 'audio/wav')
    })

    it('normalizes whitespace and case', () => {
      assert.strictEqual(audioMimeTypeFromFormat('  MP3 ', { mp3: 'audio/mpeg' }), 'audio/mpeg')
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

  describe('formatImagePart', () => {
    it('passes through an existing base64 string', () => {
      assert.deepStrictEqual(
        formatImagePart('iVBORw0KGgo=', 'image/png'),
        { mimeType: 'image/png', content: 'iVBORw0KGgo=' }
      )
    })

    it('base64-encodes Buffer and Uint8Array input', () => {
      const expected = Buffer.from('hello').toString('base64')
      assert.deepStrictEqual(
        formatImagePart(Buffer.from('hello'), 'image/png'),
        { mimeType: 'image/png', content: expected }
      )
      assert.deepStrictEqual(
        formatImagePart(new Uint8Array([104, 101, 108, 108, 111]), 'image/png'),
        { mimeType: 'image/png', content: expected }
      )
    })

    it('passes through non-binary, non-string input unchanged (tagger soft-skips it)', () => {
      assert.deepStrictEqual(formatImagePart(5, 'image/png'), { mimeType: 'image/png', content: 5 })
    })
  })

  describe('imagePartFromDataUri', () => {
    it('parses a base64 image data URI into an image part', () => {
      assert.deepStrictEqual(
        imagePartFromDataUri('data:image/png;base64,iVBORw0KGgo='),
        { mimeType: 'image/png', content: 'iVBORw0KGgo=' }
      )
    })

    it('lowercases the mime type and drops media-type parameters', () => {
      assert.deepStrictEqual(
        imagePartFromDataUri('data:IMAGE/JPEG;charset=utf-8;base64,/9j/4AAQ'),
        { mimeType: 'image/jpeg', content: '/9j/4AAQ' }
      )
    })

    it('keeps the payload verbatim, including base64 padding and whitespace', () => {
      // Whitespace is deliberately not stripped; see the note on imagePartFromDataUri.
      assert.deepStrictEqual(
        imagePartFromDataUri('data:image/gif;base64,R0lG\nODdh'),
        { mimeType: 'image/gif', content: 'R0lG\nODdh' }
      )
    })

    it('returns undefined for a remote URL rather than fetching it', () => {
      assert.strictEqual(imagePartFromDataUri('https://example.com/cat.png'), undefined)
      assert.strictEqual(imagePartFromDataUri('http://example.com/cat.png'), undefined)
    })

    it('returns undefined for a percent-encoded (non-base64) data URI', () => {
      assert.strictEqual(imagePartFromDataUri('data:image/svg+xml,%3Csvg%2F%3E'), undefined)
    })

    it('returns undefined for a non-image media type', () => {
      assert.strictEqual(imagePartFromDataUri('data:text/plain;base64,aGVsbG8='), undefined)
      assert.strictEqual(imagePartFromDataUri('data:audio/wav;base64,aGVsbG8='), undefined)
    })

    it('returns undefined for a data URI with no media type', () => {
      assert.strictEqual(imagePartFromDataUri('data:;base64,aGVsbG8='), undefined)
      assert.strictEqual(imagePartFromDataUri('data:image/;base64,aGVsbG8='), undefined)
    })

    it('returns undefined for a malformed data URI', () => {
      assert.strictEqual(imagePartFromDataUri('data:image/png;base64'), undefined)
      assert.strictEqual(imagePartFromDataUri('data:'), undefined)
      assert.strictEqual(imagePartFromDataUri(''), undefined)
    })

    it('returns undefined for an empty payload', () => {
      assert.strictEqual(imagePartFromDataUri('data:image/png;base64,'), undefined)
    })

    it('returns undefined when leading whitespace defeats the prefix', () => {
      // Guards against a mega-payload being emitted by a near-miss parse.
      assert.strictEqual(imagePartFromDataUri('  data:image/png;base64,iVBORw0KGgo='), undefined)
    })

    it('returns undefined for a non-string input', () => {
      assert.strictEqual(imagePartFromDataUri(undefined), undefined)
      assert.strictEqual(imagePartFromDataUri(5), undefined)
      assert.strictEqual(imagePartFromDataUri({ url: 'data:image/png;base64,iVBORw0KGgo=' }), undefined)
    })

    it('returns undefined for an oversized media type rather than emitting it as mime_type', () => {
      // Without a bound this parses, and the huge media type lands on the wire as `mime_type`,
      // bypassing the content cap entirely.
      const crafted = `data:image/${'a'.repeat(4096)};base64,iVBORw0KGgo=`
      assert.strictEqual(imagePartFromDataUri(crafted), undefined)
    })

    it('matches the scheme, base64 marker and media type case-insensitively', () => {
      // dd-trace-py's equivalent regex is re.IGNORECASE; a case-sensitive parse would reject these
      // and, on the Responses path, splice the whole payload into the message text instead.
      const expected = { mimeType: 'image/png', content: 'iVBORw0KGgo=' }
      assert.deepStrictEqual(imagePartFromDataUri('DATA:image/png;base64,iVBORw0KGgo='), expected)
      assert.deepStrictEqual(imagePartFromDataUri('data:image/png;BASE64,iVBORw0KGgo='), expected)
      assert.deepStrictEqual(imagePartFromDataUri('DATA:IMAGE/PNG;BASE64,iVBORw0KGgo='), expected)
    })
  })

  describe('isDataUri', () => {
    it('recognizes a data URI regardless of scheme case', () => {
      assert.strictEqual(isDataUri('data:image/png;base64,AAAA'), true)
      assert.strictEqual(isDataUri('DATA:image/png;base64,AAAA'), true)
      // Unparseable but still inline: the caller must emit a marker, never the raw payload.
      assert.strictEqual(isDataUri('data:image/svg+xml,%3Csvg%2F%3E'), true)
      assert.strictEqual(isDataUri('data:'), true)
    })

    it('rejects a remote reference, so its text is kept as-is', () => {
      assert.strictEqual(isDataUri('https://example.com/cat.png'), false)
      assert.strictEqual(isDataUri('file-abc123'), false)
      assert.strictEqual(isDataUri('  data:image/png;base64,AAAA'), false)
    })

    it('rejects non-strings', () => {
      assert.strictEqual(isDataUri(undefined), false)
      assert.strictEqual(isDataUri(5), false)
    })
  })
})
