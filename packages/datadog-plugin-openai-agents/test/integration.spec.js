'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')

const { storage } = require('../../datadog-core')
const { PARENT_ID_KEY, ROOT_PARENT_ID } = require('../../dd-trace/src/llmobs/constants/tags')
const { storage: llmobsStorage } = require('../../dd-trace/src/llmobs/storage')
const LLMObsTagger = require('../../dd-trace/src/llmobs/tagger')
const { MODEL_BASE_URL_STORE_KEY, OpenAIAgentsIntegration } = require('../src/integration')

const legacyStorage = storage('legacy')

function makeFakeSpan (spanId = 'dd-span-id') {
  const context = {
    _trace: { tags: {} },
    toSpanId: () => spanId,
    toTraceId: () => '00000000000000001111111111111111',
  }

  return {
    setTag: sinon.stub(),
    setOperationName: sinon.stub(),
    finish: sinon.stub(),
    context: () => context,
  }
}

function makeFakeTracer (preseededSpans = []) {
  const startSpan = sinon.stub()
  preseededSpans.forEach((span, i) => startSpan.onCall(i).returns(span))
  startSpan.callsFake(() => makeFakeSpan())
  return { startSpan }
}

function build ({
  tracerSpans = [],
  config = { llmobs: { DD_LLMOBS_ENABLED: false } },
} = {}) {
  const tracer = makeFakeTracer(tracerSpans)
  const integration = new OpenAIAgentsIntegration({
    tracer,
    config,
  })
  return { integration, tracer }
}

afterEach(() => {
  legacyStorage.enterWith(undefined)
  llmobsStorage.enterWith(undefined)
  sinon.restore()
})

