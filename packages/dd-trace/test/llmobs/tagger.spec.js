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

    tagger = new Tagger({ llmobs: { mlApp: 'my-default-ml-app' } })
  })

  describe('setLLMObsSpanTags', () => {
    it('tags an llm obs span with basic and default properties', () => {
      tagger.setLLMObsSpanTags(span, 'workflow')

      expect(span.context()._tags).to.deep.equal({
        'span.type': 'llm',
        '_ml_obs.meta.span.kind': 'workflow',
        '_ml_obs.meta.ml_app': 'my-default-ml-app',
        '_ml_obs.llmobs_parent_id': 'undefined' // no parent id provided
      })
    })

    it('uses options passed in to set tags', () => {
      tagger.setLLMObsSpanTags(span, 'llm', {
        modelName: 'my-model',
        modelProvider: 'my-provider',
        sessionId: 'my-session',
        mlApp: 'my-app'
      })

      expect(span.context()._tags).to.deep.equal({
        'span.type': 'llm',
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.model_name': 'my-model',
        '_ml_obs.meta.model_provider': 'my-provider',
        '_ml_obs.session_id': 'my-session',
        '_ml_obs.meta.ml_app': 'my-app',
        '_ml_obs.llmobs_parent_id': 'undefined'
      })
    })

    it('uses the name if provided', () => {
      tagger.setLLMObsSpanTags(span, 'llm', {}, 'my-span-name')

      expect(span.context()._tags).to.deep.equal({
        'span.type': 'llm',
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.ml_app': 'my-default-ml-app',
        '_ml_obs.llmobs_parent_id': 'undefined',
        '_ml_obs.name': 'my-span-name'
      })
    })

    it('defaults parent id to undefined', () => {
      tagger.setLLMObsSpanTags(span, 'llm')

      expect(span.context()._tags).to.deep.equal({
        'span.type': 'llm',
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.ml_app': 'my-default-ml-app',
        '_ml_obs.llmobs_parent_id': 'undefined'
      })
    })

    it('uses the parent span if provided to populate fields', () => {
      const parentSpan = {
        context () {
          return {
            _tags: {
              '_ml_obs.meta.ml_app': 'my-ml-app',
              '_ml_obs.session_id': 'my-session'
            },
            toSpanId () { return '5678' }
          }
        }
      }
      tagger.setLLMObsSpanTags(span, 'llm', { parentLLMObsSpan: parentSpan })

      expect(span.context()._tags).to.deep.equal({
        'span.type': 'llm',
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.ml_app': 'my-ml-app',
        '_ml_obs.session_id': 'my-session',
        '_ml_obs.llmobs_parent_id': '5678'
      })
    })

    it('uses the propagated trace id if provided', () => {
      tagger.setLLMObsSpanTags(span, 'llm')

      expect(span.context()._tags).to.deep.equal({
        'span.type': 'llm',
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.ml_app': 'my-default-ml-app',
        '_ml_obs.llmobs_parent_id': 'undefined'
      })
    })

    it('uses the propagated parent id if provided', () => {
      spanContext._trace.tags['_dd.p.llmobs_parent_id'] = '-567'

      tagger.setLLMObsSpanTags(span, 'llm')

      expect(span.context()._tags).to.deep.equal({
        'span.type': 'llm',
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.ml_app': 'my-default-ml-app',
        '_ml_obs.llmobs_parent_id': '-567'
      })
    })

    it('does not set span type if the LLMObs span kind is falsy', () => {
      tagger.setLLMObsSpanTags(span, false)

      expect(span.context()._tags['span.type']).to.be.undefined
    })
  })

  describe('tagMetadata', () => {
    it('tags a span with metadata', () => {
      tagger.tagMetadata(span, { a: 'foo', b: 'bar' })
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.metadata': '{"a":"foo","b":"bar"}'
      })
    })

    it('logs when metadata is not JSON serializable', () => {
      const metadata = unserializbleObject()
      tagger.tagMetadata(span, metadata)
      expect(logger.warn).to.have.been.calledOnce
    })
  })

  describe('tagMetrics', () => {
    it('tags a span with metrics', () => {
      tagger.tagMetadata(span, { a: 1, b: 2 })
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.metadata': '{"a":1,"b":2}'
      })
    })

    it('logs when metrics is not JSON serializable', () => {
      const metadata = unserializbleObject()
      tagger.tagMetadata(span, metadata)
      expect(logger.warn).to.have.been.calledOnce
    })
  })

  describe('tagSpanTags', () => {
    it('sets tags on a span', () => {
      const tags = { foo: 'bar' }
      tagger.tagSpanTags(span, tags)
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.tags': '{"foo":"bar"}'
      })
    })

    it('merges tags so they do not overwrite', () => {
      span.context()._tags['_ml_obs.tags'] = '{"a":1}'
      const tags = { a: 2, b: 1 }
      tagger.tagSpanTags(span, tags)
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.tags': '{"a":1,"b":1}'
      })
    })
  })

  describe('tagLLMIO', () => {
    it('tags a span with llm io', () => {
      const inputData = [
        'you are an amazing assistant',
        { content: 'hello! my name is foobar' },
        { content: 'I am a robot', role: 'assistant' },
        { content: 'I am a human', role: 'user' }
      ]

      const outputData = 'Nice to meet you, human!'

      tagger.tagLLMIO(span, inputData, outputData)
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.messages': '[{"content":"you are an amazing assistant"},' +
        '{"content":"hello! my name is foobar"},{"content":"I am a robot","role":"assistant"},' +
        '{"content":"I am a human","role":"user"}]',
        '_ml_obs.meta.output.messages': '[{"content":"Nice to meet you, human!"}]'
      })
    })

    it('filters out non-string properties on messages', () => {
      const inputData = [
        true,
        { content: 5 },
        { content: 'hello', role: 5 },
        'hi'
      ]
      const outputData = [
        undefined,
        null,
        { content: 5 },
        { content: 'goodbye', role: 5 }
      ]
      tagger.tagLLMIO(span, inputData, outputData)
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.messages': '[{"content":"hi"}]'
      })

      expect(logger.warn.getCall(0).firstArg).to.equal('Messages must be a string, object, or list of objects')
      expect(logger.warn.getCall(1).firstArg).to.equal('Message content must be a string.')
      expect(logger.warn.getCall(2).firstArg).to.equal('Message role must be a string.')
      expect(logger.warn.getCall(3).firstArg).to.equal('Messages must be a string, object, or list of objects')
      expect(logger.warn.getCall(4).firstArg).to.equal('Messages must be a string, object, or list of objects')
      expect(logger.warn.getCall(5).firstArg).to.equal('Message content must be a string.')
      expect(logger.warn.getCall(6).firstArg).to.equal('Message role must be a string.')
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
      tagger.tagEmbeddingIO(span, inputData, outputData)
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.documents': '[{"text":"my string document"},{"text":"my object document"},' +
        '{"text":"foo","name":"bar"},{"text":"baz","id":"qux"},{"text":"quux","score":5},' +
        '{"text":"foo","name":"bar","id":"qux","score":5}]',
        '_ml_obs.meta.output.value': 'embedded documents'
      })
    })

    it('filters out non-string properties on documents', () => {
      const inputData = [
        true,
        { text: 5 },
        { text: 'foo', name: 5 },
        'hi',
        null,
        undefined
      ]
      const outputData = 'output'
      tagger.tagEmbeddingIO(span, inputData, outputData)
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.documents': '[{"text":"hi"}]',
        '_ml_obs.meta.output.value': 'output'
      })

      expect(logger.warn.getCall(0).firstArg).to.equal('Documents must be a string, object, or list of objects.')
      expect(logger.warn.getCall(1).firstArg).to.equal('Document text must be a string.')
      expect(logger.warn.getCall(2).firstArg).to.equal('Document name must be a string.')
      expect(logger.warn.getCall(3).firstArg).to.equal('Documents must be a string, object, or list of objects.')
      expect(logger.warn.getCall(4).firstArg).to.equal('Documents must be a string, object, or list of objects.')
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

      tagger.tagRetrievalIO(span, inputData, outputData)
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.value': 'some query',
        '_ml_obs.meta.output.documents': '[{"text":"result 1"},{"text":"result 2"},' +
        '{"text":"foo","name":"bar"},{"text":"baz","id":"qux"},{"text":"quux","score":5},' +
        '{"text":"foo","name":"bar","id":"qux","score":5}]'
      })
    })

    it('filters out non-string properties on documents', () => {
      const inputData = 'some query'
      const outputData = [
        true,
        { text: 5 },
        { text: 'foo', name: 5 },
        'hi',
        null,
        undefined
      ]
      tagger.tagRetrievalIO(span, inputData, outputData)
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.value': 'some query',
        '_ml_obs.meta.output.documents': '[{"text":"hi"}]'
      })

      expect(logger.warn.getCall(0).firstArg).to.equal('Documents must be a string, object, or list of objects.')
      expect(logger.warn.getCall(1).firstArg).to.equal('Document text must be a string.')
      expect(logger.warn.getCall(2).firstArg).to.equal('Document name must be a string.')
      expect(logger.warn.getCall(3).firstArg).to.equal('Documents must be a string, object, or list of objects.')
      expect(logger.warn.getCall(4).firstArg).to.equal('Documents must be a string, object, or list of objects.')
    })
  })

  describe('tagTextIO', () => {
    it('tags a span with text io', () => {
      const inputData = { some: 'object' }
      const outputData = 'some text'
      tagger.tagTextIO(span, inputData, outputData)
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.value': '{"some":"object"}',
        '_ml_obs.meta.output.value': 'some text'
      })
    })

    it('logs when the value is not JSON serializable', () => {
      const data = unserializbleObject()
      tagger.tagTextIO(span, data, 'output')
      expect(logger.warn).to.have.been.calledOnceWith('Failed to parse input value, must be JSON serializable.')
      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.output.value': 'output'
      })
    })
  })
})
