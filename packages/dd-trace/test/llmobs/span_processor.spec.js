'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const LLMObsTagger = require('../../src/llmobs/tagger')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

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

    LLMObsSpanProcessor = proxyquire('../../src/llmobs/span_processor', {
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

      assert.doesNotThrow(() => processor.process(span))
    })

    it('should do nothing if the span is not an llm obs span', () => {
      span = { context: () => ({ _tags: {} }) }

      sinon.assert.notCalled(writer.append)
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assert.deepStrictEqual(payload, {
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

      sinon.assert.calledOnce(writer.append)
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assert.deepStrictEqual(payload.meta.metadata, {
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assert.deepStrictEqual(payload.meta.output.documents, [{
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assert.deepStrictEqual(payload.meta.input.documents, [{
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assert.strictEqual(payload.meta.model_provider, 'custom')
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assert.strictEqual(payload.meta['error.message'], 'error message')
      assert.strictEqual(payload.meta['error.type'], 'error type')
      assert.strictEqual(payload.meta['error.stack'], 'error stack')
      assert.strictEqual(payload.status, 'error')

      assertObjectContains(payload.tags, 'error_type:error type')
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assert.strictEqual(payload.meta['error.message'], 'error message')
      assert.strictEqual(payload.meta['error.type'], 'Error')
      assert.ok(payload.meta['error.stack'] != null)
      assert.strictEqual(payload.status, 'error')

      assertObjectContains(payload.tags, 'error_type:Error')
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assert.strictEqual(payload.name, 'mySpan')
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assert.strictEqual(payload.session_id, '1234')
      assertObjectContains(payload.tags, 'session_id:1234')
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

      processor.process(span)
      const payload = writer.append.getCall(0).firstArg

      assertObjectContains(payload.tags, 'foo:bar')
      assertObjectContains(payload.tags, 'source:mySource')
      assertObjectContains(payload.tags, 'hostname:localhost')
    })
  })
})
