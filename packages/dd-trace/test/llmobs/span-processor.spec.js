'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

// we will use this to populate the span-tags map
const LLMObsTagger = require('../../src/llmobs/tagger')

describe('span processor', () => {
  let LLMObsSpanProcessor
  let processor
  let writer
  let log

  beforeEach(() => {
    writer = {
      append: sinon.stub()
    }

    log = {
      warn: sinon.stub()
    }

    LLMObsSpanProcessor = proxyquire('../../src/llmobs/span-processor', {
      '../../../../package.json': { version: 'x.y.z' },
      '../log': log
    })

    processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })
    processor.setWriter(writer)
  })

  describe('process', () => {
    let span

    it('should do nothing if llmobs is not enabled', () => {
      processor = new LLMObsSpanProcessor({ llmobs: { enabled: false } })

      expect(() => processor.process({ span })).not.to.throw()
    })

    it('should do nothing if the span is not an llm obs span', () => {
      span = { context: () => ({ _tags: {} }) }

      expect(writer.append).to.not.have.been.called
    })

    it('should format the span event for the writer', () => {
      span = {
        _name: 'test',
        _startTime: 0, // this is in ms, will be converted to ns
        _duration: 1, // this is in ms, will be converted to ns
        context () {
          return {
            _tags: {},
            toTraceId () { return '123' }, // should not use this
            toSpanId () { return '456' }
          }
        }
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.model_name': 'myModel',
        '_ml_obs.meta.model_provider': 'myProvider',
        '_ml_obs.meta.metadata': { foo: 'bar' },
        '_ml_obs.meta.ml_app': 'myApp',
        '_ml_obs.meta.input.messages': [{ role: 'user', content: 'hello' }],
        '_ml_obs.meta.output.messages': [{ role: 'assistant', content: 'world' }],
        '_ml_obs.llmobs_parent_id': '1234'
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload).to.deep.equal({
        trace_id: '123',
        span_id: '456',
        parent_id: '1234',
        name: 'test',
        tags: [
          'version:',
          'env:',
          'service:',
          'source:integration',
          'ml_app:myApp',
          'ddtrace.version:x.y.z',
          'error:0',
          'language:javascript'
        ],
        start_ns: 0,
        duration: 1000000,
        status: 'ok',
        meta: {
          'span.kind': 'llm',
          model_name: 'myModel',
          model_provider: 'myprovider', // should be lowercase
          input: {
            messages: [{ role: 'user', content: 'hello' }]
          },
          output: {
            messages: [{ role: 'assistant', content: 'world' }]
          },
          metadata: { foo: 'bar' }
        },
        metrics: {},
        _dd: {
          trace_id: '123',
          span_id: '456'
        }
      })

      expect(writer.append).to.have.been.calledOnce
    })

    it('removes problematic fields from the metadata', () => {
      // problematic fields are circular references or bigints
      const metadata = {
        bigint: 1n,
        deep: {
          foo: 'bar'
        },
        bar: 'baz'
      }
      metadata.circular = metadata
      metadata.deep.circular = metadata.deep
      span = {
        context () {
          return {
            _tags: {},
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.metadata': metadata
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload.meta.metadata).to.deep.equal({
        bar: 'baz',
        bigint: 'Unserializable value',
        circular: 'Unserializable value',
        deep: { foo: 'bar', circular: 'Unserializable value' }
      })
    })

    it('tags output documents for a retrieval span', () => {
      span = {
        context () {
          return {
            _tags: {},
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'retrieval',
        '_ml_obs.meta.output.documents': [{ text: 'hello', name: 'myDoc', id: '1', score: 0.6 }]
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload.meta.output.documents).to.deep.equal([{
        text: 'hello',
        name: 'myDoc',
        id: '1',
        score: 0.6
      }])
    })

    it('tags input documents for an embedding span', () => {
      span = {
        context () {
          return {
            _tags: {},
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'embedding',
        '_ml_obs.meta.input.documents': [{ text: 'hello', name: 'myDoc', id: '1', score: 0.6 }]
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload.meta.input.documents).to.deep.equal([{
        text: 'hello',
        name: 'myDoc',
        id: '1',
        score: 0.6
      }])
    })

    it('defaults model provider to custom', () => {
      span = {
        context () {
          return {
            _tags: {},
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.model_name': 'myModel'
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload.meta.model_provider).to.equal('custom')
    })

    it('sets an error appropriately', () => {
      span = {
        context () {
          return {
            _tags: {
              'error.message': 'error message',
              'error.type': 'error type',
              'error.stack': 'error stack'
            },
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm'
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload.meta['error.message']).to.equal('error message')
      expect(payload.meta['error.type']).to.equal('error type')
      expect(payload.meta['error.stack']).to.equal('error stack')
      expect(payload.status).to.equal('error')

      expect(payload.tags).to.include('error_type:error type')
    })

    it('uses the error itself if the span does not have specific error fields', () => {
      span = {
        context () {
          return {
            _tags: {
              error: new Error('error message')
            },
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm'
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload.meta['error.message']).to.equal('error message')
      expect(payload.meta['error.type']).to.equal('Error')
      expect(payload.meta['error.stack']).to.exist
      expect(payload.status).to.equal('error')

      expect(payload.tags).to.include('error_type:Error')
    })

    it('uses the span name from the tag if provided', () => {
      span = {
        _name: 'test',
        context () {
          return {
            _tags: {},
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.name': 'mySpan'
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload.name).to.equal('mySpan')
    })

    it('attaches session id if provided', () => {
      span = {
        context () {
          return {
            _tags: {},
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.session_id': '1234'
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload.session_id).to.equal('1234')
      expect(payload.tags).to.include('session_id:1234')
    })

    it('sets span tags appropriately', () => {
      span = {
        context () {
          return {
            _tags: {},
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.tags': { hostname: 'localhost', foo: 'bar', source: 'mySource' }
      })

      processor.process({ span })
      const payload = writer.append.getCall(0).firstArg

      expect(payload.tags).to.include('foo:bar')
      expect(payload.tags).to.include('source:mySource')
      expect(payload.tags).to.include('hostname:localhost')
    })
  })
})
