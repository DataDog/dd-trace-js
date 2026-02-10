'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const { INPUT_PROMPT } = require('../../src/llmobs/constants/tags')

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
    }

    span = {
      context () { return spanContext },
      setTag (k, v) {
        this.context()._tags[k] = v
      },
    }

    util = {
      generateTraceId: sinon.stub().returns('0123'),
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
        })
      })

      it('uses the name if provided', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm', name: 'my-span-name' })

        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.name': 'my-span-name',
        })
      })

      it('defaults parent id to undefined', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })

        assert.deepStrictEqual(Tagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined',
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
        })
      })

      it('uses the propagated parent id if provided', () => {
        spanContext._trace.tags['_dd.p.llmobs_parent_id'] = '-567'

        tagger.registerLLMObsSpan(span, { kind: 'llm' })

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