describe('OpenAIAgentsIntegration', () => {
  describe('enabled flag', () => {
    it('starts disabled and follows plugin configuration', () => {
      const { integration } = build()
      assert.strictEqual(integration.enabled, false)
      integration.configure({ enabled: true })
      assert.strictEqual(integration.enabled, true)
      integration.configure({ enabled: false })
      assert.strictEqual(integration.enabled, false)
    })
  })

  describe('startTrace', () => {
    it('does nothing when traceId is missing', () => {
      const { integration, tracer } = build()
      integration.startTrace({})
      sinon.assert.notCalled(tracer.startSpan)
    })

    it('falls back to the default workflow name when oaiTrace.name is empty', () => {
      const { integration, tracer } = build()
      integration.startTrace({ traceId: 't1' })
      sinon.assert.calledOnce(tracer.startSpan)
      assert.strictEqual(tracer.startSpan.firstCall.args[0], 'Agent workflow')
    })

    it('uses oaiTrace.name when provided', () => {
      const { integration, tracer } = build()
      integration.startTrace({ traceId: 't1', name: 'My workflow', groupId: 'g1' })
      assert.strictEqual(tracer.startSpan.firstCall.args[0], 'My workflow')
    })

    it('parents the workflow to the active Datadog span and applies the configured service', () => {
      const parentSpan = makeFakeSpan('parent')
      const { integration, tracer } = build()
      integration.configure({ enabled: true, service: 'agents-service' })

      legacyStorage.run({ span: parentSpan }, () => {
        integration.startTrace({ traceId: 't1' })
      })

      assert.strictEqual(tracer.startSpan.firstCall.args[1].childOf, parentSpan)
      assert.strictEqual(tracer.startSpan.firstCall.args[1].tags.service, 'agents-service')
    })

    it('does not use an APM-only parent as the LLMObs parent', () => {
      const parentSpan = makeFakeSpan('apm-parent')
      const workflowSpan = makeFakeSpan('workflow')
      const { integration } = build({
        tracerSpans: [workflowSpan],
        config: {
          llmobs: {
            DD_LLMOBS_ENABLED: true,
            mlApp: 'test',
            sampleRate: 1,
          },
        },
      })

      legacyStorage.run({ span: parentSpan }, () => {
        integration.startTrace({ traceId: 't1' })
      })

      assert.strictEqual(LLMObsTagger.tagMap.get(workflowSpan)[PARENT_ID_KEY], ROOT_PARENT_ID)
    })

    it('uses and restores the active LLMObs parent independently of the APM parent', () => {
      const apmParentSpan = makeFakeSpan('apm-parent')
      const llmobsParentSpan = makeFakeSpan('llmobs-parent')
      const workflowSpan = makeFakeSpan('workflow')
      const config = {
        llmobs: {
          DD_LLMOBS_ENABLED: true,
          mlApp: 'test',
          sampleRate: 1,
        },
      }
      const { integration, tracer } = build({ tracerSpans: [workflowSpan], config })
      const tagger = new LLMObsTagger(config, true)
      tagger.registerLLMObsSpan(llmobsParentSpan, {
        kind: 'workflow',
        name: 'outer workflow',
      })

      llmobsStorage.run({ span: llmobsParentSpan }, () => {
        legacyStorage.run({ span: apmParentSpan }, () => {
          integration.startTrace({ traceId: 't1' })

          assert.strictEqual(tracer.startSpan.firstCall.args[1].childOf, apmParentSpan)
          assert.strictEqual(
            LLMObsTagger.tagMap.get(workflowSpan)[PARENT_ID_KEY],
            'llmobs-parent'
          )
          assert.strictEqual(llmobsStorage.getStore().span, workflowSpan)

          integration.endTrace({ traceId: 't1' })
          assert.strictEqual(llmobsStorage.getStore().span, llmobsParentSpan)
        })
      })
    })

    it('registers LLMObs spans when DD_LLMOBS_ENABLED is true', () => {
      const workflowSpan = makeFakeSpan()
      const { integration } = build({
        tracerSpans: [workflowSpan],
        config: {
          llmobs: {
            DD_LLMOBS_ENABLED: true,
            mlApp: 'test',
            sampleRate: 1,
          },
        },
      })

      integration.startTrace({ traceId: 't1' })

      assert.strictEqual(LLMObsTagger.tagMap.get(workflowSpan)['_ml_obs.meta.span.kind'], 'workflow')
    })

    it('registers spans after LLMObs is enabled at runtime', () => {
      const config = { llmobs: { DD_LLMOBS_ENABLED: false, mlApp: 'test', sampleRate: 1 } }
      const disabledSpan = makeFakeSpan()
      const enabledSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [disabledSpan, enabledSpan], config })

      integration.startTrace({ traceId: 'disabled' })
      assert.strictEqual(LLMObsTagger.tagMap.get(disabledSpan), undefined)
      integration.endTrace({ traceId: 'disabled' })

      config.llmobs.DD_LLMOBS_ENABLED = true
      integration.startTrace({ traceId: 'enabled' })

      assert.strictEqual(LLMObsTagger.tagMap.get(enabledSpan)['_ml_obs.meta.span.kind'], 'workflow')
    })
  })

  describe('endTrace / #completeWorkflowSpan', () => {
    it('does nothing when traceId is missing', () => {
      const { integration } = build()
      integration.endTrace({})
    })

    it('does nothing when no span is mapped to the traceId', () => {
      const { integration } = build()
      integration.endTrace({ traceId: 'unknown' })
    })

    it('applies a rootAgentSpan error with a message onto the workflow span', () => {
      const workflowSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [workflowSpan, makeFakeSpan()] })
      integration.startTrace({ traceId: 't1' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', parentId: null, spanData: { type: 'agent' } },
        'agent'
      )
      integration.endSpan({
        spanId: 's1',
        traceId: 't1',
        parentId: null,
        spanData: { type: 'agent' },
        error: { message: 'oh no' },
      })
      sinon.assert.calledWith(workflowSpan.setTag, 'error', true)
      sinon.assert.calledWith(workflowSpan.setTag, 'error.type', sinon.match.string)
      sinon.assert.calledWith(workflowSpan.setTag, 'error.message', 'oh no')
      sinon.assert.called(workflowSpan.finish)
    })

    it('still flags an error when rootAgentSpan.error has no message', () => {
      const workflowSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [workflowSpan, makeFakeSpan()] })
      integration.startTrace({ traceId: 't1' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', parentId: null, spanData: { type: 'agent' } },
        'agent'
      )
      integration.endSpan({
        spanId: 's1',
        traceId: 't1',
        parentId: null,
        spanData: { type: 'agent' },
        error: {},
      })
      sinon.assert.calledWith(workflowSpan.setTag, 'error', true)
      const messageCalls = workflowSpan.setTag.getCalls().filter(c => c.args[0] === 'error.message')
      assert.strictEqual(messageCalls.length, 0)
    })

    it('keeps the workflow open when a successful top-level agent ends', () => {
      const workflowSpan = makeFakeSpan()
      const agentSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [workflowSpan, agentSpan] })
      integration.startTrace({ traceId: 't1' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', parentId: null, spanData: { type: 'agent' } },
        'agent'
      )

      integration.endSpan({
        spanId: 's1',
        traceId: 't1',
        parentId: null,
        spanData: { type: 'agent' },
      })

      sinon.assert.notCalled(workflowSpan.finish)
      integration.endTrace({ traceId: 't1' })
      sinon.assert.calledOnce(workflowSpan.finish)

      integration.endTrace({ traceId: 't1' })
      sinon.assert.calledOnce(workflowSpan.finish)
    })
  })

  describe('startSpan', () => {
    it('does nothing when spanId is missing', () => {
      const { integration, tracer } = build()
      integration.startSpan({}, 'agent')
      sinon.assert.notCalled(tracer.startSpan)
    })

    it('does not start a duplicate span when the processor observes a tool after invoke', () => {
      const { integration, tracer } = build()
      const oaiSpan = { spanId: 's1', traceId: 't1', spanData: { type: 'function' } }

      const toolSpan = integration.getOrStartToolSpan(oaiSpan)
      integration.startSpan(oaiSpan, 'tool')

      assert.strictEqual(integration.getDDSpan('s1'), toolSpan)
      sinon.assert.calledOnce(tracer.startSpan)
    })

    it('defaults span.kind to internal for unknown LLMObs kinds', () => {
      const { integration, tracer } = build()
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'custom' } },
        'unknown-kind'
      )
      const tags = tracer.startSpan.firstCall.args[1].tags
      assert.strictEqual(tags['span.kind'], 'internal')
    })

    it('maps llm kind to span.kind=client', () => {
      const { integration, tracer } = build()
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'response' } },
        'llm'
      )
      const tags = tracer.startSpan.firstCall.args[1].tags
      assert.strictEqual(tags['span.kind'], 'client')
    })

    it('maps agent kind to span.kind=internal', () => {
      const { integration, tracer } = build()
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'agent' } },
        'agent'
      )
      const tags = tracer.startSpan.firstCall.args[1].tags
      assert.strictEqual(tags['span.kind'], 'internal')
    })

    it('applies the configured service to child spans', () => {
      const { integration, tracer } = build()
      integration.configure({ enabled: true, service: 'agents-service' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'agent' } },
        'agent'
      )
      assert.strictEqual(tracer.startSpan.firstCall.args[1].tags.service, 'agents-service')
    })

    it('resolves model provider from each model invocation store', () => {
      const azureSpan = makeFakeSpan('azure')
      const deepseekSpan = makeFakeSpan('deepseek')
      const { integration } = build({
        tracerSpans: [azureSpan, deepseekSpan],
        config: {
          llmobs: {
            DD_LLMOBS_ENABLED: true,
            mlApp: 'test',
            sampleRate: 1,
          },
        },
      })

      legacyStorage.run({ [MODEL_BASE_URL_STORE_KEY]: 'https://resource.openai.azure.com' }, () => {
        integration.startSpan(
          { spanId: 'azure', traceId: 't1', spanData: { type: 'response' } },
          'llm'
        )
      })
      legacyStorage.run({ [MODEL_BASE_URL_STORE_KEY]: 'https://api.deepseek.com' }, () => {
        integration.startSpan(
          { spanId: 'deepseek', traceId: 't2', spanData: { type: 'response' } },
          'llm'
        )
      })

      assert.strictEqual(LLMObsTagger.tagMap.get(azureSpan)['_ml_obs.meta.model_provider'], 'azure_openai')
      assert.strictEqual(LLMObsTagger.tagMap.get(deepseekSpan)['_ml_obs.meta.model_provider'], 'deepseek')
    })
  })

  describe('endSpan', () => {
    it('does nothing when spanId is unknown', () => {
      const { integration } = build()
      integration.endSpan({ spanId: 'missing', spanData: { type: 'function' } })
    })

    it('finishes the dd-trace span on end', () => {
      const ddSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [ddSpan] })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'function' } },
        'tool'
      )
      integration.endSpan({ spanId: 's1', spanData: { type: 'function' } })
      sinon.assert.called(ddSpan.finish)
    })

    it('renames handoff spans after the target agent is available', () => {
      const ddSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [ddSpan] })
      const oaiSpan = {
        spanId: 's1',
        traceId: 't1',
        spanData: { type: 'handoff', from_agent: 'agent_a' },
      }
      integration.startSpan(oaiSpan, 'tool')
      oaiSpan.spanData.to_agent = 'Agent B'

      integration.endSpan(oaiSpan)

      sinon.assert.calledWith(ddSpan.setOperationName, 'transfer_to_agent_b')
    })

    it('tags Chat Completions generation data', () => {
      const ddSpan = makeFakeSpan()
      const { integration } = build({
        tracerSpans: [ddSpan],
        config: {
          llmobs: {
            DD_LLMOBS_ENABLED: true,
            mlApp: 'test',
            sampleRate: 1,
          },
        },
      })
      const oaiSpan = {
        spanId: 's1',
        traceId: 't1',
        spanData: {
          type: 'generation',
          model: 'gpt-4o',
          model_config: { temperature: 0.2 },
          input: [{ role: 'user', content: 'hello' }],
          output: [{
            choices: [{ message: { role: 'assistant', content: 'hi' } }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }],
        },
      }

      integration.startSpan(oaiSpan, 'llm')
      integration.endSpan(oaiSpan)

      const tags = LLMObsTagger.tagMap.get(ddSpan)
      assert.strictEqual(tags['_ml_obs.meta.model_name'], 'gpt-4o')
      assert.strictEqual(tags['_ml_obs.meta.model_provider'], 'openai')
      assert.deepStrictEqual(tags['_ml_obs.meta.input.messages'], [{ role: 'user', content: 'hello' }])
      assert.deepStrictEqual(tags['_ml_obs.meta.output.messages'], [{ role: 'assistant', content: 'hi' }])
      assert.deepStrictEqual(tags['_ml_obs.meta.metadata'], { temperature: 0.2 })
      assert.deepStrictEqual(tags['_ml_obs.metrics'], {
        input_tokens: 2,
        output_tokens: 1,
        total_tokens: 3,
      })
    })
  })

  describe('#resolveParent', () => {
    it('uses the parent dd-trace span when parentId is mapped', () => {
      const parentSpan = makeFakeSpan()
      const childSpan = makeFakeSpan()
      const { integration, tracer } = build({ tracerSpans: [parentSpan, childSpan] })
      integration.startSpan(
        { spanId: 'p1', traceId: 't1', spanData: { type: 'agent' } },
        'agent'
      )
      integration.startSpan(
        { spanId: 'c1', traceId: 't1', parentId: 'p1', spanData: { type: 'function' } },
        'tool'
      )
      assert.strictEqual(tracer.startSpan.secondCall.args[1].childOf, parentSpan)
    })

    it('falls back to the trace root span when parentId has no mapping', () => {
      const root = makeFakeSpan()
      const child = makeFakeSpan()
      const { integration, tracer } = build({ tracerSpans: [root, child] })
      integration.startTrace({ traceId: 't1' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', parentId: 'unknown-parent', spanData: { type: 'agent' } },
        'agent'
      )
      assert.strictEqual(tracer.startSpan.secondCall.args[1].childOf, root)
    })

    it('returns undefined when neither parent nor trace root is mapped', () => {
      const orphan = makeFakeSpan()
      const { integration, tracer } = build({ tracerSpans: [orphan] })
      integration.startSpan(
        { spanId: 's1', traceId: 'no-trace', parentId: 'no-parent', spanData: { type: 'agent' } },
        'agent'
      )
      assert.strictEqual(tracer.startSpan.firstCall.args[1].childOf, undefined)
    })
  })

  describe('clearState', () => {
    it('finishes every in-flight dd-trace span and clears bookkeeping', () => {
      const workflow = makeFakeSpan()
      const agentSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [workflow, agentSpan] })
      integration.startTrace({ traceId: 't1' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'agent' } },
        'agent'
      )
      integration.clearState()
      sinon.assert.called(workflow.finish)
      sinon.assert.called(agentSpan.finish)
      // After clearState, a second endTrace should be a no-op because the
      // span map was cleared.
      integration.endTrace({ traceId: 't1' })
    })
  })
})
