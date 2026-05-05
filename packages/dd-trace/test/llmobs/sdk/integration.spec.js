'use strict'

const assert = require('node:assert')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../plugins/agent')
const { useLlmObs, assertLlmObsSpanEvent, assertLlmObsEvaluationMetric } = require('../util')
function getTag (llmobsSpan, tagName) {
  const tag = llmobsSpan.tags.find(tag => tag.split(':')[0] === tagName)
  return tag?.split(':')[1]
}

describe('end to end sdk integration tests', () => {
  let tracer
  let llmobs

  const { getEvents, getEvaluationMetrics } = useLlmObs()

  before(() => {
    tracer = require('../../../../dd-trace')
    llmobs = tracer.llmobs
  })

  it('uses trace correctly', async () => {
    const result = llmobs.trace({ kind: 'agent' }, () => {
      llmobs.annotate({ inputData: 'hello', outputData: 'world', metadata: { foo: 'bar' } })
      return tracer.trace('apmSpan', () => {
        llmobs.annotate({ tags: { bar: 'baz' } }) // should use the current active llmobs span
        return llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, () => {
          llmobs.annotate({ inputData: 'world', outputData: 'hello' })
          return 'boom'
        })
      })
    })

    assert.equal(result, 'boom')

    const { apmSpans, llmobsSpans } = await getEvents(2)
    assert.equal(apmSpans.length, 3)
    assert.equal(llmobsSpans.length, 2)

    assertLlmObsSpanEvent(llmobsSpans[0], {
      span: apmSpans[0],
      spanKind: 'agent',
      name: 'agent',
      tags: { ml_app: 'test', bar: 'baz' },
      metadata: { foo: 'bar' },
      inputValue: 'hello',
      outputValue: 'world',
    })

    assertLlmObsSpanEvent(llmobsSpans[1], {
      span: apmSpans[2],
      spanKind: 'workflow',
      parentId: llmobsSpans[0].span_id,
      tags: { ml_app: 'test' },
      name: 'myWorkflow',
      inputValue: 'world',
      outputValue: 'hello',
    })
  })

  it('uses wrap correctly', async () => {
    function agent (input) {
      llmobs.annotate({ inputData: 'hello' })
      return apm(input)
    }
    // eslint-disable-next-line no-func-assign
    agent = llmobs.wrap({ kind: 'agent' }, agent)

    function apm (input) {
      llmobs.annotate({ metadata: { foo: 'bar' } }) // should annotate the agent span
      return workflow(input)
    }
    // eslint-disable-next-line no-func-assign
    apm = tracer.wrap('apm', apm)

    function workflow () {
      llmobs.annotate({ outputData: 'custom' })
      return 'world'
    }
    // eslint-disable-next-line no-func-assign
    workflow = llmobs.wrap({ kind: 'workflow', name: 'myWorkflow' }, workflow)

    agent('my custom input')

    const { apmSpans, llmobsSpans } = await getEvents(2)
    assert.equal(apmSpans.length, 3)
    assert.equal(llmobsSpans.length, 2)

    assertLlmObsSpanEvent(llmobsSpans[0], {
      span: apmSpans[0],
      spanKind: 'agent',
      name: 'agent',
      tags: { ml_app: 'test' },
      inputValue: 'hello',
      outputValue: 'world',
      metadata: { foo: 'bar' },
    })

    assertLlmObsSpanEvent(llmobsSpans[1], {
      span: apmSpans[2],
      spanKind: 'workflow',
      parentId: llmobsSpans[0].span_id,
      tags: { ml_app: 'test' },
      name: 'myWorkflow',
      inputValue: 'my custom input',
      outputValue: 'custom',
    })
  })

  describe('evaluations', () => {
    before(() => {
      sinon.stub(Date, 'now').returns(1234567890)
    })

    after(() => {
      Date.now.restore()
    })

    it('submits evaluations', async () => {
      llmobs.trace({ kind: 'agent', name: 'myAgent' }, () => {
        llmobs.annotate({ inputData: 'hello', outputData: 'world' })
        const spanCtx = llmobs.exportSpan()
        llmobs.submitEvaluation(spanCtx, {
          label: 'foo',
          metricType: 'categorical',
          value: 'bar',
          tags: {
            foo: 'bar',
          },
        })
      })

      const { apmSpans, llmobsSpans } = await getEvents()
      const llmobsEvaluationMetrics = await getEvaluationMetrics()

      assert.equal(apmSpans.length, 1)
      assert.equal(llmobsSpans.length, 1)
      assert.equal(llmobsEvaluationMetrics.length, 1)

      assertLlmObsEvaluationMetric(llmobsEvaluationMetrics[0], {
        joinOn: {
          span: {
            traceId: llmobsSpans[0].trace_id,
            spanId: llmobsSpans[0].span_id,
          },
        },
        label: 'foo',
        metricType: 'categorical',
        mlApp: 'test',
        value: 'bar',
        tags: {
          foo: 'bar',
        },
      })
    })
  })

  describe('otel correlation bridge tags', () => {
    it('writes llmobs_trace_id, llmobs_parent_id, and _dd.llmobs.submitted to apm span meta', async () => {
      let workflowSpanCtx
      llmobs.trace({ kind: 'workflow', name: 'wf' }, span => {
        workflowSpanCtx = { traceId: span.context().toTraceId(true), spanId: span.context().toSpanId() }
        llmobs.trace({ kind: 'task', name: 'inner' }, () => {})
      })

      const { apmSpans } = await getEvents(2)
      assert.equal(apmSpans.length, 2)

      // The first span in the chunk carries _trace.tags, including the bridge tags.
      const firstSpan = apmSpans[0]
      assert.equal(firstSpan.meta.llmobs_trace_id, workflowSpanCtx.traceId)
      assert.equal(firstSpan.meta.llmobs_parent_id, workflowSpanCtx.spanId)

      // Every SDK-tagged apm span carries the submitted marker.
      for (const apmSpan of apmSpans) {
        assert.equal(apmSpan.meta['_dd.llmobs.submitted'], '1')
      }
    })

    it('does not mark non-llmobs apm spans with _dd.llmobs.submitted', async () => {
      tracer.trace('plainApm', () => {
        llmobs.trace({ kind: 'workflow', name: 'wf' }, () => {})
      })

      const { apmSpans } = await getEvents(1)
      const plainApmSpan = apmSpans.find(s => s.name === 'plainApm')
      const sdkSpan = apmSpans.find(s => s.name === 'wf')

      assert.ok(plainApmSpan)
      assert.ok(sdkSpan)
      assert.equal(plainApmSpan.meta['_dd.llmobs.submitted'], undefined)
      assert.equal(sdkSpan.meta['_dd.llmobs.submitted'], '1')

      // bridge tags still flow to the local trace's chunk meta
      const firstSpan = apmSpans[0]
      assert.match(firstSpan.meta.llmobs_trace_id, /^[0-9a-f]{32}$/)
      assert.ok(firstSpan.meta.llmobs_parent_id)
    })
  })

  describe('distributed', () => {
    it('injects and extracts the proper llmobs context', async () => {
      const carrier = {}
      llmobs.trace({ kind: 'workflow', name: 'parent' }, workflow => {
        tracer.inject(workflow, 'text_map', carrier)
      })

      const spanContext = tracer.extract('text_map', carrier)
      tracer.trace('new-service-root', { childOf: spanContext }, () => {
        llmobs.trace({ kind: 'workflow', name: 'child' }, () => {})
      })

      const { llmobsSpans } = await getEvents(2)
      assert.equal(llmobsSpans.length, 2)

      assert.equal(getTag(llmobsSpans[0], 'ml_app'), 'test')
      assert.equal(getTag(llmobsSpans[1], 'ml_app'), 'test')
    })

    it('injects the local mlApp', async () => {
      const carrier = {}
      llmobs.trace({ kind: 'workflow', name: 'parent', mlApp: 'span-level-ml-app' }, workflow => {
        tracer.inject(workflow, 'text_map', carrier)
      })

      const spanContext = tracer.extract('text_map', carrier)
      tracer.trace('new-service-root', { childOf: spanContext }, () => {
        llmobs.trace({ kind: 'workflow', name: 'child' }, () => {})
      })

      const { llmobsSpans } = await getEvents(2)
      assert.equal(llmobsSpans.length, 2)

      assert.equal(getTag(llmobsSpans[0], 'ml_app'), 'span-level-ml-app')
      assert.equal(getTag(llmobsSpans[1], 'ml_app'), 'span-level-ml-app')
    })

    it('injects a distributed mlApp', async () => {
      let carrier = {}
      llmobs.trace({ kind: 'workflow', name: 'parent' }, workflow => {
        tracer.inject(workflow, 'text_map', carrier)
      })

      // distributed call to service 2
      let spanContext = tracer.extract('text_map', carrier)
      carrier = {}
      tracer.trace('new-service-root', { childOf: spanContext }, () => {
        llmobs.trace({ kind: 'workflow', name: 'child-1' }, child => {
          tracer.inject(child, 'text_map', carrier)
        })
      })

      // distributed call to service 3
      spanContext = tracer.extract('text_map', carrier)
      tracer.trace('new-service-root', { childOf: spanContext }, () => {
        llmobs.trace({ kind: 'workflow', name: 'child-2' }, () => {})
      })

      const { llmobsSpans } = await getEvents(3)
      assert.equal(llmobsSpans.length, 3)

      assert.equal(getTag(llmobsSpans[0], 'ml_app'), 'test')
      assert.equal(getTag(llmobsSpans[1], 'ml_app'), 'test')
      assert.equal(getTag(llmobsSpans[2], 'ml_app'), 'test')
    })
  })

  describe('with no global mlApp', () => {
    let originalMlApp

    before(() => {
      originalMlApp = tracer._tracer._config.llmobs.mlApp
      tracer._tracer._config.llmobs.mlApp = null
    })

    after(() => {
      tracer._tracer._config.llmobs.mlApp = originalMlApp
    })

    it('defaults to the service name', async () => {
      llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, () => {})

      const { llmobsSpans } = await getEvents()
      assert.equal(llmobsSpans.length, 1)
      assert.ok(getTag(llmobsSpans[0], 'ml_app'))
    })
  })

  describe('with user span processor', () => {
    afterEach(() => {
      llmobs.deregisterProcessor()
    })

    describe('when a processor is registered twice', () => {
      function processor (span) {
        return span
      }

      it('throws', () => {
        llmobs.registerProcessor(processor)
        assert.throws(() => llmobs.registerProcessor(processor))
      })
    })

    describe('with a processor that returns null', () => {
      function processor (span) {
        const dropSpan = span.getTag('drop_span')
        if (dropSpan) return null

        return span
      }

      beforeEach(() => {
        llmobs.registerProcessor(processor)
      })

      it('does not submit dropped spans', async () => {
        llmobs.trace({ kind: 'workflow', name: 'keep' }, () => {
          llmobs.trace({ kind: 'workflow', name: 'drop' }, () => {
            llmobs.annotate({ tags: { drop_span: true } })
          })
        })

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans.length, 1)
        assert.equal(llmobsSpans[0].name, 'keep')
      })
    })

    describe('with a processor that returns an invalid type', () => {
      function processor (span) {
        return {}
      }

      beforeEach(() => {
        llmobs.registerProcessor(processor)
        agent.reset() // make sure llmobs requests are cleared
      })

      it('does not submit the span', async () => {
        llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, () => {})

        // Race between getEvents() and a timeout - timeout should win since no spans are expected
        // because the testagent server is running in the same process, this operation should be very low latency
        // meaning there should be no flakiness here
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ llmobsSpans: [] }), 100))

        const { llmobsSpans } = await Promise.race([getEvents(), timeoutPromise])
        assert.equal(llmobsSpans.length, 0)
      })
    })

    describe('with a processor that returns a valid LLMObservabilitySpan', () => {
      function processor (span) {
        const redactInput = span.getTag('redact_input')
        if (redactInput) {
          span.input = span.input.map(message => ({ ...message, content: 'REDACTED' }))
        }

        const redactOutput = span.getTag('redact_output')
        if (redactOutput) {
          span.output = span.output.map(message => ({ ...message, content: 'REDACTED' }))
        }

        return span
      }

      beforeEach(() => {
        llmobs.registerProcessor(processor)
      })

      it('redacts the input and output', async () => {
        llmobs.trace({ kind: 'workflow', name: 'redact-input' }, () => {
          llmobs.annotate({ tags: { redact_input: true }, inputData: 'hello' })
          llmobs.trace({ kind: 'llm', name: 'redact-output' }, () => {
            llmobs.annotate({ tags: { redact_output: true }, outputData: 'world' })
          })
        })

        const { llmobsSpans } = await getEvents(2)
        assert.equal(llmobsSpans.length, 2)

        assert.equal(llmobsSpans[0].meta.input.value, 'REDACTED')
        assert.equal(llmobsSpans[1].meta.output.messages[0].content, 'REDACTED')
      })

      it('redacts embedding input document content while preserving other document fields', async () => {
        llmobs.trace({ kind: 'embedding', name: 'embed' }, () => {
          llmobs.annotate({
            tags: { redact_input: true },
            inputData: [{ text: 'sensitive text', name: 'doc1', id: '1', score: 0.9 }],
          })
        })

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans.length, 1)
        assert.equal(llmobsSpans[0].meta.input.documents[0].text, 'REDACTED')
        assert.equal(llmobsSpans[0].meta.input.documents[0].name, 'doc1')
        assert.equal(llmobsSpans[0].meta.input.documents[0].id, '1')
        assert.equal(llmobsSpans[0].meta.input.documents[0].score, 0.9)
      })

      it('redacts retrieval output document content while preserving other document fields', async () => {
        llmobs.trace({ kind: 'retrieval', name: 'retrieve' }, () => {
          llmobs.annotate({
            tags: { redact_output: true },
            outputData: [{ text: 'sensitive result', name: 'doc2', id: '2', score: 0.7 }],
          })
        })

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans.length, 1)
        assert.equal(llmobsSpans[0].meta.output.documents[0].text, 'REDACTED')
        assert.equal(llmobsSpans[0].meta.output.documents[0].name, 'doc2')
        assert.equal(llmobsSpans[0].meta.output.documents[0].id, '2')
        assert.equal(llmobsSpans[0].meta.output.documents[0].score, 0.7)
      })
    })

    describe('with a processor that filters spans by span.kind', () => {
      before(() => {
        llmobs.registerProcessor(span => span.kind === 'embedding' ? null : span)
      })

      after(() => {
        llmobs.deregisterProcessor()
      })

      it('drops embedding spans but passes retrieval spans through', async () => {
        llmobs.trace({ kind: 'embedding', name: 'embed' }, () => {
          llmobs.annotate({ inputData: [{ text: 'hello' }] })
        })
        llmobs.trace({ kind: 'retrieval', name: 'retrieve' }, () => {
          llmobs.annotate({ outputData: [{ text: 'world' }] })
        })

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans.length, 1)
        assert.equal(llmobsSpans[0].name, 'retrieve')
      })
    })

    describe('with a processor that redacts content based on span.kind', () => {
      before(() => {
        llmobs.registerProcessor(span => {
          if (span.kind === 'embedding') {
            span.input = span.input.map(doc => ({ ...doc, content: 'REDACTED' }))
          }
          return span
        })
      })

      after(() => {
        llmobs.deregisterProcessor()
      })

      it('redacts embedding input documents but leaves the enclosing workflow span unaffected', async () => {
        llmobs.trace({ kind: 'workflow', name: 'wf' }, () => {
          llmobs.annotate({ inputData: 'non-sensitive input' })
          llmobs.trace({ kind: 'embedding', name: 'embed' }, () => {
            llmobs.annotate({ inputData: [{ text: 'sensitive text', name: 'doc1', id: '1', score: 0.9 }] })
          })
        })

        const { llmobsSpans } = await getEvents(2)
        assert.equal(llmobsSpans.length, 2)

        const wfSpan = llmobsSpans.find(s => s.name === 'wf')
        const embedSpan = llmobsSpans.find(s => s.name === 'embed')

        assert.equal(wfSpan.meta.input.value, 'non-sensitive input')
        assert.equal(embedSpan.meta.input.documents[0].text, 'REDACTED')
        assert.equal(embedSpan.meta.input.documents[0].name, 'doc1')
        assert.equal(embedSpan.meta.input.documents[0].id, '1')
        assert.equal(embedSpan.meta.input.documents[0].score, 0.9)
      })
    })
  })

  describe('with annotation context', () => {
    it('applies the annotation context only to the scoped block', async () => {
      llmobs.trace({ kind: 'workflow', name: 'parent' }, () => {
        llmobs.trace({ kind: 'workflow', name: 'beforeAnnotationContext' }, () => {})

        llmobs.annotationContext({ tags: { foo: 'bar' } }, () => {
          llmobs.trace({ kind: 'workflow', name: 'inner' }, () => {
            llmobs.trace({ kind: 'workflow', name: 'innerInner' }, () => {})
          })
          llmobs.trace({ kind: 'workflow', name: 'inner2' }, () => {})
        })

        llmobs.trace({ kind: 'workflow', name: 'afterAnnotationContext' }, () => {})
      })

      const { llmobsSpans } = await getEvents(6)
      assert.equal(llmobsSpans.length, 6)

      assert.equal(getTag(llmobsSpans[0], 'foo'), undefined)

      assert.equal(getTag(llmobsSpans[1], 'foo'), undefined)
      assert.equal(llmobsSpans[1].parent_id, llmobsSpans[0].span_id)

      assert.equal(getTag(llmobsSpans[2], 'foo'), 'bar')
      assert.equal(llmobsSpans[2].parent_id, llmobsSpans[0].span_id)

      assert.equal(getTag(llmobsSpans[3], 'foo'), 'bar')
      assert.equal(llmobsSpans[3].parent_id, llmobsSpans[2].span_id)

      assert.equal(getTag(llmobsSpans[4], 'foo'), 'bar')
      assert.equal(llmobsSpans[4].parent_id, llmobsSpans[0].span_id)

      assert.equal(getTag(llmobsSpans[5], 'foo'), undefined)
      assert.equal(llmobsSpans[5].parent_id, llmobsSpans[0].span_id)
    })
  })

  describe('prompts', () => {
    it('annotates an llm span with a prompt', async () => {
      llmobs.trace({ kind: 'llm', name: 'myLLM' }, () => {
        llmobs.annotate({
          prompt: {
            id: '123',
            version: '1.0.0',
            template: 'this is a {{user_query}}. please summarize based on {{message_history}}',
            variables: {
              user_query: 'test',
              message_history: '1. User: hello!\n\n2. AI: hello, how can I help you today?',
            },
            contextVariables: ['message_history'],
            queryVariables: ['user_query'],
          },
        })
      })

      const { llmobsSpans } = await getEvents()

      assert.equal(llmobsSpans.length, 1)
      assert.deepEqual(llmobsSpans[0].meta.input.prompt, {
        id: '123',
        version: '1.0.0',
        template: 'this is a {{user_query}}. please summarize based on {{message_history}}',
        variables: {
          user_query: 'test',
          message_history: '1. User: hello!\n\n2. AI: hello, how can I help you today?',
        },
        _dd_context_variable_keys: ['message_history'],
        _dd_query_variable_keys: ['user_query'],
      })
      assert.equal(llmobsSpans[0].tags.includes('prompt_tracking_instrumentation_method:annotated'), true)
    })

    it('does not annotate a non-llm span with a prompt', async () => {
      llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, () => {
        llmobs.annotate({
          prompt: {
            id: '123',
            version: '1.0.0',
            template: 'this is a {{user_query}}. please summarize based on {{message_history}}',
          },
        })
      })

      const { llmobsSpans } = await getEvents()
      assert.equal(llmobsSpans.length, 1)
      assert.equal(llmobsSpans[0].meta.input.prompt, undefined)
      assert.equal(llmobsSpans[0].tags.includes('prompt_tracking_instrumentation_method:annotated'), false)
    })

    it('is respected via annotationContext', async () => {
      llmobs.annotationContext({
        prompt: {
          id: '123',
          version: '1.0.0',
          template: 'this is a {{user_query}}. please summarize based on {{message_history}}',
          variables: {
            user_query: 'test',
            message_history: '1. User: hello!\n\n2. AI: hello, how can I help you today?',
          },
          contextVariables: ['message_history'],
          queryVariables: ['user_query'],
        },
      }, () => {
        llmobs.trace({ kind: 'llm', name: 'myLLM' }, () => {})
      })

      const { llmobsSpans } = await getEvents()
      assert.equal(llmobsSpans.length, 1)
      assert.deepEqual(llmobsSpans[0].meta.input.prompt, {
        id: '123',
        version: '1.0.0',
        template: 'this is a {{user_query}}. please summarize based on {{message_history}}',
        variables: {
          user_query: 'test',
          message_history: '1. User: hello!\n\n2. AI: hello, how can I help you today?',
        },
        _dd_context_variable_keys: ['message_history'],
        _dd_query_variable_keys: ['user_query'],
      })
      assert.equal(llmobsSpans[0].tags.includes('prompt_tracking_instrumentation_method:annotated'), true)
    })
  })
})
