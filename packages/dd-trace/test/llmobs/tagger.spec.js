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

  describe('tagLLMIO', () => {
    beforeEach(() => {
      sinon.stub(tagger, '_tagMessages')
    })

    afterEach(() => {
      tagger._tagMessages.restore()
    })

    it('tags a span with llm io', () => {
      tagger.tagLLMIO(span, { a: 'foo' }, { b: 'bar' })
      expect(tagger._tagMessages).to.have.been.calledTwice
      expect(tagger._tagMessages).to.have.been.calledWith(span, { a: 'foo' }, '_ml_obs.meta.input.messages')
      expect(tagger._tagMessages).to.have.been.calledWith(span, { b: 'bar' }, '_ml_obs.meta.output.messages')
    })
  })

  describe('tagEmbeddingIO', () => {
    beforeEach(() => {
      sinon.stub(tagger, '_tagDocuments')
      sinon.stub(tagger, '_tagText')
    })

    afterEach(() => {
      tagger._tagDocuments.restore()
      tagger._tagText.restore()
    })

    it('tags a span with embedding io', () => {
      tagger.tagEmbeddingIO(span, { a: 'foo' }, { b: 'bar' })
      expect(tagger._tagDocuments).to.have.been.calledOnce
      expect(tagger._tagDocuments).to.have.been.calledWith(span, { a: 'foo' }, '_ml_obs.meta.input.documents')
      expect(tagger._tagText).to.have.been.calledOnce
      expect(tagger._tagText).to.have.been.calledWith(span, { b: 'bar' }, '_ml_obs.meta.output.value')
    })
  })

  describe('tagRetrievalIO', () => {
    beforeEach(() => {
      sinon.stub(tagger, '_tagDocuments')
      sinon.stub(tagger, '_tagText')
    })

    afterEach(() => {
      tagger._tagDocuments.restore()
      tagger._tagText.restore()
    })

    it('tags a span with retrieval io', () => {
      tagger.tagRetrievalIO(span, { a: 'foo' }, { b: 'bar' })
      expect(tagger._tagDocuments).to.have.been.calledOnce
      expect(tagger._tagDocuments).to.have.been.calledWith(span, { b: 'bar' }, '_ml_obs.meta.output.documents')
      expect(tagger._tagText).to.have.been.calledOnce
      expect(tagger._tagText).to.have.been.calledWith(span, { a: 'foo' }, '_ml_obs.meta.input.value')
    })
  })

  describe('tagTextIO', () => {
    beforeEach(() => {
      sinon.stub(tagger, '_tagText')
    })

    afterEach(() => {
      tagger._tagText.restore()
    })

    it('tags a span with text io', () => {
      tagger.tagTextIO(span, { a: 'foo' }, { b: 'bar' })
      expect(tagger._tagText).to.have.been.calledTwice
      expect(tagger._tagText).to.have.been.calledWith(span, { a: 'foo' }, '_ml_obs.meta.input.value')
      expect(tagger._tagText).to.have.been.calledWith(span, { b: 'bar' }, '_ml_obs.meta.output.value')
    })
  })

  // maybe confirm this one
  describe('tagSpanTags', () => {})

  describe('_tagText', () => {
    it('tags a span with text', () => {
      tagger._tagText(span, 'my-text', '_ml_obs.meta.input.value')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.value': 'my-text'
      })
    })

    it('tags a span with an object', () => {
      tagger._tagText(span, { a: 1, b: 2 }, '_ml_obs.meta.input.value')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.value': '{"a":1,"b":2}'
      })
    })

    it('logs when the value is not JSON serializable', () => {
      const data = unserializbleObject()
      tagger._tagText(span, data, '_ml_obs.meta.input.value')
      expect(logger.warn).to.have.been.calledOnce
    })
  })

  describe('_tagDocuments', () => {
    it('tags a single document object', () => {
      const document = { text: 'my-text', name: 'my-name', id: 'my-id', score: 0.5 }
      tagger._tagDocuments(span, document, '_ml_obs.meta.input.documents')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.documents': '[{"text":"my-text","name":"my-name","id":"my-id","score":0.5}]'
      })
    })

    it('tags a single document string', () => {
      const document = 'my-text'
      tagger._tagDocuments(span, document, '_ml_obs.meta.input.documents')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.documents': '["my-text"]'
      })
    })

    it('tags a document with a subset of properties', () => {
      const document = { text: 'my-text', score: 0.5 }
      tagger._tagDocuments(span, document, '_ml_obs.meta.input.documents')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.documents': '[{"text":"my-text","score":0.5}]'
      })
    })

    it('tags multiple documents', () => {
      const documents = [
        { text: 'my-text', name: 'my-name', id: 'my-id', score: 0.5 },
        { text: 'my-text2', name: 'my-name2', id: 'my-id2', score: 0.6 }
      ]
      tagger._tagDocuments(span, documents, '_ml_obs.meta.input.documents')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.documents': '[{"text":"my-text","name":"my-name"' +
        ',"id":"my-id","score":0.5},{"text":"my-text2","name":"my-name2","id":"my-id2","score":0.6}]'
      })
    })

    it('does not include malformed documents', () => {
      const documents = [
        { text: 'my-text', name: 'my-name', id: 'my-id', score: 0.5 },
        { text: 'my-text2', score: 'not-a-number' }
      ]

      tagger._tagDocuments(span, documents, '_ml_obs.meta.input.documents')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.documents': '[{"text":"my-text","name":"my-name","id":"my-id","score":0.5}]'
      })
    })

    it('logs when a document is not JSON serializable', () => {
      const documents = [unserializbleObject()]
      tagger._tagDocuments(span, documents, '_ml_obs.meta.input.documents')
      expect(logger.warn).to.have.been.calledOnce
    })
  })

  describe('_tagMessages', () => {
    it('tags a single message object', () => {
      const message = { content: 'my-content', role: 'my-role' }
      tagger._tagMessages(span, message, '_ml_obs.meta.input.messages')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.messages': '[{"content":"my-content","role":"my-role"}]'
      })
    })

    it('tags a single message string', () => {
      tagger._tagMessages(span, 'my-message', '_ml_obs.meta.input.messages')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.messages': '["my-message"]'
      })
    })

    it('tags a message with only content', () => {
      const message = { content: 'my-content' }
      tagger._tagMessages(span, message, '_ml_obs.meta.input.messages')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.messages': '[{"content":"my-content"}]'
      })
    })

    it('defaults missing content to empty content', () => {
      const message = {}
      tagger._tagMessages(span, message, '_ml_obs.meta.input.messages')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.messages': '[{"content":""}]'
      })
    })

    it('filters out messages with non-string content', () => {
      const messages = [
        { content: 'my-content' },
        { role: 'my-role', content: 6 }
      ]
      tagger._tagMessages(span, messages, '_ml_obs.meta.input.messages')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.messages': '[{"content":"my-content"}]'
      })
    })

    it('filters out messages with non-string role', () => {
      const messages = [
        { content: 'my-content', role: 'my-role' },
        { content: 'my-content2', role: 6 }
      ]
      tagger._tagMessages(span, messages, '_ml_obs.meta.input.messages')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.messages': '[{"content":"my-content","role":"my-role"}]'
      })
    })

    it('tags multiple messages', () => {
      const messages = [
        { content: 'my-content', role: 'my-role' },
        { content: 'my-content2', role: 'my-role2' }
      ]
      tagger._tagMessages(span, messages, '_ml_obs.meta.input.messages')

      expect(span.context()._tags).to.deep.equal({
        '_ml_obs.meta.input.messages': '[{"content":"my-content","role":"my-role"},' +
        '{"content":"my-content2","role":"my-role2"}]'
      })
    })

    it('logs when a message is not JSON serializable', () => {
      const messages = [unserializbleObject()]
      tagger._tagMessages(span, messages, '_ml_obs.meta.input.messages')
      expect(logger.warn).to.have.been.calledOnce
    })
  })
})
