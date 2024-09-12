'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('span processor', () => {
  let LLMObsSpanProcessor
  let processor
  let AgentlessWriter
  let AgentProxyWriter
  let writer

  beforeEach(() => {
    writer = {
      append: sinon.stub()
    }
    AgentlessWriter = sinon.stub().returns(writer)
    AgentProxyWriter = sinon.stub().returns(writer)

    LLMObsSpanProcessor = proxyquire('../../src/llmobs/span_processor', {
      './writers/spans/agentless': AgentlessWriter,
      './writers/spans/agentProxy': AgentProxyWriter,
      '../../../../package.json': { version: 'x.y.z' }
    })
  })

  describe('initialization', () => {
    it('should not create a writer if llmobs is not enabled', () => {
      processor = new LLMObsSpanProcessor({ llmobs: { enabled: false } })

      expect(processor._writer).to.be.undefined
    })

    it('should create an agentless writer if agentless is enabled', () => {
      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true, agentlessEnabled: true } })

      expect(AgentlessWriter).to.have.been.calledOnce
    })

    it('should create an agent proxy writer if agentless is not enabled', () => {
      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true, agentlessEnabled: false } })

      expect(AgentProxyWriter).to.have.been.calledOnce
    })
  })

  describe('process', () => {
    let span

    it('should do nothing if llmobs is not enabled', () => {
      processor = new LLMObsSpanProcessor({ llmobs: { enabled: false } })

      expect(() => processor.process(span)).not.to.throw()
    })

    it('should do nothing if the span is not an llm obs span', () => {
      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })
      span = { context: () => ({ _tags: {} }) }

      expect(processor._writer.append).to.not.have.been.called
    })

    it('should append to the writer if the span is an llm obs span', () => {
      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })
      processor._process = sinon.stub()
      span = { context: () => ({ _tags: { 'span.type': 'llm' } }) }

      processor.process(span)

      expect(processor._process).to.have.been.calledOnce
      expect(processor._writer.append).to.have.been.calledOnce
    })
  })

  describe('_process', () => {
    it('should format the span event for the writer', () => {
      const span = {
        _name: 'test',
        _startTime: 0, // this is in ms, will be converted to ns
        _duration: 1, // this is in ms, will be converted to ns
        context () {
          return {
            _tags: {
              '_ml_obs.meta.span.kind': 'llm',
              '_ml_obs.meta.model_name': 'myModel',
              '_ml_obs.meta.model_provider': 'myProvider',
              '_ml_obs.meta.metadata': JSON.stringify({ foo: 'bar' }),
              '_ml_obs.meta.ml_app': 'myApp',
              '_ml_obs.meta.input.value': 'input-value',
              '_ml_obs.meta.output.value': 'output-value',
              '_ml_obs.meta.input.messages': '{"role":"user","content":"hello"}',
              '_ml_obs.meta.output.messages': '{"role":"assistant","content":"world"}',
              '_ml_obs.llmobs_parent_id': '1234',
              '_ml_obs.trace_id': '012'
            },
            toTraceId () { return '123' }, // should not use this
            toSpanId () { return '456' }
          }
        }
      }

      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })

      const payload = processor._process(span)

      expect(payload).to.deep.equal({
        trace_id: '012',
        span_id: '456',
        parent_id: '1234',
        name: 'test',
        tags: [
          'version:',
          'env:',
          'service:',
          'source:integration',
          'ml_app:myApp',
          'dd-trace.version:x.y.z',
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
            value: 'input-value',
            messages: { role: 'user', content: 'hello' }
          },
          output: {
            value: 'output-value',
            messages: { role: 'assistant', content: 'world' }
          },
          metadata: { foo: 'bar' }
        },
        metrics: {}
      })
    })

    it('tags output documents for a retrieval span', () => {
      const span = {
        context () {
          return {
            _tags: {
              '_ml_obs.meta.span.kind': 'retrieval',
              '_ml_obs.meta.output.documents': '[{"text":"hello","name":"myDoc","id":"1","score":0.6}]'
            },
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })

      const payload = processor._process(span)

      expect(payload.meta.output.documents).to.deep.equal([{
        text: 'hello',
        name: 'myDoc',
        id: '1',
        score: 0.6
      }])
    })

    it('tags input documents for an embedding span', () => {
      const span = {
        context () {
          return {
            _tags: {
              '_ml_obs.meta.span.kind': 'embedding',
              '_ml_obs.meta.input.documents': '[{"text":"hello","name":"myDoc","id":"1","score":0.6}]'
            },
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })

      const payload = processor._process(span)

      expect(payload.meta.input.documents).to.deep.equal([{
        text: 'hello',
        name: 'myDoc',
        id: '1',
        score: 0.6
      }])
    })

    it('defaults model provider to custom', () => {
      const span = {
        context () {
          return {
            _tags: {
              '_ml_obs.meta.span.kind': 'llm',
              '_ml_obs.meta.model_name': 'myModel'
            },
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })

      const payload = processor._process(span)

      expect(payload.meta.model_provider).to.equal('custom')
    })

    it('sets an error appropriately', () => {
      const span = {
        context () {
          return {
            _tags: {
              '_ml_obs.meta.span.kind': 'llm',
              error: 'true',
              'error.message': 'error message',
              'error.type': 'error type',
              'error.stack': 'error stack'
            },
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })

      const payload = processor._process(span)

      expect(payload.meta['error.message']).to.equal('error message')
      expect(payload.meta['error.type']).to.equal('error type')
      expect(payload.meta['error.stack']).to.equal('error stack')
      expect(payload.status).to.equal('error')

      expect(payload.tags).to.include('error_type:error type')
    })

    it('uses the span name from the tag if provided', () => {
      const span = {
        _name: 'test',
        context () {
          return {
            _tags: {
              '_ml_obs.meta.span.kind': 'llm',
              '_ml_obs.name': 'mySpan'
            },
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })

      const payload = processor._process(span)

      expect(payload.name).to.equal('mySpan')
    })

    it('attaches session id if provided', () => {
      const span = {
        context () {
          return {
            _tags: {
              '_ml_obs.meta.span.kind': 'llm',
              '_ml_obs.session_id': '1234'
            },
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })

      const payload = processor._process(span)

      expect(payload.session_id).to.equal('1234')
      expect(payload.tags).to.include('session_id:1234')
    })

    it('sets span tags appropriately', () => {
      const span = {
        context () {
          return {
            _tags: {
              '_ml_obs.meta.span.kind': 'llm',
              '_ml_obs.tags': '{"hostnam":"localhost","foo":"bar","source":"mySource"}'
            },
            toTraceId () { return '123' },
            toSpanId () { return '456' }
          }
        }
      }

      processor = new LLMObsSpanProcessor({ llmobs: { enabled: true } })

      const payload = processor._process(span)

      expect(payload.tags).to.include('foo:bar')
      expect(payload.tags).to.include('source:mySource')
      expect(payload.tags).to.not.include('hostname:localhost')
    })
  })
})
