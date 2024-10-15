'use strict'

const { expectedLLMObsNonLLMSpanEvent, deepEqualWithMockValues, expectedLLMObsLLMSpanEvent } = require('../util')
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
      spans: llmobs._processor.process.args?.map(args => args[0].span),
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
    delete require.cache[require.resolve('../../../../../package.json')]
    tracer = require('../../../../dd-trace')
    tracer.init({
      llmobs: {
        mlApp: 'test'
      }
    })

    llmobs = tracer.llmobs

    sinon.spy(llmobs._processor, 'process')
    sinon.stub(AgentProxyWriter.prototype, 'append')
    sinon.stub(EvalMetricsWriter.prototype, 'append')
  })

  afterEach(() => {
    llmobs._processor.process.resetHistory()
    AgentProxyWriter.prototype.append.resetHistory()
    EvalMetricsWriter.prototype.append.resetHistory()

    process.removeAllListeners('beforeExit')
  })

  after(() => {
    sinon.restore()
    llmobs.disable()
    delete global._ddtrace
    delete require.cache[require.resolve('../../../../dd-trace')]
  })

  it('uses startSpan correctly', () => {
    payloadGenerator = function () {
      const llmobsParent = llmobs.startSpan({ kind: 'agent', name: 'llmobsParent' })
      const llmobsChild = llmobs
        .startSpan({ kind: 'llm', name: 'llmobsChild', modelName: 'model', modelProvider: 'provider' })
      llmobs.annotate({ inputData: 'hello', outputData: 'world' })
      llmobsChild.finish()
      llmobsParent.finish()
    }

    const { spans, llmobsSpans } = run(payloadGenerator)
    expect(spans).to.have.lengthOf(2)
    expect(llmobsSpans).to.have.lengthOf(2)

    const expected = [
      expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        spanKind: 'agent',
        tags
      }),
      expectedLLMObsLLMSpanEvent({
        span: spans[1],
        spanKind: 'llm',
        parentId: spans[0].context().toSpanId(),
        tags,
        inputMessages: [{ content: 'hello' }],
        outputMessages: [{ content: 'world' }],
        modelName: 'model',
        modelProvider: 'provider'
      })
    ]

    check(expected, llmobsSpans)
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

  it('instruments and uninstruments as needed', () => {
    payloadGenerator = function () {
      llmobs.disable()
      const parent = llmobs.startSpan({ kind: 'agent', name: 'llmobsParent' })
      llmobs.annotate({ inputData: 'hello', outputData: 'world' })

      llmobs.enable({ mlApp: 'test1' })
      const child1 = llmobs.startSpan({ kind: 'workflow', name: 'child1' })

      llmobs.disable()
      const child2 = llmobs.startSpan({ kind: 'workflow', name: 'child2' })

      llmobs.enable({ mlApp: 'test2' })
      const child3 = llmobs.startSpan({ kind: 'workflow', name: 'child3' })

      child3.finish()
      child2.finish()
      child1.finish()
      parent.finish()
    }

    const { spans, llmobsSpans } = run(payloadGenerator)
    expect(spans).to.have.lengthOf(4)
    expect(llmobsSpans).to.have.lengthOf(2)

    const expected = [
      expectedLLMObsNonLLMSpanEvent({
        span: spans[1],
        spanKind: 'workflow',
        tags: { ...tags, ml_app: 'test1' },
        name: 'child1'
      }),
      expectedLLMObsNonLLMSpanEvent({
        span: spans[3],
        spanKind: 'workflow',
        tags: { ...tags, ml_app: 'test2' },
        name: 'child3',
        parentId: spans[1].context().toSpanId()
      })
    ]

    check(expected, llmobsSpans)

    // restore original mlApp
    llmobs.disable()
    llmobs.enable({ mlApp: 'test' })
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
        tags: [`dd-trace.version:${tracerVersion}`, 'ml_app:test']
      }
    ]

    check(exptected, evaluationMetrics)

    Date.now.restore()
  })
})
