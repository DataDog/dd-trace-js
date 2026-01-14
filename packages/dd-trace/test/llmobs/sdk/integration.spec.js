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
      outputValue: 'world'
    })

    assertLlmObsSpanEvent(llmobsSpans[1], {
      span: apmSpans[2],
      spanKind: 'workflow',
      parentId: llmobsSpans[0].span_id,
      tags: { ml_app: 'test' },
      name: 'myWorkflow',
      inputValue: 'world',
      outputValue: 'hello'
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
      metadata: { foo: 'bar' }
    })

    assertLlmObsSpanEvent(llmobsSpans[1], {
      span: apmSpans[2],
      spanKind: 'workflow',
      parentId: llmobsSpans[0].span_id,
      tags: { ml_app: 'test' },
      name: 'myWorkflow',
      inputValue: 'my custom input',
      outputValue: 'custom'
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
            foo: 'bar'
          }
        })
      })

      const { apmSpans, llmobsSpans } = await getEvents()
      const llmobsEvaluationMetrics = await getEvaluationMetrics()

      assert.equal(apmSpans.length, 1)
      assert.equal(llmobsSpans.length, 1)
      assert.equal(llmobsEvaluationMetrics.length, 1)

      assertLlmObsEvaluationMetric(llmobsEvaluationMetrics[0], {
        traceId: llmobsSpans[0].trace_id,
        spanId: llmobsSpans[0].span_id,
        label: 'foo',
        metricType: 'categorical',
        mlApp: 'test',
        value: 'bar',
        tags: {
          foo: 'bar'
        }
      })
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
            template: 'this is a {user_query}. please summarize based on {message_history}',
            variables: {
              user_query: 'test',
              message_history: '1. User: hello!\n\n2. AI: hello, how can I help you today?'
            },
            contextVariables: ['message_history'],
            queryVariables: ['user_query'],
          }
        })
      })

      const { llmobsSpans } = await getEvents()

      assert.equal(llmobsSpans.length, 1)
      assert.deepEqual(llmobsSpans[0].meta.input.prompt, {
        id: '123',
        version: '1.0.0',
        chat_template: [
          { role: 'user', content: 'this is a {user_query}. please summarize based on {message_history}' }
        ],
        variables: {
          user_query: 'test',
          message_history: '1. User: hello!\n\n2. AI: hello, how can I help you today?'
        },
        _dd_context_variable_keys: ['message_history'],
        _dd_query_variable_keys: ['user_query'],
      })
    })

    it('does not annotate a non-llm span with a prompt', async () => {
      llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, () => {
        llmobs.annotate({
          prompt: {
            id: '123',
            version: '1.0.0',
            template: 'this is a {user_query}. please summarize based on {message_history}',
          }
        })
      })

      const { llmobsSpans } = await getEvents()
      assert.equal(llmobsSpans.length, 1)
      assert.equal(llmobsSpans[0].meta.input.prompt, undefined)
    })

    it('is respected via annotationContext', async () => {
      llmobs.annotationContext({
        prompt: {
          id: '123',
          version: '1.0.0',
          template: 'this is a {user_query}. please summarize based on {message_history}',
          variables: {
            user_query: 'test',
            message_history: '1. User: hello!\n\n2. AI: hello, how can I help you today?',
          },
          contextVariables: ['message_history'],
          queryVariables: ['user_query'],
        }
      }, () => {
        llmobs.trace({ kind: 'llm', name: 'myLLM' }, () => {})
      })

      const { llmobsSpans } = await getEvents()
      assert.equal(llmobsSpans.length, 1)
      assert.deepEqual(llmobsSpans[0].meta.input.prompt, {
        id: '123',
        version: '1.0.0',
        chat_template: [
          { role: 'user', content: 'this is a {user_query}. please summarize based on {message_history}' }
        ],
        variables: {
          user_query: 'test',
          message_history: '1. User: hello!\n\n2. AI: hello, how can I help you today?'
        },
        _dd_context_variable_keys: ['message_history'],
        _dd_query_variable_keys: ['user_query'],
      })
    })
  })
})
