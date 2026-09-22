'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
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
      append: sinon.stub(),
    }

    log = {
      warn: sinon.stub(),
    }

    LLMObsSpanProcessor = proxyquire('../../src/llmobs/span_processor', {
      '../../../../package.json': { version: 'x.y.z' },
      '../log': log,
    })

    processor = new LLMObsSpanProcessor({ llmobs: { DD_LLMOBS_ENABLED: true } })
    processor.setWriter(writer)
  })

  afterEach(() => {
    processor.destroy()
  })

  describe('process', () => {
    let span

    function processSpan (samplingPriority = span?.context?.()._sampling?.priority) {
      processor.process(span)
      if (span) processor.processTrace({ spans: [span], samplingPriority })
    }

    it('should do nothing if llmobs is not enabled', () => {
      processor.destroy()
      processor = new LLMObsSpanProcessor({ llmobs: { DD_LLMOBS_ENABLED: false } })

      processSpan()
    })

    it('should do nothing if the span is not an llm obs span', () => {
      span = { context: () => ({ _tags: {} }) }

      processSpan()

      sinon.assert.notCalled(writer.append)
    })

    it('defers routing until the apm sampling decision is available', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'workflow',
      })

      processor.process(span)

      assert.strictEqual(span.meta_struct, undefined)
      sinon.assert.notCalled(writer.append)

      processor.processTrace({ spans: [span], samplingPriority: 1 })

      assert.ok(span.meta_struct._llmobs)
      sinon.assert.notCalled(writer.append)
    })

    it('should format the span event for apm meta_struct', () => {
      span = {
        _name: 'test',
        _startTime: 0, // this is in ms, will be converted to ns
        _duration: 1, // this is in ms, will be converted to ns
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' }, // should not use this
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.model_name': 'myModel',
        '_ml_obs.meta.model_provider': 'myProvider',
        '_ml_obs.meta.metadata': { foo: 'bar' },
        '_ml_obs.meta.ml_app': 'myApp',
        '_ml_obs.meta.input.messages': [{ role: 'user', content: 'hello' }],
        '_ml_obs.meta.output.messages': [{ role: 'assistant', content: 'world' }],
        '_ml_obs.llmobs_parent_id': '1234',
        '_ml_obs.sample_rate': '1',
        '_ml_obs.sampling_decision': '1',
        '_ml_obs.trace_id': 'mlob123',
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.deepStrictEqual(payload, {
        trace_id: 'mlob123',
        parent_id: '1234',
        name: 'test',
        ml_app: 'myApp',
        tags: {
          version: '',
          env: '',
          service: '',
          source: 'integration',
          ml_app: 'myApp',
          'ddtrace.version': 'x.y.z',
          error: '0',
          language: 'javascript',
        },
        meta: {
          span: { kind: 'llm' },
          model_name: 'myModel',
          model_provider: 'myprovider', // should be lowercase
          input: {
            messages: [{ role: 'user', content: 'hello' }],
          },
          output: {
            messages: [{ role: 'assistant', content: 'world' }],
          },
          metadata: { foo: 'bar' },
        },
        metrics: {},
        _dd: {
          sample_rate: '1',
          sampling_decision: '1',
        },
      })

      sinon.assert.notCalled(writer.append)
    })

    it('attaches the llmobs payload to meta_struct when the apm trace is kept', () => {
      const apmTags = {}
      span = {
        _name: 'test',
        _startTime: 0,
        _duration: 1,
        meta_struct: {
          existing: { value: true },
        },
        context () {
          return {
            _tags: apmTags,
            _sampling: { priority: 1 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.model_name': 'myModel',
        '_ml_obs.meta.model_provider': 'myProvider',
        '_ml_obs.meta.ml_app': 'myApp',
        '_ml_obs.meta.input.value': 'hello',
        '_ml_obs.meta.output.value': 'world',
        '_ml_obs.llmobs_parent_id': '1234',
        '_ml_obs.sample_rate': '1',
        '_ml_obs.sampling_decision': '1',
        '_ml_obs.trace_id': 'mlob123',
      })

      processSpan()

      sinon.assert.notCalled(writer.append)
      assert.strictEqual(apmTags['_dd.llmobs.submitted'], undefined)
      assert.deepStrictEqual(span.meta_struct, {
        existing: { value: true },
        _llmobs: {
          trace_id: 'mlob123',
          parent_id: '1234',
          name: 'test',
          ml_app: 'myApp',
          tags: {
            version: '',
            env: '',
            service: '',
            source: 'integration',
            ml_app: 'myApp',
            'ddtrace.version': 'x.y.z',
            error: '0',
            language: 'javascript',
          },
          meta: {
            span: { kind: 'llm' },
            model_name: 'myModel',
            model_provider: 'myprovider',
            input: {
              value: 'hello',
            },
            output: {
              value: 'world',
            },
          },
          metrics: {},
          _dd: {
            sample_rate: '1',
            sampling_decision: '1',
          },
        },
      })
    })

    it('uses the writer when the finalized apm sampling decision drops the trace', () => {
      span = {
        context () {
          return {
            _tags: {},
            _sampling: { priority: 0 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
      })

      processSpan()

      sinon.assert.calledOnce(writer.append)
      assert.strictEqual(span.meta_struct, undefined)
    })

    it('uses the writer immediately when apm tracing is disabled', () => {
      processor.destroy()
      processor = new LLMObsSpanProcessor({
        DD_TRACE_ENABLED: false,
        llmobs: { DD_LLMOBS_ENABLED: true },
      })
      processor.setWriter(writer)
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'workflow',
      })

      processor.process(span)
      processor.processTrace({ spans: [span], samplingPriority: 1, supportsMetaStruct: true })

      sinon.assert.calledOnce(writer.append)
      assert.strictEqual(span.meta_struct, undefined)
    })

    it('uses the writer when the apm trace is not recording', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'workflow',
      })

      processor.process(span)
      processor.processTrace({ spans: [span], samplingPriority: 1, isRecording: false })

      sinon.assert.calledOnce(writer.append)
      assert.strictEqual(span.meta_struct, undefined)
    })

    it('uses the writer when the apm exporter does not support meta_struct', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'workflow',
      })

      processor.process(span)
      processor.processTrace({ spans: [span], samplingPriority: 1, supportsMetaStruct: false })

      sinon.assert.calledOnce(writer.append)
      assert.strictEqual(span.meta_struct, undefined)
    })

    it('routes pending events through the writer when flushed', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'workflow',
      })

      processor.process(span)
      processor.processPending()
      processor.processTrace({ spans: [span], samplingPriority: 1 })

      sinon.assert.calledOnce(writer.append)
      assert.strictEqual(span.meta_struct, undefined)
    })

    it('routes pending events through the writer before exit', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'workflow',
      })
      processor.process(span)

      process.emit('beforeExit')

      sinon.assert.calledOnce(writer.append)
      assert.strictEqual(span.meta_struct, undefined)
    })

    it('nests error fields when attaching the llmobs payload to meta_struct', () => {
      span = {
        context () {
          return {
            _tags: {
              'error.message': 'error message',
              'error.type': 'error type',
              'error.stack': 'error stack',
            },
            _sampling: { priority: 1 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
      })

      processSpan()

      sinon.assert.notCalled(writer.append)
      assert.deepStrictEqual(span.meta_struct._llmobs.meta.error, {
        message: 'error message',
        type: 'error type',
        stack: 'error stack',
      })
    })

    it('keeps using the writer for routed tenant submissions', () => {
      span = {
        context () {
          return {
            _tags: {},
            _sampling: { priority: 1 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_dd.llmobs.routing.api_key': 'tenant-api-key',
        '_dd.llmobs.routing.site': 'datadoghq.com',
      })

      processSpan()

      sinon.assert.calledOnceWithMatch(writer.append, sinon.match.object, {
        apiKey: 'tenant-api-key',
        site: 'datadoghq.com',
      })
      assert.strictEqual(span.meta_struct, undefined)
    })

    it('marks spans with experiment_id tags as experiment-scoped', () => {
      span = {
        _name: 'experiment-row',
        _startTime: 0,
        _duration: 1,
        context () {
          return {
            _tags: {},
            _sampling: { priority: 0 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'experiment',
        '_ml_obs.meta.ml_app': 'myApp',
        '_ml_obs.meta.input.value': 'input',
        '_ml_obs.meta.output.value': 'output',
        '_ml_obs.tags': { experiment_id: 'exp-1', run_id: 'run-1' },
        '_ml_obs.llmobs_parent_id': 'undefined',
        '_ml_obs.sample_rate': '1',
        '_ml_obs.sampling_decision': '1',
      })

      processSpan()
      const payload = writer.append.getCall(0).firstArg

      assert.equal(payload._dd.scope, 'experiments')
      assert.ok(payload.tags.includes('experiment_id:exp-1'))
      assert.ok(payload.tags.includes('run_id:run-1'))
    })

    it('preserves experiment scope when attaching the llmobs payload to meta_struct', () => {
      span = {
        _name: 'experiment-row',
        _startTime: 0,
        _duration: 1,
        context () {
          return {
            _tags: {},
            _sampling: { priority: 1 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'experiment',
        '_ml_obs.tags': { experiment_id: 'exp-1', run_id: 'run-1' },
      })

      processSpan()

      sinon.assert.notCalled(writer.append)
      assert.equal(span.meta_struct._llmobs._dd.scope, 'experiments')
    })

    it('removes problematic fields from the metadata', () => {
      // problematic fields are circular references or bigints
      const metadata = {
        bigint: 1n,
        deep: {
          foo: 'bar',
        },
        bar: 'baz',
      }
      metadata.circular = metadata
      metadata.deep.circular = metadata.deep
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.metadata': metadata,
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.deepStrictEqual(payload.meta.metadata, {
        bar: 'baz',
        bigint: 'Unserializable value',
        circular: 'Unserializable value',
        deep: { foo: 'bar', circular: 'Unserializable value' },
      })
    })

    it('sets cost tags on span event metadata', () => {
      span = {
        _name: 'test',
        _startTime: 0,
        _duration: 1,
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.model_name': 'myModel',
        '_ml_obs.meta.model_provider': 'myProvider',
        '_ml_obs.meta.metadata': { foo: 'bar' },
        '_ml_obs.meta.metadata._dd.cost_tags': ['team', 'feature'],
        '_ml_obs.meta.ml_app': 'myApp',
        '_ml_obs.llmobs_parent_id': '1234',
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.deepStrictEqual(payload.meta.metadata, {
        foo: 'bar',
        _dd: {
          cost_tags: ['team', 'feature'],
        },
      })
    })

    it('creates span event metadata for cost tags', () => {
      span = {
        _name: 'test',
        _startTime: 0,
        _duration: 1,
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.metadata._dd.cost_tags': ['team', 'feature'],
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.deepStrictEqual(payload.meta.metadata, {
        _dd: {
          cost_tags: ['team', 'feature'],
        },
      })
    })

    it('forwards tool definitions to the payload', () => {
      const toolDefinitions = [
        {
          name: 'get_weather',
          description: 'Get the weather for a city.',
          schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ]

      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'tool',
        '_ml_obs.meta.tool_definitions': toolDefinitions,
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.deepStrictEqual(payload.meta.tool_definitions, toolDefinitions)
    })

    it('preserves existing span event metadata _dd fields when setting cost tags', () => {
      span = {
        _name: 'test',
        _startTime: 0,
        _duration: 1,
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.metadata': {
          _dd: {
            existing: 'value',
          },
        },
        '_ml_obs.meta.metadata._dd.cost_tags': ['team', 'feature'],
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.deepStrictEqual(payload.meta.metadata, {
        _dd: {
          existing: 'value',
          cost_tags: ['team', 'feature'],
        },
      })
    })

    it('tags output documents for a retrieval span', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'retrieval',
        '_ml_obs.meta.output.documents': [{ text: 'hello', name: 'myDoc', id: '1', score: 0.6 }],
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.deepStrictEqual(payload.meta.output.documents, [{
        text: 'hello',
        name: 'myDoc',
        id: '1',
        score: 0.6,
      }])
    })

    it('tags input documents for an embedding span', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'embedding',
        '_ml_obs.meta.input.documents': [{ text: 'hello', name: 'myDoc', id: '1', score: 0.6 }],
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.deepStrictEqual(payload.meta.input.documents, [{
        text: 'hello',
        name: 'myDoc',
        id: '1',
        score: 0.6,
      }])
    })

    it('defaults model provider to custom', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.meta.model_name': 'myModel',
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.strictEqual(payload.meta.model_provider, 'custom')
    })

    it('sets an error appropriately', () => {
      span = {
        context () {
          return {
            _tags: {
              'error.message': 'error message',
              'error.type': 'error type',
              'error.stack': 'error stack',
            },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assertObjectContains(payload, {
        meta: {
          error: {
            message: 'error message',
            type: 'error type',
            stack: 'error stack',
          },
        },
        tags: { error_type: 'error type' },
      })
    })

    it('uses the error itself if the span does not have specific error fields', () => {
      span = {
        context () {
          return {
            _tags: {
              error: new Error('error message'),
            },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.strictEqual(payload.meta.error.message, 'error message')
      assert.strictEqual(payload.meta.error.type, 'Error')
      assert.ok(payload.meta.error.stack)
      assert.strictEqual(payload.tags.error_type, 'Error')
    })

    it('uses the span name from the tag if provided', () => {
      span = {
        _name: 'test',
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.name': 'mySpan',
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.strictEqual(payload.name, 'mySpan')
    })

    it('attaches session id if provided', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.session_id': '1234',
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assert.strictEqual(payload.session_id, '1234')
      assert.strictEqual(payload.tags.session_id, '1234')
    })

    it('sets span tags appropriately', () => {
      span = {
        context () {
          return {
            _tags: {},
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.tags': { hostname: 'localhost', foo: 'bar', source: 'mySource' },
      })

      processSpan()
      const payload = span.meta_struct._llmobs

      assertObjectContains(payload.tags, { source: 'mySource', hostname: 'localhost', foo: 'bar' })
    })

    it('uses the writer fallback to preserve every value of array-valued user tags', () => {
      // Regression for https://github.com/DataDog/dd-trace-js/issues/8662 — a single
      // `"key:v1,v2"` entry on the wire gets comma-split at intake, leaving every
      // value after the first orphaned (UI shows a bare `v2` token, `@key:v2` filter
      // does not match). One `key:value` per element preserves each value as its
      // own facet. Empty arrays still emit `key:` so `_dd.cost_tags` references
      // keep finding a wire entry.
      span = {
        context () {
          return {
            _tags: {},
            _sampling: { priority: 1 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.tags': {
          'tool.shell.bin': ['grep', 'head'],
          'tool.shell.cmd': ['git log'],
          'tool.shell.argv': [],
          'tool.shell.flags': [null, 'verbose'],
          'tool.shell.name': 'bash',
        },
      })

      processSpan()
      const payload = writer.append.getCall(0).firstArg

      assert.strictEqual(span.meta_struct, undefined)
      assertObjectContains(payload.tags, [
        'tool.shell.bin:grep',
        'tool.shell.bin:head',
        'tool.shell.cmd:git log',
        'tool.shell.argv:',
        'tool.shell.flags:',
        'tool.shell.flags:verbose',
        'tool.shell.name:bash',
      ])
      assert.ok(
        !payload.tags.includes('tool.shell.bin:grep,head'),
        'array values must not collapse into a single comma-joined entry',
      )
    })

    it('keeps cost-tag references and their wire entries consistent for empty arrays', () => {
      // The cost-tag validator only checks that the referenced key is present in the
      // tag object, not that it produces a wire entry. Dropping empty arrays from
      // the wire would leave `_dd.cost_tags: ['team']` pointing at a key with no
      // matching `team:*` tag, so dd-go would drop or misattribute the cost
      // dimension. Empty arrays therefore stay on the wire as `key:`, matching the
      // pre-fan-out shape.
      span = {
        context () {
          return {
            _tags: {},
            _sampling: { priority: 0 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
        '_ml_obs.tags': { team: [] },
        '_ml_obs.meta.metadata._dd.cost_tags': ['team'],
      })

      processSpan()
      const payload = writer.append.getCall(0).firstArg

      assertObjectContains(payload.tags, ['team:'])
      assert.deepStrictEqual(payload.meta.metadata._dd.cost_tags, ['team'])
    })

    it('marks the apm span with _dd.llmobs.submitted=1 when using the writer fallback', () => {
      const apmTags = {}
      span = {
        context () {
          return {
            _tags: apmTags,
            _sampling: { priority: 0 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, {
        '_ml_obs.meta.span.kind': 'llm',
      })

      writer.append.returns(true)
      processSpan()

      assert.strictEqual(apmTags['_dd.llmobs.submitted'], '1')
    })

    it('does not mark non-llmobs apm spans with _dd.llmobs.submitted', () => {
      const apmTags = {}
      span = {
        context () {
          return {
            _tags: apmTags,
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }
      // intentionally not registered with the tagger

      processSpan()

      assert.strictEqual(apmTags['_dd.llmobs.submitted'], undefined)
    })

    it('does not mark the apm span when format throws (no event submitted)', () => {
      const apmTags = {}
      span = {
        _name: 'broken',
        context () {
          return {
            _tags: apmTags,
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, { '_ml_obs.meta.span.kind': 'llm' })

      // simulate format failing — no LLMObs event will be submitted
      sinon.stub(processor, 'format').throws(new Error('boom'))

      processSpan()

      // Without an LLMObs event, dd-go would otherwise reparent OTel children
      // under a span that produced no event. Tag must stay off.
      assert.strictEqual(apmTags['_dd.llmobs.submitted'], undefined)
      sinon.assert.notCalled(writer.append)
    })

    it('does not mark the apm span when format returns null (event dropped)', () => {
      const apmTags = {}
      span = {
        context () {
          return {
            _tags: apmTags,
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, { '_ml_obs.meta.span.kind': 'llm' })

      // simulate user span processor dropping the event
      sinon.stub(processor, 'format').returns(null)

      processSpan()

      assert.strictEqual(apmTags['_dd.llmobs.submitted'], undefined)
      sinon.assert.notCalled(writer.append)
    })

    it('does not mark the apm span when writer.append throws', () => {
      const apmTags = {}
      span = {
        context () {
          return {
            _tags: apmTags,
            _sampling: { priority: 0 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, { '_ml_obs.meta.span.kind': 'llm' })

      // simulate writer.append throwing (e.g. JSON.stringify failure in
      // byte-length probing on an unsanitized payload)
      writer.append.throws(new Error('boom'))

      processSpan()

      assert.strictEqual(apmTags['_dd.llmobs.submitted'], undefined)
    })

    it('does not mark the apm span when writer.append silently drops (buffer full)', () => {
      const apmTags = {}
      span = {
        context () {
          return {
            _tags: apmTags,
            _sampling: { priority: 0 },
            getTags () { return this._tags },
            getTag (key) { return this._tags[key] },
            setTag (key, value) { this._tags[key] = value },
            toTraceId () { return '123' },
            toSpanId () { return '456' },
          }
        },
      }

      LLMObsTagger.tagMap.set(span, { '_ml_obs.meta.span.kind': 'llm' })

      // simulate writer.append returning false to signal the event was
      // dropped (e.g. per-routing buffer is full)
      writer.append.returns(false)

      processSpan()

      assert.strictEqual(apmTags['_dd.llmobs.submitted'], undefined)
    })
  })
})
