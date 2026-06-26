'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const { INPUT_PROMPT } = require('../../src/llmobs/constants/tags')
const { writeBridgeTags, findGenAIAncestorSpanId } = require('../../src/llmobs/util')

function unserializableObject () {
  const obj = {}
  obj.obj = obj
  return obj
}

describe('tagger', () => {
  let span
  let spanContext
  let Tagger
  let tagger
  let logger
  let util

  beforeEach(() => {
    spanContext = {
      _tags: {},
      _trace: { tags: {} },
      _traceId: { toBigInt () { return 0x1111111111111111n } },
      toTraceId () { return '00000000000000001111111111111111' },
      toSpanId () { return '2222222222222222' },
    }

    span = {
      context () { return spanContext },
      setTag (k, v) {
        this.context()._tags[k] = v
      },
    }

    // Pass real helpers through so bridge-tag logic is exercised end-to-end.
    // `findGenAIAncestorSpanId` is defaulted to a stub returning null so
    // existing tests get the "no gen_ai ancestor" branch; individual tests
    // can call `.returns(id)` on the stub to exercise suppression.
    util = {
      generateTraceId: sinon.stub().returns('0123'),
      writeBridgeTags,
      findGenAIAncestorSpanId: sinon.stub().returns(null),
    }

    logger = {
      warn: sinon.stub(),
    }

    Tagger = proxyquire('../../src/llmobs/tagger', {
      '../log': logger,
      './util': util,
    })
  })

  describe('without softFail', () => {
    beforeEach(() => {
      tagger = new Tagger({ llmobs: { enabled: true, mlApp: 'my-default-ml-app' } })
    })

    describe('registerLLMObsSpan', () => {
      it('will not set tags if llmobs is not enabled', () => {
        tagger = new Tagger({ llmobs: { enabled: false } })
        tagger.registerLLMObsSpan(span, 'llm')

        assert.deepStrictEqual(Tagger.tagMap.get(span), undefined)
      })

      it('tags an llm obs span with basic and default properties', () => {
        tagger.registerLLMObsSpan(span, { kind: 'workflow' })

        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'workflow',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined', // no parent id provided
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
        })
      })

      it('uses options passed in to set tags', () => {
        tagger.registerLLMObsSpan(span, {
          kind: 'llm',
          modelName: 'my-model',
          modelProvider: 'my-provider',
          sessionId: 'my-session',
          mlApp: 'my-app',
        })

        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.model_name': 'my-model',
          '_ml_obs.meta.model_provider': 'my-provider',
          '_ml_obs.session_id': 'my-session',
          '_ml_obs.meta.ml_app': 'my-app',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
        })
      })

      it('uses the name if provided', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm', name: 'my-span-name' })

        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.name': 'my-span-name',
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
        })
      })

      it('defaults parent id to undefined', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })

        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
        })
      })

      it('uses the parent span if provided to populate fields', () => {
        const parentSpan = {
          context () {
            return {
              toSpanId () { return '5678' },
            }
          },
        }

        Tagger.tagMap.set(parentSpan, {
          '_ml_obs.meta.ml_app': 'my-ml-app',
          '_ml_obs.session_id': 'my-session',
        })

        tagger.registerLLMObsSpan(span, { kind: 'llm', parent: parentSpan })

        // The parent carries no sampling decision, so the child inherits none
        // (it does not start a fresh decision mid-trace).
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-ml-app',
          '_ml_obs.session_id': 'my-session',
          '_ml_obs.llmobs_parent_id': '5678',
        })
      })

      it('uses the propagated trace id if provided', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })

        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
        })
      })

      it('uses the propagated parent id if provided', () => {
        spanContext._trace.tags['_dd.p.llmobs_parent_id'] = '-567'

        tagger.registerLLMObsSpan(span, { kind: 'llm' })

        // Propagated parent with no propagated sampling info: inherit none.
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': '-567',
        })
      })

      it('does not set span type if the LLMObs span kind is falsy', () => {
        tagger.registerLLMObsSpan(span, { kind: false })

        assert.strictEqual(Tagger.tagMap.get(span), undefined)
      })

      describe('sampling', () => {
        it('records a SAMPLED decision and the rate on a root span when sampleRate is 1', () => {
          tagger.registerLLMObsSpan(span, { kind: 'llm' })

          const tags = Tagger.tagMap.get(span)
          assert.strictEqual(tags['_ml_obs.sample_rate'], '1')
          assert.strictEqual(tags['_ml_obs.sampling_decision'], '1')
        })

        it('records a DROPPED decision on a root span when sampleRate is 0', () => {
          tagger = new Tagger({ llmobs: { enabled: true, mlApp: 'my-default-ml-app', sampleRate: 0 } })
          tagger.registerLLMObsSpan(span, { kind: 'llm' })

          const tags = Tagger.tagMap.get(span)
          assert.strictEqual(tags['_ml_obs.sample_rate'], '0')
          assert.strictEqual(tags['_ml_obs.sampling_decision'], '0')
        })

        it('truncates a longer rate to at most 6 decimals', () => {
          // 1/3 = 0.3333... which must be capped at 6 decimal places.
          tagger = new Tagger({ llmobs: { enabled: true, mlApp: 'my-default-ml-app', sampleRate: 1 / 3 } })
          tagger.registerLLMObsSpan(span, { kind: 'llm' })

          assert.strictEqual(Tagger.tagMap.get(span)['_ml_obs.sample_rate'], '0.333333')
        })

        it('strips trailing zeros from a fractional rate', () => {
          // 0.25 -> "0.250000" via toFixed(6), which must be stripped back to "0.25".
          tagger = new Tagger({ llmobs: { enabled: true, mlApp: 'my-default-ml-app', sampleRate: 0.25 } })
          tagger.registerLLMObsSpan(span, { kind: 'llm' })

          assert.strictEqual(Tagger.tagMap.get(span)['_ml_obs.sample_rate'], '0.25')
        })

        it('inherits the rate and decision from a local parent rather than re-sampling', () => {
          const parentSpan = { context () { return { toSpanId () { return '5678' } } } }
          // Parent was sampled out at 0.5; the child must keep that decision even
          // though this tagger would otherwise sample everything (rate 1).
          Tagger.tagMap.set(parentSpan, {
            '_ml_obs.meta.ml_app': 'my-ml-app',
            '_ml_obs.sample_rate': '0.5',
            '_ml_obs.sampling_decision': '0',
          })

          tagger.registerLLMObsSpan(span, { kind: 'llm', parent: parentSpan })

          const tags = Tagger.tagMap.get(span)
          assert.strictEqual(tags['_ml_obs.sample_rate'], '0.5')
          assert.strictEqual(tags['_ml_obs.sampling_decision'], '0')
        })

        it('inherits the rate and decision propagated from an upstream service', () => {
          spanContext._trace.tags['_dd.p.llmobs_parent_id'] = '5678'
          spanContext._trace.tags['_dd.p.llmobs_sr'] = '0.25'
          spanContext._trace.tags['_dd.p.llmobs_sd'] = '0'

          tagger.registerLLMObsSpan(span, { kind: 'llm' })

          const tags = Tagger.tagMap.get(span)
          assert.strictEqual(tags['_ml_obs.sample_rate'], '0.25')
          assert.strictEqual(tags['_ml_obs.sampling_decision'], '0')
        })

        it('rebuilds the sampler when the config rate changes at runtime (e.g. remote config)', () => {
          // The tagger reads sampleRate from config on each root decision, so a
          // mutation (such as a future remote config update) takes effect without
          // re-instantiating the tagger.
          const config = { llmobs: { enabled: true, mlApp: 'my-default-ml-app', sampleRate: 1 } }
          tagger = new Tagger(config)

          tagger.registerLLMObsSpan(span, { kind: 'llm' })
          assert.strictEqual(Tagger.tagMap.get(span)['_ml_obs.sampling_decision'], '1')

          config.llmobs.sampleRate = 0
          const nextSpan = { context () { return spanContext } }
          tagger.registerLLMObsSpan(nextSpan, { kind: 'llm' })

          const tags = Tagger.tagMap.get(nextSpan)
          assert.strictEqual(tags['_ml_obs.sample_rate'], '0')
          assert.strictEqual(tags['_ml_obs.sampling_decision'], '0')
        })

        it('makes no decision when an upstream LLMObs trace propagated no sampling info', () => {
          // Distributed trace from a service that predates sampling propagation:
          // there is an LLMObs parent context but no rate/decision. We must not
          // start a fresh (divergent) decision mid-trace — mirrors dd-trace-py.
          spanContext._trace.tags['_dd.p.llmobs_parent_id'] = '5678'

          tagger.registerLLMObsSpan(span, { kind: 'llm' })

          const tags = Tagger.tagMap.get(span)
          assert.strictEqual(tags['_ml_obs.sample_rate'], undefined)
          assert.strictEqual(tags['_ml_obs.sampling_decision'], undefined)
        })
      })

      it('uses the propagated mlApp over the global mlApp if both are provided', () => {
        spanContext._trace.tags['_dd.p.llmobs_ml_app'] = 'my-propagated-ml-app'

        tagger.registerLLMObsSpan(span, { kind: 'llm' })

        const tags = Tagger.tagMap.get(span)
        assert.strictEqual(tags['_ml_obs.meta.ml_app'], 'my-propagated-ml-app')
      })

      describe('with no global mlApp configured', () => {
        beforeEach(() => {
          tagger = new Tagger({ llmobs: { enabled: true } })
        })

        it('uses the mlApp from the propagated mlApp if no mlApp is provided', () => {
          spanContext._trace.tags['_dd.p.llmobs_ml_app'] = 'my-propagated-ml-app'

          tagger.registerLLMObsSpan(span, { kind: 'llm' })

          const tags = Tagger.tagMap.get(span)
          assert.strictEqual(tags['_ml_obs.meta.ml_app'], 'my-propagated-ml-app')
        })

        it('throws an error if no mlApp is provided and no propagated mlApp is provided and no service', () => {
          assert.throws(() => tagger.registerLLMObsSpan(span, { kind: 'llm' }))
        })

        it('uses the service name if no mlApp is provided and no propagated mlApp is provided', () => {
          tagger = new Tagger({ llmobs: { enabled: true }, service: 'my-service' })
          tagger.registerLLMObsSpan(span, { kind: 'llm' })

          const tags = Tagger.tagMap.get(span)
          assert.strictEqual(tags['_ml_obs.meta.ml_app'], 'my-service')
        })
      })

      describe('bridge tags for otel correlation', () => {
        it('writes llmobs_trace_id and llmobs_parent_id to _trace.tags after a successful register', () => {
          tagger.registerLLMObsSpan(span, { kind: 'workflow' })

          assert.strictEqual(spanContext._trace.tags.llmobs_trace_id, '00000000000000001111111111111111')
          assert.strictEqual(spanContext._trace.tags.llmobs_parent_id, '2222222222222222')
        })

        it('does not overwrite bridge tags when a second llmobs span registers on the same trace', () => {
          tagger.registerLLMObsSpan(span, { kind: 'workflow' })

          const secondSpanContext = {
            _tags: {},
            _trace: spanContext._trace, // sibling shares the local trace
            toTraceId () { return 'ffffffffffffffffffffffffffffffff' },
            toSpanId () { return '9999999999999999' },
          }
          const secondSpan = { context () { return secondSpanContext } }

          tagger.registerLLMObsSpan(secondSpan, { kind: 'task' })

          assert.strictEqual(spanContext._trace.tags.llmobs_trace_id, '00000000000000001111111111111111')
          assert.strictEqual(spanContext._trace.tags.llmobs_parent_id, '2222222222222222')
        })

        it('does not write bridge tags when llmobs is disabled', () => {
          tagger = new Tagger({ llmobs: { enabled: false } })
          tagger.registerLLMObsSpan(span, { kind: 'workflow' })

          assert.strictEqual(spanContext._trace.tags.llmobs_trace_id, undefined)
          assert.strictEqual(spanContext._trace.tags.llmobs_parent_id, undefined)
        })

        it('does not write bridge tags when no span kind is provided', () => {
          tagger.registerLLMObsSpan(span, {})

          assert.strictEqual(spanContext._trace.tags.llmobs_trace_id, undefined)
          assert.strictEqual(spanContext._trace.tags.llmobs_parent_id, undefined)
        })

        // MLOS-591: when the registering LLMObs span sits below an OTel
        // `gen_ai.*` ancestor in the APM trace, we suppress
        // `llmobs_parent_id` (which would otherwise tell the indexer to
        // reparent gen_ai ancestors under this leaf) and use the ancestor
        // as the SDK-emitted event's `parent_id` so the span renders under
        // the OTel workflow rather than as a parallel root.
        describe('with an OTel gen_ai.* APM ancestor', () => {
          beforeEach(() => {
            // Mutate the existing sinon stub in place; reassigning
            // `util.findGenAIAncestorSpanId` here would create a new stub
            // that Tagger's captured destructured reference doesn't see.
            util.findGenAIAncestorSpanId.returns('444444')
          })

          it('writes llmobs_trace_id but omits llmobs_parent_id', () => {
            tagger.registerLLMObsSpan(span, { kind: 'llm' })

            assert.strictEqual(spanContext._trace.tags.llmobs_trace_id, '00000000000000001111111111111111')
            assert.strictEqual(spanContext._trace.tags.llmobs_parent_id, undefined)
          })

          it('uses the gen_ai ancestor span_id as the SDK-emitted parent_id', () => {
            tagger.registerLLMObsSpan(span, { kind: 'llm' })

            const tags = Tagger.tagMap.get(span)
            assert.strictEqual(tags['_ml_obs.llmobs_parent_id'], '444444')
          })

          it('still prefers an explicit LLMObs storage parent over the gen_ai ancestor', () => {
            const sdkParent = { context () { return { toSpanId () { return '777777' } } } }
            Tagger.tagMap.set(sdkParent, { '_ml_obs.meta.ml_app': 'app' })

            tagger.registerLLMObsSpan(span, { kind: 'llm', parent: sdkParent })

            const tags = Tagger.tagMap.get(span)
            assert.strictEqual(tags['_ml_obs.llmobs_parent_id'], '777777')
          })
        })

        // Integration test: real findGenAIAncestorSpanId detection (no stub).
        // Verifies the full pipeline from APM span shape → detection → bridge
        // tag suppression → LLMObs event parent_id assignment.
        describe('with real gen_ai.* detection (unstubbed)', () => {
          let RealTagger
          let realTagger

          before(() => {
            RealTagger = proxyquire('../../src/llmobs/tagger', {
              '../log': { warn () {} },
              './util': {
                generateTraceId: sinon.stub().returns('0123'),
                writeBridgeTags,
                findGenAIAncestorSpanId,
              },
            })
            realTagger = new RealTagger({ llmobs: { enabled: true, mlApp: 'test-app' } })
          })

          it('detects a real gen_ai.* ancestor, suppresses llmobs_parent_id, and uses ancestor as event parent', () => {
            const genAISpanId = '333333333333333'
            const leafSpanId = '444444444444444'
            const traceTags = {}
            const traceStarted = []

            const genAISpanCtx = {
              _spanId: { toString: () => genAISpanId },
              _parentId: null,
              getTags () { return { 'gen_ai.operation.name': 'invoke_agent' } },
              _trace: { tags: traceTags, started: traceStarted },
            }
            const genAISpan = { context: () => genAISpanCtx }

            const leafTags = {}
            const leafSpanCtx = {
              _spanId: { toString: () => leafSpanId },
              _parentId: { toString: () => genAISpanId },
              getTags () { return leafTags },
              _trace: { tags: traceTags, started: traceStarted },
              toTraceId () { return '00000000000000009999999999999999' },
              toSpanId () { return leafSpanId },
            }
            const leafSpan = {
              context: () => leafSpanCtx,
              setTag (k, v) { leafTags[k] = v },
            }

            traceStarted.push(genAISpan, leafSpan)

            realTagger.registerLLMObsSpan(leafSpan, { kind: 'llm' })

            assert.strictEqual(traceTags.llmobs_trace_id, '00000000000000009999999999999999')
            assert.strictEqual(traceTags.llmobs_parent_id, undefined)
            assert.strictEqual(RealTagger.tagMap.get(leafSpan)['_ml_obs.llmobs_parent_id'], genAISpanId)
          })
        })
      })
    })

    describe('tagMetadata', () => {
      it('tags a span with metadata', () => {
        tagger._register(span)
        tagger.tagMetadata(span, { a: 'foo', b: 'bar' })
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.metadata': { a: 'foo', b: 'bar' },
        })
      })

      it('updates instead of overriding', () => {
        Tagger.tagMap.set(span, { '_ml_obs.meta.metadata': { a: 'foo' } })
        tagger.tagMetadata(span, { b: 'bar' })
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.metadata': { a: 'foo', b: 'bar' },
        })
      })
    })

    describe('tagMetrics', () => {
      it('tags a span with metrics', () => {
        tagger._register(span)
        tagger.tagMetrics(span, { a: 1, b: 2 })
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.metrics': { a: 1, b: 2 },
        })
      })

      it('tags maps token metric names appropriately', () => {
        tagger._register(span)
        tagger.tagMetrics(span, {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          foo: 10,
        })
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.metrics': { input_tokens: 1, output_tokens: 2, total_tokens: 3, foo: 10 },
        })
      })

      it('throws for non-number entries', () => {
        const metrics = {
          a: 1,
          b: 'foo',
          c: { depth: 1 },
          d: undefined,
        }
        tagger._register(span)
        assert.throws(() => tagger.tagMetrics(span, metrics))
      })

      it('updates instead of overriding', () => {
        Tagger.tagMap.set(span, { '_ml_obs.metrics': { a: 1 } })
        tagger.tagMetrics(span, { b: 2 })
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.metrics': { a: 1, b: 2 },
        })
      })
    })

    describe('tagToolDefinitions', () => {
      it('tags a span with a full tool definition', () => {
        const toolDefinitions = [
          {
            name: 'get_weather',
            description: 'Get the weather for a city.',
            schema: { type: 'object' },
            version: '1.0',
          },
        ]
        tagger._register(span)
        tagger.tagToolDefinitions(span, toolDefinitions)
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.tool_definitions': toolDefinitions,
        })
      })

      it('tags a span with only a name', () => {
        tagger._register(span)
        tagger.tagToolDefinitions(span, [{ name: 'get_time' }])
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.tool_definitions': [{ name: 'get_time' }],
        })
      })

      it('strips invalid optional fields but keeps the tool', () => {
        tagger._register(span)
        tagger.tagToolDefinitions(span, [
          { name: 'get_weather', description: 123, schema: 'not-an-object', version: 456 },
        ])
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.tool_definitions': [{ name: 'get_weather' }],
        })
      })

      it('skips items missing a name but keeps valid tools', () => {
        tagger._register(span)
        tagger.tagToolDefinitions(span, [
          { description: 'no name' },
          { name: 'valid_tool' },
        ])
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.tool_definitions': [{ name: 'valid_tool' }],
        })
      })

      it('throws for a non array input', () => {
        tagger._register(span)
        assert.throws(() => tagger.tagToolDefinitions(span, 'not an array'))
      })

      it('throws for an empty array', () => {
        tagger._register(span)
        assert.throws(() => tagger.tagToolDefinitions(span, []))
      })

      it('throws when all items are invalid', () => {
        tagger._register(span)
        assert.throws(() => tagger.tagToolDefinitions(span, [{ description: 'no name' }, 'not an object']))
      })
    })

    describe('tagSpanTags', () => {
      it('sets tags on a span', () => {
        const tags = { foo: 'bar' }
        tagger._register(span)
        tagger.tagSpanTags(span, tags)
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.tags': { foo: 'bar' },
        })
      })

      it('merges tags so they update', () => {
        Tagger.tagMap.set(span, { '_ml_obs.tags': { a: 1 } })
        const tags = { a: 2, b: 1 }
        tagger.tagSpanTags(span, tags)
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.tags': { a: 2, b: 1 },
        })
      })
    })

    describe('tagCostTags', () => {
      it('validates and sets cost tags', () => {
        tagger._register(span)
        tagger.tagSpanTags(span, { team: 'ml', feature: 'chatbot' })

        tagger.tagCostTags(span, ['team', 'feature'], 'annotate')

        assert.deepStrictEqual(
          Tagger.tagMap.get(span)['_ml_obs.meta.metadata._dd.cost_tags'],
          ['team', 'feature']
        )
      })

      it('dedupes cost tags across annotations', () => {
        tagger._register(span)
        tagger.tagSpanTags(span, { team: 'ml', feature: 'chatbot', project: 'alpha' })

        tagger.tagCostTags(span, ['team', 'feature', 'team'], 'annotate')
        tagger.tagCostTags(span, ['feature', 'project'], 'annotate')

        assert.deepStrictEqual(
          Tagger.tagMap.get(span)['_ml_obs.meta.metadata._dd.cost_tags'],
          ['team', 'feature', 'project']
        )
      })

      it('skips entries that do not reference an existing span tag', () => {
        tagger._register(span)
        tagger.tagSpanTags(span, { team: 'ml' })

        tagger.tagCostTags(span, ['team', 'missing'], 'annotate')

        assert.deepStrictEqual(
          Tagger.tagMap.get(span)['_ml_obs.meta.metadata._dd.cost_tags'],
          ['team']
        )
      })

      it('does not set cost tags for an empty list', () => {
        tagger._register(span)

        tagger.tagCostTags(span, [], 'annotate')

        assert.strictEqual(Tagger.tagMap.get(span)['_ml_obs.meta.metadata._dd.cost_tags'], undefined)
      })

      it('does not set cost tags when costTags is not an array', () => {
        tagger._register(span)

        tagger.tagCostTags(span, 'not-an-array', 'annotate')

        assert.strictEqual(Tagger.tagMap.get(span)['_ml_obs.meta.metadata._dd.cost_tags'], undefined)
      })
    })

    describe('tagLLMIO', () => {
      it('tags a span with llm io', () => {
        const inputData = [
          'you are an amazing assistant',
          { content: 'hello! my name is foobar' },
          { content: 'I am a robot', role: 'assistant' },
          { content: 'I am a human', role: 'user' },
          {},
        ]

        const outputData = 'Nice to meet you, human!'

        tagger._register(span)
        tagger.tagLLMIO(span, inputData, outputData)
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.input.messages': [
            { content: 'you are an amazing assistant', role: '' },
            { content: 'hello! my name is foobar', role: '' },
            { content: 'I am a robot', role: 'assistant' },
            { content: 'I am a human', role: 'user' },
            { content: '', role: '' },
          ],
          '_ml_obs.meta.output.messages': [{ content: 'Nice to meet you, human!', role: '' }],
        })
      })

      it('throws for a non-object message', () => {
        const messages = [
          5,
        ]

        assert.throws(() => tagger.tagLLMIO(span, messages, undefined))
      })

      it('throws for a non-string message content', () => {
        const messages = [
          { content: 5 },
        ]

        assert.throws(() => tagger.tagLLMIO(span, messages, undefined))
      })

      it('throws for a non-string message role', () => {
        const messages = [
          { content: 'a', role: 5 },
        ]

        assert.throws(() => tagger.tagLLMIO(span, messages, undefined))
      })

      describe('tagging tool calls appropriately', () => {
        it('tags a span with tool calls', () => {
          const inputData = [
            { content: 'hello', toolCalls: [{ name: 'tool1' }, { name: 'tool2', arguments: { a: 1, b: 2 } }] },
            { content: 'goodbye', toolCalls: [{ name: 'tool3' }] },
          ]
          const outputData = [
            { content: 'hi', toolCalls: [{ name: 'tool4' }] },
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, inputData, outputData)
          assert.deepStrictEqual(Tagger.tagMap.get(span), {
            '_ml_obs.meta.input.messages': [
              {
                content: 'hello',
                tool_calls: [{ name: 'tool1' }, { name: 'tool2', arguments: { a: 1, b: 2 } }],
                role: '',
              }, {
                content: 'goodbye',
                tool_calls: [{ name: 'tool3' }],
                role: '',
              }],
            '_ml_obs.meta.output.messages': [{ content: 'hi', tool_calls: [{ name: 'tool4' }], role: '' }],
          })
        })

        it('throws for a non-object tool call', () => {
          const messages = [
            { content: 'a', toolCalls: 5 },
          ]

          assert.throws(() => tagger.tagLLMIO(span, messages, undefined))
        })

        it('throws for a non-string tool name', () => {
          const messages = [
            { content: 'a', toolCalls: [{ name: 5 }] },
          ]

          assert.throws(() => tagger.tagLLMIO(span, messages, undefined))
        })

        it('throws for a non-object tool arguments', () => {
          const messages = [
            { content: 'a', toolCalls: [{ name: 'tool1', arguments: 5 }] },
          ]

          assert.throws(() => tagger.tagLLMIO(span, messages, undefined))
        })

        it('throws for a non-string tool id', () => {
          const messages = [
            { content: 'a', toolCalls: [{ name: 'tool1', toolId: 5 }] },
          ]

          assert.throws(() => tagger.tagLLMIO(span, messages, undefined))
        })

        it('throws for a non-string tool type', () => {
          const messages = [
            { content: 'a', toolCalls: [{ name: 'tool1', type: 5 }] },
          ]

          assert.throws(() => tagger.tagLLMIO(span, messages, undefined))
        })

        it('logs multiple errors if there are multiple errors for a message and filters it out', () => {
          const messages = [
            { content: 'a', toolCalls: [5, { name: 5, type: 7 }], role: 7 },
          ]

          assert.throws(() => tagger.tagLLMIO(span, messages, undefined))
        })
      })

      describe('tagging tool results appropriately', () => {
        it('tags a span with tool results', () => {
          const inputData = [
            { content: 'hello', toolResults: [{ name: '', result: 'foo', toolId: '123', type: 'tool_result' }] },
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, inputData)
          assert.deepStrictEqual(Tagger.tagMap.get(span), {
            '_ml_obs.meta.input.messages': [
              {
                content: 'hello',
                tool_results: [{ result: 'foo', tool_id: '123', name: '', type: 'tool_result' }],
                role: '',
              },
            ],
          })
        })

        it('throws for a non-object tool result', () => {
          const messages = [
            { content: 'a', toolResults: 5 },
          ]

          tagger._register(span)

          assert.throws(
            () => tagger.tagLLMIO(span, messages, undefined),
            { message: 'Tool result must be an object.' }
          )
        })

        it('throws for a non-string tool result', () => {
          const messages = [
            { content: 'a', toolResults: [{ result: 5 }] },
          ]

          tagger._register(span)

          assert.throws(
            () => tagger.tagLLMIO(span, messages, undefined),
            { message: '"Tool result" must be a string.' }
          )
        })

        it('throws for a non-string tool id', () => {
          const messages = [
            { content: 'a', toolResults: [{ result: 'foo', toolId: 123 }] },
          ]

          tagger._register(span)

          assert.throws(
            () => tagger.tagLLMIO(span, messages, undefined),
            { message: '"Tool ID" must be a string.' }
          )
        })

        it('throws for a non-string tool type', () => {
          const messages = [
            { content: 'a', toolResults: [{ result: 'foo', toolId: '123', type: 5 }] },
          ]

          tagger._register(span)

          assert.throws(
            () => tagger.tagLLMIO(span, messages, undefined),
            { message: '"Tool type" must be a string.' }
          )
        })
      })

      describe('tool message tagging', () => {
        it('tags a span with a tool message', () => {
          const messages = [
            { role: 'tool', content: 'The weather in San Francisco is sunny', toolId: '123' },
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, messages, undefined)
          assert.deepStrictEqual(Tagger.tagMap.get(span), {
            '_ml_obs.meta.input.messages': [
              { role: 'tool', content: 'The weather in San Francisco is sunny', tool_id: '123' },
            ],
          })
        })

        it('throws if the tool id is not a string', () => {
          const messages = [
            { role: 'tool', content: 'The weather in San Francisco is sunny', toolId: 123 },
          ]

          assert.throws(
            () => tagger.tagLLMIO(span, messages, undefined),
            { message: '"Tool ID" must be a string.' }
          )
        })

        it('logs a warning if the tool id is not associated with a tool role', () => {
          const messages = [
            { role: 'user', content: 'The weather in San Francisco is sunny', toolId: '123' },
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, messages, undefined)

          const messageTags = Tagger.tagMap.get(span)['_ml_obs.meta.input.messages']
          assert.ok(!('tool_id' in messageTags[0]))

          sinon.assert.calledOnce(logger.warn)
        })
      })
    })

    describe('tagEmbeddingIO', () => {
      it('tags a span with embedding io', () => {
        const inputData = [
          'my string document',
          { text: 'my object document' },
          { text: 'foo', name: 'bar' },
          { text: 'baz', id: 'qux' },
          { text: 'quux', score: 5 },
          { text: 'foo', name: 'bar', id: 'qux', score: 5 },
        ]
        const outputData = 'embedded documents'
        tagger._register(span)
        tagger.tagEmbeddingIO(span, inputData, outputData)
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.input.documents': [
            { text: 'my string document' },
            { text: 'my object document' },
            { text: 'foo', name: 'bar' },
            { text: 'baz', id: 'qux' },
            { text: 'quux', score: 5 },
            { text: 'foo', name: 'bar', id: 'qux', score: 5 }],
          '_ml_obs.meta.output.value': 'embedded documents',
        })
      })

      it('throws for a non-object document', () => {
        const documents = [
          5,
        ]

        assert.throws(() => tagger.tagEmbeddingIO(span, documents, undefined))
      })

      it('throws for a non-string document text', () => {
        const documents = [
          { text: 5 },
        ]

        assert.throws(() => tagger.tagEmbeddingIO(span, documents, undefined))
      })

      it('throws for a non-string document name', () => {
        const documents = [
          { text: 'a', name: 5 },
        ]

        assert.throws(() => tagger.tagEmbeddingIO(span, documents, undefined))
      })

      it('throws for a non-string document id', () => {
        const documents = [
          { text: 'a', id: 5 },
        ]

        assert.throws(() => tagger.tagEmbeddingIO(span, documents, undefined))
      })

      it('throws for a non-number document score', () => {
        const documents = [
          { text: 'a', score: '5' },
        ]

        assert.throws(() => tagger.tagEmbeddingIO(span, documents, undefined))
      })
    })

    describe('tagRetrievalIO', () => {
      it('tags a span with retrieval io', () => {
        const inputData = 'some query'
        const outputData = [
          'result 1',
          { text: 'result 2' },
          { text: 'foo', name: 'bar' },
          { text: 'baz', id: 'qux' },
          { text: 'quux', score: 5 },
          { text: 'foo', name: 'bar', id: 'qux', score: 5 },
        ]

        tagger._register(span)
        tagger.tagRetrievalIO(span, inputData, outputData)
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.input.value': 'some query',
          '_ml_obs.meta.output.documents': [
            { text: 'result 1' },
            { text: 'result 2' },
            { text: 'foo', name: 'bar' },
            { text: 'baz', id: 'qux' },
            { text: 'quux', score: 5 },
            { text: 'foo', name: 'bar', id: 'qux', score: 5 }],
        })
      })

      it('throws for malformed properties on documents', () => {
        const inputData = 'some query'
        const outputData = [
          true,
          { text: 5 },
          { text: 'foo', name: 5 },
          'hi',
          null,
          undefined,
        ]

        // specific cases of throwing tested with embedding inputs
        assert.throws(() => tagger.tagRetrievalIO(span, inputData, outputData))
      })
    })

    describe('tagTextIO', () => {
      it('tags a span with text io', () => {
        const inputData = { some: 'object' }
        const outputData = 'some text'
        tagger._register(span)
        tagger.tagTextIO(span, inputData, outputData)
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.input.value': '{"some":"object"}',
          '_ml_obs.meta.output.value': 'some text',
        })
      })

      it('throws when the value is not JSON serializable', () => {
        const data = unserializableObject()
        assert.throws(() => tagger.tagTextIO(span, data, 'output'))
      })
    })

    describe('changeKind', () => {
      it('changes the span kind', () => {
        tagger._register(span)
        tagger._setTag(span, '_ml_obs.meta.span.kind', 'old-kind')
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'old-kind',
        })
        tagger.changeKind(span, 'new-kind')
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'new-kind',
        })
      })

      it('sets the kind if it is not already set', () => {
        tagger._register(span)
        assert.deepStrictEqual(Tagger.tagMap.get(span), {})
        tagger.changeKind(span, 'new-kind')
        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'new-kind',
        })
      })
    })

    describe('tagPrompt', () => {
      it('tags a span with a string prompt template', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}} given {{fact}}.',
          variables: { city: 'San Francisco', fact: 'San Francisco is in California.' },
          id: 'city-prompt',
          version: '1.0.0',
          contextVariables: ['fact'],
          queryVariables: ['city'],
        })

        assert.deepEqual(Tagger.tagMap.get(span)[INPUT_PROMPT], {
          template: 'Write a poem about the weather in {{city}} given {{fact}}.',
          variables: { city: 'San Francisco', fact: 'San Francisco is in California.' },
          _dd_context_variable_keys: ['fact'],
          _dd_query_variable_keys: ['city'],
          version: '1.0.0',
          id: 'city-prompt',
        })
      })

      it('tags a span with a chat message template list', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        tagger.tagPrompt(span, {
          template: [
            { role: 'system', content: 'Please use the following information: \n\n{{context}}' },
            { role: 'user', content: 'Tell me a bit about {{subject}}.' },
          ],
          variables: { context: 'San Francisco is in California.', subject: 'San Francisco' },
          id: 'info-prompt',
          version: '1.0.0',
          contextVariables: ['context'],
          queryVariables: ['subject'],
        })

        assert.deepEqual(Tagger.tagMap.get(span)[INPUT_PROMPT], {
          chat_template: [
            { role: 'system', content: 'Please use the following information: \n\n{{context}}' },
            { role: 'user', content: 'Tell me a bit about {{subject}}.' },
          ],
          variables: { context: 'San Francisco is in California.', subject: 'San Francisco' },
          _dd_context_variable_keys: ['context'],
          _dd_query_variable_keys: ['subject'],
          version: '1.0.0',
          id: 'info-prompt',
        })
      })

      it('throws for a non-string and non-array prompt template', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 5,
        }), { message: 'Prompt template must be a string or an array of messages.' })
      })

      it('throws if the prompt template messages are not message objects', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: [
            { role: 'system', message: 'Please use the following information: \n\n{{context}}' },
            { role: 'user', content: 'Tell me a bit about {{subject}}.' },
          ],
        }), { message: 'Prompt chat template must be an array of objects with role and content properties.' })
      })

      it('defaults the prompt id', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
        })

        const promptId = Tagger.tagMap.get(span)[INPUT_PROMPT].id
        assert.equal(promptId, 'my-default-ml-app_unnamed-prompt')
      })

      it('throws for a non-string prompt id', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
          id: 123,
        }), { message: 'Prompt ID must be a string.' })
      })

      it('defaults the query context variables keys', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
        })

        const contextVariables = Tagger.tagMap.get(span)[INPUT_PROMPT]._dd_context_variable_keys
        assert.deepEqual(contextVariables, ['context'])
      })

      it('throws for a non-array prompt context variables keys', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
          contextVariables: 'context',
        }), { message: 'Prompt context variables keys must be an array.' })
      })

      it('throws for a non-string prompt context variables key', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
          contextVariables: [5],
        }), { message: 'Prompt context variables keys must be an array of strings.' })
      })

      it('defaults the query variables keys', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
        })

        const queryVariables = Tagger.tagMap.get(span)[INPUT_PROMPT]._dd_query_variable_keys
        assert.deepEqual(queryVariables, ['question'])
      })

      it('throws for a non-array prompt query variables key', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
          queryVariables: 'question',
        }), { message: 'Prompt query variables keys must be an array.' })
      })

      it('throws for a non-string prompt query variables key', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
          queryVariables: [5],
        }), { message: 'Prompt query variables keys must be an array of strings.' })
      })

      it('throws for a non-string prompt version', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
          version: 123,
        }), { message: 'Prompt version must be a string.' })
      })

      it('throws for a non-object prompt tags', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
          tags: 'tags',
        }), { message: 'Prompt tags must be an non-Map object.' })
      })

      it('throws for a non-string prompt tag value', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: 'San Francisco' },
          tags: { tag: new Date() },
        }), { message: 'Prompt tags must be an object of string key-value pairs.' })
      })

      it('throws for a non-object prompt variables', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: 'variables',
        }), { message: 'Prompt variables must be an non-Map object.' })
      })

      it('throws for a non-string prompt variable value', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })
        assert.throws(() => tagger.tagPrompt(span, {
          template: 'Write a poem about the weather in {{city}}.',
          variables: { city: new Date() },
        }), { message: 'Prompt variables must be an object of string key-value pairs.' })
      })
    })
  })

  describe('with softFail', () => {
    beforeEach(() => {
      tagger = new Tagger({ llmobs: { enabled: true, mlApp: 'my-default-ml-app' } }, true)
    })

    it('logs a warning when an unexpected value is encountered for text tagging', () => {
      const data = unserializableObject()
      tagger._register(span)
      tagger.tagTextIO(span, data, 'input')
      sinon.assert.calledOnce(logger.warn)
    })

    it('logs a warning when an unexpected value is encountered for metrics tagging', () => {
      const metrics = {
        a: 1,
        b: 'foo',
      }

      tagger._register(span)
      tagger.tagMetrics(span, metrics)
      sinon.assert.calledOnce(logger.warn)
    })

    describe('tagDocuments', () => {
      it('logs a warning when a document is not an object', () => {
        const data = [undefined]
        tagger._register(span)
        tagger.tagEmbeddingIO(span, data, undefined)
        sinon.assert.calledOnce(logger.warn)
      })

      it('logs multiple warnings otherwise', () => {
        const documents = [
          {
            text: 'a',
            name: 5,
            id: 7,
            score: '5',
          },
        ]

        tagger._register(span)
        tagger.tagEmbeddingIO(span, documents, undefined)
        assert.strictEqual(logger.warn.callCount, 3)
      })
    })

    describe('tagMessages', () => {
      it('logs a warning when a message is not an object', () => {
        const messages = [5]
        tagger._register(span)
        tagger.tagLLMIO(span, messages, undefined)
        sinon.assert.calledOnce(logger.warn)
      })

      it('logs multiple warnings otherwise', () => {
        const messages = [
          { content: 5, role: 5 },
        ]

        tagger._register(span)
        tagger.tagLLMIO(span, messages, undefined)
        assert.strictEqual(logger.warn.callCount, 2)
      })

      describe('tool call tagging', () => {
        it('logs a warning when a message tool call is not an object', () => {
          const messages = [
            { content: 'a', toolCalls: 5 },
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, messages, undefined)
          sinon.assert.calledOnce(logger.warn)
        })

        it('logs multiple warnings otherwise', () => {
          const messages = [
            {
              content: 'a',
              toolCalls: [
                {
                  name: 5,
                  arguments: 'not an object',
                  toolId: 5,
                  type: 5,
                },
              ],
              role: 7,
            },
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, messages, undefined)
          assert.strictEqual(logger.warn.callCount, 5) // 4 for tool call + 1 for role
        })
      })

      it('logs a warning if the tool id is not a string', () => {
        const messages = [
          { role: 'tool', content: 'The weather in San Francisco is sunny', toolId: 123 },
        ]

        tagger._register(span)
        tagger.tagLLMIO(span, messages, undefined)
        assert.ok(!('_ml_obs.meta.input.messages' in Tagger.tagMap.get(span)))
        sinon.assert.calledOnce(logger.warn)
      })
    })
  })
})
