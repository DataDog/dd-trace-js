'use strict'

const { expectedLLMObsNonLLMSpanEvent, deepEqualWithMockValues } = require('../util')
const chai = require('chai')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const tags = {
  ml_app: 'test',
  language: 'javascript'
}

const SpanWriter = require('../../../src/llmobs/writers/spans')
const EvalMetricsWriter = require('../../../src/llmobs/writers/evaluations')

const tracerVersion = require('../../../../../package.json').version

function getTag (llmobsSpan, tagName) {
  const tag = llmobsSpan.tags.find(tag => tag.split(':')[0] === tagName)
  return tag?.split(':')[1]
}

describe('end to end sdk integration tests', () => {
  let tracer
  let llmobs
  let payloadGenerator

  function run (payloadGenerator) {
    payloadGenerator()
    return {
      spans: tracer._tracer._processor.process.args.map(args => args[0]).reverse(), // spans finish in reverse order
      llmobsSpans: SpanWriter.prototype.append.args?.map(args => args[0]),
      evaluationMetrics: EvalMetricsWriter.prototype.append.args?.map(args => args[0])
    }
  }

  function check (expected, actual) {
    for (const expectedLLMObsSpanIdx in expected) {
      const expectedLLMObsSpan = expected[expectedLLMObsSpanIdx]
      const actualLLMObsSpan = actual[expectedLLMObsSpanIdx]
      expect(actualLLMObsSpan).to.deep.deepEqualWithMockValues(expectedLLMObsSpan)
    }
  }

  before(() => {
    tracer = require('../../../../dd-trace')
    tracer.init({
      llmobs: {
        mlApp: 'test',
        agentlessEnabled: false
      }
    })

    // another test suite may have disabled LLMObs
    // to clear the intervals and unsubscribe
    // in that case, the `init` call above won't have re-enabled it
    // we'll re-enable it here
    llmobs = tracer.llmobs
    if (!llmobs.enabled) {
      llmobs.enable({
        mlApp: 'test',
        agentlessEnabled: false
      })
    }

    tracer._tracer._config.apiKey = 'test'

    sinon.spy(tracer._tracer._processor, 'process')
    sinon.stub(SpanWriter.prototype, 'append')
    sinon.stub(EvalMetricsWriter.prototype, 'append')
  })

  afterEach(() => {
    tracer._tracer._processor.process.resetHistory()
    SpanWriter.prototype.append.resetHistory()
    EvalMetricsWriter.prototype.append.resetHistory()

    process.removeAllListeners('beforeExit')

    llmobs.disable()
    llmobs.enable({ mlApp: 'test', apiKey: 'test' })
  })

  after(() => {
    sinon.restore()
    llmobs.disable()
    delete global._ddtrace
    delete require.cache[require.resolve('../../../../dd-trace')]
  })

  it('uses trace correctly', () => {
    payloadGenerator = function () {
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
    }

    const { spans, llmobsSpans } = run(payloadGenerator)
    expect(spans).to.have.lengthOf(3)
    expect(llmobsSpans).to.have.lengthOf(2)

    const expected = [
      expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        spanKind: 'agent',
        tags: { ...tags, bar: 'baz' },
        metadata: { foo: 'bar' },
        inputValue: 'hello',
        outputValue: 'world'
      }),
      expectedLLMObsNonLLMSpanEvent({
        span: spans[2],
        spanKind: 'workflow',
        parentId: spans[0].context().toSpanId(),
        tags,
        name: 'myWorkflow',
        inputValue: 'world',
        outputValue: 'hello'
      })
    ]

    check(expected, llmobsSpans)
  })

  it('uses wrap correctly', () => {
    payloadGenerator = function () {
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
    }

    const { spans, llmobsSpans } = run(payloadGenerator)
    expect(spans).to.have.lengthOf(3)
    expect(llmobsSpans).to.have.lengthOf(2)

    const expected = [
      expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        spanKind: 'agent',
        tags,
        inputValue: 'hello',
        outputValue: 'world',
        metadata: { foo: 'bar' }
      }),
      expectedLLMObsNonLLMSpanEvent({
        span: spans[2],
        spanKind: 'workflow',
        parentId: spans[0].context().toSpanId(),
        tags,
        name: 'myWorkflow',
        inputValue: 'my custom input',
        outputValue: 'custom'
      })
    ]

    check(expected, llmobsSpans)
  })

  it('submits evaluations', () => {
    sinon.stub(Date, 'now').returns(1234567890)
    payloadGenerator = function () {
      llmobs.trace({ kind: 'agent', name: 'myAgent' }, () => {
        llmobs.annotate({ inputData: 'hello', outputData: 'world' })
        const spanCtx = llmobs.exportSpan()
        llmobs.submitEvaluation(spanCtx, {
          label: 'foo',
          metricType: 'categorical',
          value: 'bar'
        })
      })
    }

    const { spans, llmobsSpans, evaluationMetrics } = run(payloadGenerator)
    expect(spans).to.have.lengthOf(1)
    expect(llmobsSpans).to.have.lengthOf(1)
    expect(evaluationMetrics).to.have.lengthOf(1)

    // check eval metrics content
    const expected = [
      {
        trace_id: spans[0].context().toTraceId(true),
        span_id: spans[0].context().toSpanId(),
        label: 'foo',
        metric_type: 'categorical',
        categorical_value: 'bar',
        ml_app: 'test',
        timestamp_ms: 1234567890,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:test']
      }
    ]

    check(expected, evaluationMetrics)

    Date.now.restore()
  })

  describe('distributed', () => {
    it('injects and extracts the proper llmobs context', () => {
      payloadGenerator = function () {
        const carrier = {}
        llmobs.trace({ kind: 'workflow', name: 'parent' }, workflow => {
          tracer.inject(workflow, 'text_map', carrier)
        })

        const spanContext = tracer.extract('text_map', carrier)
        tracer.trace('new-service-root', { childOf: spanContext }, () => {
          llmobs.trace({ kind: 'workflow', name: 'child' }, () => {})
        })
      }

      const { llmobsSpans } = run(payloadGenerator)
      expect(llmobsSpans).to.have.lengthOf(2)

      expect(getTag(llmobsSpans[0], 'ml_app')).to.equal('test')
      expect(getTag(llmobsSpans[1], 'ml_app')).to.equal('test')
    })

    it('injects the local mlApp', () => {
      payloadGenerator = function () {
        const carrier = {}
        llmobs.trace({ kind: 'workflow', name: 'parent', mlApp: 'span-level-ml-app' }, workflow => {
          tracer.inject(workflow, 'text_map', carrier)
        })

        const spanContext = tracer.extract('text_map', carrier)
        tracer.trace('new-service-root', { childOf: spanContext }, () => {
          llmobs.trace({ kind: 'workflow', name: 'child' }, () => {})
        })
      }

      const { llmobsSpans } = run(payloadGenerator)
      expect(llmobsSpans).to.have.lengthOf(2)

      expect(getTag(llmobsSpans[0], 'ml_app')).to.equal('span-level-ml-app')
      expect(getTag(llmobsSpans[1], 'ml_app')).to.equal('span-level-ml-app')
    })

    it('injects a distributed mlApp', () => {
      payloadGenerator = function () {
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
      }

      const { llmobsSpans } = run(payloadGenerator)
      expect(llmobsSpans).to.have.lengthOf(3)

      expect(getTag(llmobsSpans[0], 'ml_app')).to.equal('test')
      expect(getTag(llmobsSpans[1], 'ml_app')).to.equal('test')
      expect(getTag(llmobsSpans[2], 'ml_app')).to.equal('test')
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

    it('does not submit a span if there is no mlApp', () => {
      payloadGenerator = function () {
        let error
        try {
          llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, () => {})
        } catch (e) {
          error = e
        }

        expect(error).to.exist
      }

      const { llmobsSpans } = run(payloadGenerator)
      expect(llmobsSpans).to.have.lengthOf(0)
    })
  })

  describe.only('with user span processor', () => {
    afterEach(() => {
      llmobs.registerProcessor(null)
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

      it('does not submit dropped spans', () => {
        payloadGenerator = function () {
          llmobs.trace({ kind: 'workflow', name: 'keep' }, () => {
            llmobs.trace({ kind: 'workflow', name: 'drop' }, () => {
              llmobs.annotate({ tags: { drop_span: true } })
            })
          })
        }

        const { llmobsSpans } = run(payloadGenerator)
        expect(llmobsSpans).to.have.lengthOf(1)
        expect(llmobsSpans[0].name).to.equal('keep')
      })
    })

    describe('with a processor that returns an invalid type', () => {
      function processor (span) {
        return {}
      }

      beforeEach(() => {
        llmobs.registerProcessor(processor)
      })

      it('does not submit the span', () => {
        payloadGenerator = function () {
          llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, () => {})
        }

        const { llmobsSpans } = run(payloadGenerator)
        expect(llmobsSpans).to.have.lengthOf(0)
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

      it.only('redacts the input and output', () => {
        payloadGenerator = function () {
          llmobs.trace({ kind: 'workflow', name: 'redact-input' }, () => {
            llmobs.annotate({ tags: { redact_input: true }, inputData: 'hello' })
            llmobs.trace({ kind: 'llm', name: 'redact-output' }, () => {
              llmobs.annotate({ tags: { redact_output: true }, outputData: 'world' })
            })
          })
        }

        const { llmobsSpans } = run(payloadGenerator)
        expect(llmobsSpans).to.have.lengthOf(2)

        expect(llmobsSpans[0].meta.input.value).to.equal('REDACTED')
        expect(llmobsSpans[1].meta.output.messages[0].content).to.equal('REDACTED')
      })
    })
  })
})
