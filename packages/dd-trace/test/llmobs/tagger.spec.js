'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

function unserializbleObject () {
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
      _trace: { tags: {} }
    }

    span = {
      context () { return spanContext },
      setTag (k, v) {
        this.context()._tags[k] = v
      }
    }

    util = {
      generateTraceId: sinon.stub().returns('0123')
    }

    logger = {
      warn: sinon.stub()
    }

    Tagger = proxyquire('../../src/llmobs/tagger', {
      '../log': logger,
      './util': util
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

        expect(Tagger.tagMap.get(span)).to.deep.equal(undefined)
      })

      it('tags an llm obs span with basic and default properties', () => {
        tagger.registerLLMObsSpan(span, { kind: 'workflow' })

        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'workflow',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined' // no parent id provided
        })
      })

      it('uses options passed in to set tags', () => {
        tagger.registerLLMObsSpan(span, {
          kind: 'llm',
          modelName: 'my-model',
          modelProvider: 'my-provider',
          sessionId: 'my-session',
          mlApp: 'my-app'
        })

        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.model_name': 'my-model',
          '_ml_obs.meta.model_provider': 'my-provider',
          '_ml_obs.session_id': 'my-session',
          '_ml_obs.meta.ml_app': 'my-app',
          '_ml_obs.llmobs_parent_id': 'undefined'
        })
      })

      it('uses the name if provided', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm', name: 'my-span-name' })

        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.name': 'my-span-name'
        })
      })

      it('defaults parent id to undefined', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })

        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined'
        })
      })

      it('uses the parent span if provided to populate fields', () => {
        const parentSpan = {
          context () {
            return {
              toSpanId () { return '5678' }
            }
          }
        }

        Tagger.tagMap.set(parentSpan, {
          '_ml_obs.meta.ml_app': 'my-ml-app',
          '_ml_obs.session_id': 'my-session'
        })

        tagger.registerLLMObsSpan(span, { kind: 'llm', parent: parentSpan })

        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-ml-app',
          '_ml_obs.session_id': 'my-session',
          '_ml_obs.llmobs_parent_id': '5678'
        })
      })

      it('uses the propagated trace id if provided', () => {
        tagger.registerLLMObsSpan(span, { kind: 'llm' })

        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': 'undefined'
        })
      })

      it('uses the propagated parent id if provided', () => {
        spanContext._trace.tags['_dd.p.llmobs_parent_id'] = '-567'

        tagger.registerLLMObsSpan(span, { kind: 'llm' })

        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'my-default-ml-app',
          '_ml_obs.llmobs_parent_id': '-567'
        })
      })

      it('does not set span type if the LLMObs span kind is falsy', () => {
        tagger.registerLLMObsSpan(span, { kind: false })

        expect(Tagger.tagMap.get(span)).to.be.undefined
      })

      it('uses the propagated mlApp over the global mlApp if both are provided', () => {
        spanContext._trace.tags['_dd.p.llmobs_ml_app'] = 'my-propagated-ml-app'

        tagger.registerLLMObsSpan(span, { kind: 'llm' })

        const tags = Tagger.tagMap.get(span)
        expect(tags['_ml_obs.meta.ml_app']).to.equal('my-propagated-ml-app')
      })

      describe('with no global mlApp configured', () => {
        beforeEach(() => {
          tagger = new Tagger({ llmobs: { enabled: true } })
        })

        it('uses the mlApp from the propagated mlApp if no mlApp is provided', () => {
          spanContext._trace.tags['_dd.p.llmobs_ml_app'] = 'my-propagated-ml-app'

          tagger.registerLLMObsSpan(span, { kind: 'llm' })

          const tags = Tagger.tagMap.get(span)
          expect(tags['_ml_obs.meta.ml_app']).to.equal('my-propagated-ml-app')
        })

        it('throws an error if no mlApp is provided and no propagated mlApp is provided', () => {
          expect(() => tagger.registerLLMObsSpan(span, { kind: 'llm' })).to.throw()
        })
      })
    })

    describe('tagMetadata', () => {
      it('tags a span with metadata', () => {
        tagger._register(span)
        tagger.tagMetadata(span, { a: 'foo', b: 'bar' })
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.metadata': { a: 'foo', b: 'bar' }
        })
      })

      it('updates instead of overriding', () => {
        Tagger.tagMap.set(span, { '_ml_obs.meta.metadata': { a: 'foo' } })
        tagger.tagMetadata(span, { b: 'bar' })
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.metadata': { a: 'foo', b: 'bar' }
        })
      })
    })

    describe('tagMetrics', () => {
      it('tags a span with metrics', () => {
        tagger._register(span)
        tagger.tagMetrics(span, { a: 1, b: 2 })
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.metrics': { a: 1, b: 2 }
        })
      })

      it('tags maps token metric names appropriately', () => {
        tagger._register(span)
        tagger.tagMetrics(span, {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          foo: 10
        })
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.metrics': { input_tokens: 1, output_tokens: 2, total_tokens: 3, foo: 10 }
        })
      })

      it('throws for non-number entries', () => {
        const metrics = {
          a: 1,
          b: 'foo',
          c: { depth: 1 },
          d: undefined
        }
        tagger._register(span)
        expect(() => tagger.tagMetrics(span, metrics)).to.throw()
      })

      it('updates instead of overriding', () => {
        Tagger.tagMap.set(span, { '_ml_obs.metrics': { a: 1 } })
        tagger.tagMetrics(span, { b: 2 })
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.metrics': { a: 1, b: 2 }
        })
      })
    })

    describe('tagSpanTags', () => {
      it('sets tags on a span', () => {
        const tags = { foo: 'bar' }
        tagger._register(span)
        tagger.tagSpanTags(span, tags)
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.tags': { foo: 'bar' }
        })
      })

      it('merges tags so they update', () => {
        Tagger.tagMap.set(span, { '_ml_obs.tags': { a: 1 } })
        const tags = { a: 2, b: 1 }
        tagger.tagSpanTags(span, tags)
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.tags': { a: 2, b: 1 }
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
          {}
        ]

        const outputData = 'Nice to meet you, human!'

        tagger._register(span)
        tagger.tagLLMIO(span, inputData, outputData)
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.input.messages': [
            { content: 'you are an amazing assistant' },
            { content: 'hello! my name is foobar' },
            { content: 'I am a robot', role: 'assistant' },
            { content: 'I am a human', role: 'user' },
            { content: '' }
          ],
          '_ml_obs.meta.output.messages': [{ content: 'Nice to meet you, human!' }]
        })
      })

      it('throws for a non-object message', () => {
        const messages = [
          5
        ]

        expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
      })

      it('throws for a non-string message content', () => {
        const messages = [
          { content: 5 }
        ]

        expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
      })

      it('throws for a non-string message role', () => {
        const messages = [
          { content: 'a', role: 5 }
        ]

        expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
      })

      describe('tagging tool calls appropriately', () => {
        it('tags a span with tool calls', () => {
          const inputData = [
            { content: 'hello', toolCalls: [{ name: 'tool1' }, { name: 'tool2', arguments: { a: 1, b: 2 } }] },
            { content: 'goodbye', toolCalls: [{ name: 'tool3' }] }
          ]
          const outputData = [
            { content: 'hi', toolCalls: [{ name: 'tool4' }] }
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, inputData, outputData)
          expect(Tagger.tagMap.get(span)).to.deep.equal({
            '_ml_obs.meta.input.messages': [
              {
                content: 'hello',
                tool_calls: [{ name: 'tool1' }, { name: 'tool2', arguments: { a: 1, b: 2 } }]
              }, {
                content: 'goodbye',
                tool_calls: [{ name: 'tool3' }]
              }],
            '_ml_obs.meta.output.messages': [{ content: 'hi', tool_calls: [{ name: 'tool4' }] }]
          })
        })

        it('throws for a non-object tool call', () => {
          const messages = [
            { content: 'a', toolCalls: 5 }
          ]

          expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
        })

        it('throws for a non-string tool name', () => {
          const messages = [
            { content: 'a', toolCalls: [{ name: 5 }] }
          ]

          expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
        })

        it('throws for a non-object tool arguments', () => {
          const messages = [
            { content: 'a', toolCalls: [{ name: 'tool1', arguments: 5 }] }
          ]

          expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
        })

        it('throws for a non-string tool id', () => {
          const messages = [
            { content: 'a', toolCalls: [{ name: 'tool1', toolId: 5 }] }
          ]

          expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
        })

        it('throws for a non-string tool type', () => {
          const messages = [
            { content: 'a', toolCalls: [{ name: 'tool1', type: 5 }] }
          ]

          expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
        })

        it('logs multiple errors if there are multiple errors for a message and filters it out', () => {
          const messages = [
            { content: 'a', toolCalls: [5, { name: 5, type: 7 }], role: 7 }
          ]

          expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
        })
      })

      describe('tool message tagging', () => {
        it('tags a span with a tool message', () => {
          const messages = [
            { role: 'tool', content: 'The weather in San Francisco is sunny', toolId: '123' }
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, messages, undefined)
          expect(Tagger.tagMap.get(span)).to.deep.equal({
            '_ml_obs.meta.input.messages': [
              { role: 'tool', content: 'The weather in San Francisco is sunny', tool_id: '123' }
            ]
          })
        })

        it('throws if the tool id is not a string', () => {
          const messages = [
            { role: 'tool', content: 'The weather in San Francisco is sunny', toolId: 123 }
          ]

          expect(() => tagger.tagLLMIO(span, messages, undefined)).to.throw()
        })

        it('logs a warning if the tool id is not associated with a tool role', () => {
          const messages = [
            { role: 'user', content: 'The weather in San Francisco is sunny', toolId: '123' }
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, messages, undefined)

          const messageTags = Tagger.tagMap.get(span)['_ml_obs.meta.input.messages']
          expect(messageTags[0]).to.not.have.property('tool_id')

          expect(logger.warn).to.have.been.calledOnce
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
          { text: 'foo', name: 'bar', id: 'qux', score: 5 }
        ]
        const outputData = 'embedded documents'
        tagger._register(span)
        tagger.tagEmbeddingIO(span, inputData, outputData)
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.input.documents': [
            { text: 'my string document' },
            { text: 'my object document' },
            { text: 'foo', name: 'bar' },
            { text: 'baz', id: 'qux' },
            { text: 'quux', score: 5 },
            { text: 'foo', name: 'bar', id: 'qux', score: 5 }],
          '_ml_obs.meta.output.value': 'embedded documents'
        })
      })

      it('throws for a non-object document', () => {
        const documents = [
          5
        ]

        expect(() => tagger.tagEmbeddingIO(span, documents, undefined)).to.throw()
      })

      it('throws for a non-string document text', () => {
        const documents = [
          { text: 5 }
        ]

        expect(() => tagger.tagEmbeddingIO(span, documents, undefined)).to.throw()
      })

      it('throws for a non-string document name', () => {
        const documents = [
          { text: 'a', name: 5 }
        ]

        expect(() => tagger.tagEmbeddingIO(span, documents, undefined)).to.throw()
      })

      it('throws for a non-string document id', () => {
        const documents = [
          { text: 'a', id: 5 }
        ]

        expect(() => tagger.tagEmbeddingIO(span, documents, undefined)).to.throw()
      })

      it('throws for a non-number document score', () => {
        const documents = [
          { text: 'a', score: '5' }
        ]

        expect(() => tagger.tagEmbeddingIO(span, documents, undefined)).to.throw()
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
          { text: 'foo', name: 'bar', id: 'qux', score: 5 }
        ]

        tagger._register(span)
        tagger.tagRetrievalIO(span, inputData, outputData)
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.input.value': 'some query',
          '_ml_obs.meta.output.documents': [
            { text: 'result 1' },
            { text: 'result 2' },
            { text: 'foo', name: 'bar' },
            { text: 'baz', id: 'qux' },
            { text: 'quux', score: 5 },
            { text: 'foo', name: 'bar', id: 'qux', score: 5 }]
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
          undefined
        ]

        // specific cases of throwing tested with embedding inputs
        expect(() => tagger.tagRetrievalIO(span, inputData, outputData)).to.throw()
      })
    })

    describe('tagTextIO', () => {
      it('tags a span with text io', () => {
        const inputData = { some: 'object' }
        const outputData = 'some text'
        tagger._register(span)
        tagger.tagTextIO(span, inputData, outputData)
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.input.value': '{"some":"object"}',
          '_ml_obs.meta.output.value': 'some text'
        })
      })

      it('throws when the value is not JSON serializable', () => {
        const data = unserializbleObject()
        expect(() => tagger.tagTextIO(span, data, 'output')).to.throw()
      })
    })

    describe('changeKind', () => {
      it('changes the span kind', () => {
        tagger._register(span)
        tagger._setTag(span, '_ml_obs.meta.span.kind', 'old-kind')
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'old-kind'
        })
        tagger.changeKind(span, 'new-kind')
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'new-kind'
        })
      })

      it('sets the kind if it is not already set', () => {
        tagger._register(span)
        expect(Tagger.tagMap.get(span)).to.deep.equal({})
        tagger.changeKind(span, 'new-kind')
        expect(Tagger.tagMap.get(span)).to.deep.equal({
          '_ml_obs.meta.span.kind': 'new-kind'
        })
      })
    })
  })

  describe('with softFail', () => {
    beforeEach(() => {
      tagger = new Tagger({ llmobs: { enabled: true, mlApp: 'my-default-ml-app' } }, true)
    })

    it('logs a warning when an unexpected value is encountered for text tagging', () => {
      const data = unserializbleObject()
      tagger._register(span)
      tagger.tagTextIO(span, data, 'input')
      expect(logger.warn).to.have.been.calledOnce
    })

    it('logs a warning when an unexpected value is encountered for metrics tagging', () => {
      const metrics = {
        a: 1,
        b: 'foo'
      }

      tagger._register(span)
      tagger.tagMetrics(span, metrics)
      expect(logger.warn).to.have.been.calledOnce
    })

    describe('tagDocuments', () => {
      it('logs a warning when a document is not an object', () => {
        const data = [undefined]
        tagger._register(span)
        tagger.tagEmbeddingIO(span, data, undefined)
        expect(logger.warn).to.have.been.calledOnce
      })

      it('logs multiple warnings otherwise', () => {
        const documents = [
          {
            text: 'a',
            name: 5,
            id: 7,
            score: '5'
          }
        ]

        tagger._register(span)
        tagger.tagEmbeddingIO(span, documents, undefined)
        expect(logger.warn.callCount).to.equal(3)
      })
    })

    describe('tagMessages', () => {
      it('logs a warning when a message is not an object', () => {
        const messages = [5]
        tagger._register(span)
        tagger.tagLLMIO(span, messages, undefined)
        expect(logger.warn).to.have.been.calledOnce
      })

      it('logs multiple warnings otherwise', () => {
        const messages = [
          { content: 5, role: 5 }
        ]

        tagger._register(span)
        tagger.tagLLMIO(span, messages, undefined)
        expect(logger.warn.callCount).to.equal(2)
      })

      describe('tool call tagging', () => {
        it('logs a warning when a message tool call is not an object', () => {
          const messages = [
            { content: 'a', toolCalls: 5 }
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, messages, undefined)
          expect(logger.warn).to.have.been.calledOnce
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
                  type: 5
                }
              ],
              role: 7
            }
          ]

          tagger._register(span)
          tagger.tagLLMIO(span, messages, undefined)
          expect(logger.warn.callCount).to.equal(5) // 4 for tool call + 1 for role
        })
      })

      it('logs a warning when a tool message is not associated with a tool role', () => {
        const messages = [
          { role: 'user', content: 'The weather in San Francisco is sunny', toolId: '123' }
        ]

        tagger._register(span)
        tagger.tagLLMIO(span, messages, undefined)

        const messageTags = Tagger.tagMap.get(span)['_ml_obs.meta.input.messages']
        expect(messageTags[0]).to.not.have.property('tool_id')

        expect(logger.warn).to.have.been.calledOnce
      })
    })
  })
})
