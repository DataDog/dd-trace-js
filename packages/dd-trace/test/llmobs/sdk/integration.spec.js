'use strict'

const { expect } = require('chai')
const { describe, it, afterEach, before, after } = require('mocha')
const sinon = require('sinon')

const { useLlmObs, assertLlmObsSpanEvent } = require('../util')

const assert = require('node:assert')

// const tracerVersion = require('../../../../../package.json').version

function getTag (llmobsSpan, tagName) {
  const tag = llmobsSpan.tags.find(tag => tag.split(':')[0] === tagName)
  return tag?.split(':')[1]
}

describe('end to end sdk integration tests', () => {
  let tracer
  let llmobs

  const getEvents = useLlmObs()

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

    expect(result).to.equal('boom')

    const { apmSpans, llmobsSpans } = await getEvents()
    assert.equal(apmSpans.length, 3)
    assert.equal(llmobsSpans.length, 2)

    assertLlmObsSpanEvent(llmobsSpans[0], {
      span: apmSpans[0],
      spanKind: 'agent',
      name: 'agent',
      tags: { ml_app: 'test', bar: 'baz' },
      metadata: { foo: 'bar' },
      inputData: 'hello',
      outputData: 'world'
    })

    assertLlmObsSpanEvent(llmobsSpans[1], {
      span: apmSpans[2],
      spanKind: 'workflow',
      parentId: llmobsSpans[0].span_id,
      tags: { ml_app: 'test' },
      name: 'myWorkflow',
      inputData: 'world',
      outputData: 'hello'
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

    const { apmSpans, llmobsSpans } = await getEvents()
    assert.equal(apmSpans.length, 3)
    assert.equal(llmobsSpans.length, 2)

    assertLlmObsSpanEvent(llmobsSpans[0], {
      span: apmSpans[0],
      spanKind: 'agent',
      name: 'agent',
      tags: { ml_app: 'test' },
      inputData: 'hello',
      outputData: 'world',
      metadata: { foo: 'bar' }
    })

    assertLlmObsSpanEvent(llmobsSpans[1], {
      span: apmSpans[2],
      spanKind: 'workflow',
      parentId: llmobsSpans[0].span_id,
      tags: { ml_app: 'test' },
      name: 'myWorkflow',
      inputData: 'my custom input',
      outputData: 'custom'
    })
  })

  describe('evaluations', () => {
    before(() => {
      sinon.stub(Date, 'now').returns(1234567890)
    })

    after(() => {
      Date.now.restore()
    })

    // TODO(sabrenner): follow-up on re-enabling this test in a different PR
    it.skip('submits evaluations', () => {
      llmobs.trace({ kind: 'agent', name: 'myAgent' }, () => {
        llmobs.annotate({ inputData: 'hello', outputData: 'world' })
        const spanCtx = llmobs.exportSpan()
        llmobs.submitEvaluation(spanCtx, {
          label: 'foo',
          metricType: 'categorical',
          value: 'bar'
        })
      })

      // const { spans, llmobsSpans, evaluationMetrics } = run(payloadGenerator)
      // expect(spans).to.have.lengthOf(1)
      // expect(llmobsSpans).to.have.lengthOf(1)
      // expect(evaluationMetrics).to.have.lengthOf(1)

      // // check eval metrics content
      // const expected = [
      //   {
      //     trace_id: spans[0].context().toTraceId(true),
      //     span_id: spans[0].context().toSpanId(),
      //     label: 'foo',
      //     metric_type: 'categorical',
      //     categorical_value: 'bar',
      //     ml_app: 'test',
      //     timestamp_ms: 1234567890,
      //     tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:test']
      //   }
      // ]

      // check(expected, evaluationMetrics)
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

      const { llmobsSpans } = await getEvents()
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

      const { llmobsSpans } = await getEvents()
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

      const { llmobsSpans } = await getEvents()
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

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans.length, 2)

        assert.equal(llmobsSpans[0].meta.input.value, 'REDACTED')
        assert.equal(llmobsSpans[1].meta.output.messages[0].content, 'REDACTED')
      })
    })
  })

  describe('with annotation context', () => {
    it('applies the annotation context only to the scoped block', () => {
      payloadGenerator = function () {
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
      }

      const { llmobsSpans } = run(payloadGenerator)
      expect(llmobsSpans).to.have.lengthOf(6)

      expect(llmobsSpans[0].tags).to.not.include('foo:bar')

      expect(llmobsSpans[1].tags).to.not.include('foo:bar')
      expect(llmobsSpans[1].parent_id).to.equal(llmobsSpans[0].span_id)

      expect(llmobsSpans[2].tags).to.include('foo:bar')
      expect(llmobsSpans[2].parent_id).to.equal(llmobsSpans[0].span_id)

      expect(llmobsSpans[3].tags).to.include('foo:bar')
      expect(llmobsSpans[3].parent_id).to.equal(llmobsSpans[2].span_id)

      expect(llmobsSpans[4].tags).to.include('foo:bar')
      expect(llmobsSpans[4].parent_id).to.equal(llmobsSpans[0].span_id)

      expect(llmobsSpans[5].tags).to.not.include('foo:bar')
      expect(llmobsSpans[5].parent_id).to.equal(llmobsSpans[0].span_id)
    })
  })
})
