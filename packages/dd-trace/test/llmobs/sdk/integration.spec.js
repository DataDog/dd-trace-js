'use strict'

const { expectedLLMObsNonLLMSpanEvent, deepEqualWithMockValues } = require('../util')
const chai = require('chai')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const tags = {
  ml_app: 'test',
  language: 'javascript'
}

const AgentProxyWriter = require('../../../src/llmobs/writers/spans/agentProxy')
const EvalMetricsWriter = require('../../../src/llmobs/writers/evaluations')

const tracerVersion = require('../../../../../package.json').version

describe('end to end sdk integration tests', () => {
  let tracer
  let llmobs
  let payloadGenerator

  function run (payloadGenerator) {
    payloadGenerator()
    return {
      spans: tracer._tracer._processor.process.args.map(args => args[0]).reverse(), // spans finish in reverse order
      llmobsSpans: AgentProxyWriter.prototype.append.args?.map(args => args[0]),
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
        mlApp: 'test'
      }
    })

    // another test suite may have disabled LLMObs
    // to clear the intervals and unsubscribe
    // in that case, the `init` call above won't have re-enabled it
    // we'll re-enable it here
    llmobs = tracer.llmobs
    if (!llmobs.enabled) {
      llmobs.enable({
        mlApp: 'test'
      })
    }

    tracer._tracer._config.apiKey = 'test'

    sinon.spy(tracer._tracer._processor, 'process')
    sinon.stub(AgentProxyWriter.prototype, 'append')
    sinon.stub(EvalMetricsWriter.prototype, 'append')
  })

  afterEach(() => {
    tracer._tracer._processor.process.resetHistory()
    AgentProxyWriter.prototype.append.resetHistory()
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
    const exptected = [
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

    check(exptected, evaluationMetrics)

    Date.now.restore()
  })
})
