'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')

const { storage } = require('../../datadog-core')
const { PARENT_ID_KEY, ROOT_PARENT_ID } = require('../../dd-trace/src/llmobs/constants/tags')
const { storage: llmobsStorage } = require('../../dd-trace/src/llmobs/storage')
const LLMObsTagger = require('../../dd-trace/src/llmobs/tagger')
const { MODEL_BASE_URL_STORE_KEY, OpenAIAgentsIntegration } = require('../src/integration')
const { DDOpenAIAgentsProcessor } = require('../src/processor')

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

    it('keeps APM tracing enabled while opting out of LLM Observability', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const { integration, tracer } = build({
        tracerSpans: [workflowSpan],
        config: {
          llmobs: {
            DD_LLMOBS_ENABLED: true,
            mlApp: 'test',
            sampleRate: 1,
          },
        },
      })

      integration.configure({ enabled: true, llmobs: false })
      integration.startTrace({ traceId: 't1' })

      sinon.assert.calledOnce(tracer.startSpan)
      assert.strictEqual(LLMObsTagger.tagMap.get(workflowSpan), undefined)
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

    it('restores the active LLMObs parent before deferred workflow completion', () => {
      const llmobsParentSpan = makeFakeSpan('llmobs-parent')
      const unrelatedSpan = makeFakeSpan('unrelated')
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent')
      const config = {
        llmobs: {
          DD_LLMOBS_ENABLED: true,
          mlApp: 'test',
          sampleRate: 1,
        },
      }
      const { integration } = build({ tracerSpans: [workflowSpan, agentSpan], config })

      llmobsStorage.run({ span: llmobsParentSpan }, () => {
        integration.startTrace({ traceId: 't1' })
        integration.startSpan(
          { spanId: 's1', traceId: 't1', parentId: null, spanData: { type: 'agent' } },
          'agent'
        )

        integration.endTrace({ traceId: 't1' })

        assert.strictEqual(llmobsStorage.getStore().span, llmobsParentSpan)
        sinon.assert.notCalled(workflowSpan.finish)

        llmobsStorage.run({ span: unrelatedSpan }, () => {
          integration.endSpan({
            spanId: 's1',
            traceId: 't1',
            parentId: null,
            spanData: { type: 'agent' },
          })

          assert.strictEqual(llmobsStorage.getStore().span, unrelatedSpan)
        })

        sinon.assert.calledOnce(workflowSpan.finish)
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

  describe('untraced interior spans (agents-core >=0.14 task/turn)', () => {
    // agents-core 0.14 turned on task/turn tracing by default, so the emitted
    // hierarchy became `trace → task → agent → turn → {response|handoff|…}`.
    // Neither `task` nor `turn` has an LLMObs kind, so they produce no dd-trace
    // span — but they are interior nodes, so every descendant's parentId now
    // points at a span the integration never mapped.
    function driveSpan (processor, oaiSpan) {
      processor.onSpanStart(oaiSpan)
      return oaiSpan
    }

    function buildWithProcessor (options) {
      const { integration, tracer } = build(options)
      integration.configure({ enabled: true })
      return { integration, tracer, processor: new DDOpenAIAgentsProcessor(() => integration) }
    }

    const taskSpan = { spanId: 'task-1', traceId: 't1', parentId: null, spanData: { type: 'task' } }
    const agentASpan = {
      spanId: 'agent-a',
      traceId: 't1',
      parentId: 'task-1',
      spanData: { type: 'agent', name: 'agent_a' },
    }
    const turnSpan = { spanId: 'turn-1', traceId: 't1', parentId: 'agent-a', spanData: { type: 'turn' } }

    it('parents a response span under its agent rather than the workflow span', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const responseSpan = makeFakeSpan('response-dd')
      const { integration, tracer, processor } = buildWithProcessor({
        tracerSpans: [workflowSpan, agentSpan, responseSpan],
      })

      integration.startTrace({ traceId: 't1', name: 'my workflow' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)
      driveSpan(processor, turnSpan)
      driveSpan(processor, {
        spanId: 'resp-1',
        traceId: 't1',
        parentId: 'turn-1',
        spanData: { type: 'response' },
      })

      assert.strictEqual(tracer.startSpan.secondCall.args[0], 'agent_a')
      assert.strictEqual(tracer.startSpan.secondCall.args[1].childOf, workflowSpan)
      assert.strictEqual(tracer.startSpan.thirdCall.args[0], 'openai_agents.response')
      assert.strictEqual(tracer.startSpan.thirdCall.args[1].childOf, agentSpan)
    })

    it('parents a handoff span under the agent it transfers from', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const handoffSpan = makeFakeSpan('handoff-dd')
      const { integration, tracer, processor } = buildWithProcessor({
        tracerSpans: [workflowSpan, agentSpan, handoffSpan],
      })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)
      driveSpan(processor, turnSpan)
      const oaiHandoff = driveSpan(processor, {
        spanId: 'ho-1',
        traceId: 't1',
        parentId: 'turn-1',
        spanData: { type: 'handoff', from_agent: 'agent_a' },
      })

      assert.strictEqual(tracer.startSpan.thirdCall.args[1].childOf, agentSpan)

      oaiHandoff.spanData.to_agent = 'Agent B'
      processor.onSpanEnd(oaiHandoff)
      sinon.assert.calledWith(handoffSpan.setOperationName, 'transfer_to_agent_b')
    })

    it('resolves a turn spanId to the enclosing agent span so model calls are parented', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const { integration, processor } = buildWithProcessor({ tracerSpans: [workflowSpan, agentSpan] })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)
      driveSpan(processor, turnSpan)

      // `apm:openai-agents:model:start` carries getCurrentSpan().spanId, which
      // under 0.14 is the turn span. Without the ancestor walk the openai
      // plugin gets no active parent and openai.request becomes its own trace.
      assert.strictEqual(integration.getDDSpan('turn-1'), agentSpan)
      assert.strictEqual(integration.getDDSpan('agent-a'), agentSpan)
    })

    it('finishes the workflow span when an agent under an untraced parent errors', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const { integration, processor } = buildWithProcessor({ tracerSpans: [workflowSpan, agentSpan] })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)

      // agents-core's withTrace skips Trace.end() when its callback throws, so
      // no onTraceEnd arrives — the errored agent is the last chance to finish
      // the workflow span. An earlier processor may let task end reach us first.
      processor.onSpanEnd(taskSpan)
      sinon.assert.notCalled(workflowSpan.finish)
      processor.onSpanEnd({ ...agentASpan, error: { message: 'boom' } })

      sinon.assert.calledWith(workflowSpan.setTag, 'error', true)
      sinon.assert.calledWith(workflowSpan.setTag, 'error.message', 'boom')
      sinon.assert.calledOnce(workflowSpan.finish)
      sinon.assert.calledOnce(agentSpan.finish)
    })

    it('finishes the workflow span when the root task errors before an agent starts', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const { integration, processor } = buildWithProcessor({ tracerSpans: [workflowSpan] })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskSpan)

      processor.onSpanEnd({ ...taskSpan, error: { message: 'max turns exceeded' } })

      sinon.assert.calledWith(workflowSpan.setTag, 'error', true)
      sinon.assert.calledWith(workflowSpan.setTag, 'error.message', 'max turns exceeded')
      sinon.assert.calledOnce(workflowSpan.finish)
    })

    it('names the LLM span after the top-level agent and tags workflow input/output', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const responseSpan = makeFakeSpan('response-dd')
      const { integration, processor } = buildWithProcessor({
        tracerSpans: [workflowSpan, agentSpan, responseSpan],
        config: { llmobs: { DD_LLMOBS_ENABLED: true, mlApp: 'test', sampleRate: 1 } },
      })

      integration.startTrace({ traceId: 't1', name: 'my workflow' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)
      driveSpan(processor, turnSpan)
      const oaiResponse = driveSpan(processor, {
        spanId: 'resp-1',
        traceId: 't1',
        parentId: 'turn-1',
        spanData: {
          type: 'response',
          _input: 'what is the weather?',
          _response: { model: 'gpt-4o', output_text: 'sunny' },
        },
      })
      // Earlier processors can delay one callback without blocking later ones.
      // Keep the workflow and structural ancestry until the delayed response
      // has supplied the workflow output and every observed span has ended.
      integration.endTrace({ traceId: 't1' })
      processor.onSpanEnd(taskSpan)
      processor.onSpanEnd(turnSpan)
      sinon.assert.notCalled(workflowSpan.finish)
      processor.onSpanEnd(agentASpan)
      sinon.assert.notCalled(workflowSpan.finish)
      processor.onSpanEnd(oaiResponse)
      sinon.assert.calledOnce(workflowSpan.finish)

      const responseTags = LLMObsTagger.tagMap.get(responseSpan)
      assert.strictEqual(responseTags['_ml_obs.name'], 'agent_a (LLM)')
      assert.strictEqual(responseTags['_ml_obs.meta.model_name'], 'gpt-4o')
      assert.deepStrictEqual(responseTags['_ml_obs.meta.input.messages'], [
        { role: 'user', content: 'what is the weather?' },
      ])

      const workflowTags = LLMObsTagger.tagMap.get(workflowSpan)
      assert.strictEqual(workflowTags['_ml_obs.meta.input.value'], 'what is the weather?')
      assert.strictEqual(workflowTags['_ml_obs.meta.output.value'], 'sunny')
    })

    it('keeps ended structural ancestry until its delayed child completes', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const responseSpan = makeFakeSpan('response-dd')
      const { integration, processor } = buildWithProcessor({
        tracerSpans: [workflowSpan, agentSpan, responseSpan],
      })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)
      driveSpan(processor, turnSpan)
      const response = driveSpan(processor, {
        spanId: 'resp-1',
        traceId: 't1',
        parentId: 'turn-1',
        spanData: { type: 'response' },
      })
      assert.strictEqual(integration.getDDSpan('turn-1'), agentSpan)

      processor.onSpanEnd(turnSpan)

      assert.strictEqual(integration.getDDSpan('turn-1'), agentSpan)

      processor.onSpanEnd(response)

      assert.strictEqual(integration.getDDSpan('turn-1'), undefined)
      assert.strictEqual(integration.getDDSpan('agent-a'), agentSpan)

      processor.onSpanEnd(agentASpan)
      processor.onSpanEnd(taskSpan)
    })

    it('prunes completed turns while their task and agent remain active', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const { integration, processor } = buildWithProcessor({ tracerSpans: [workflowSpan, agentSpan] })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)

      for (let turn = 1; turn <= 3; turn++) {
        const spanId = `turn-${turn}`
        const turnOaiSpan = driveSpan(processor, {
          spanId,
          traceId: 't1',
          parentId: 'agent-a',
          spanData: { type: 'turn' },
        })
        assert.strictEqual(integration.getDDSpan(spanId), agentSpan)

        processor.onSpanEnd(turnOaiSpan)

        assert.strictEqual(integration.getDDSpan(spanId), undefined)
        assert.strictEqual(integration.getDDSpan('agent-a'), agentSpan)
      }

      processor.onSpanEnd(agentASpan)
      processor.onSpanEnd(taskSpan)
    })

    it('prunes a nested ended structural chain after its delayed descendant completes', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const responseSpan = makeFakeSpan('response-dd')
      const { integration, processor } = buildWithProcessor({
        tracerSpans: [workflowSpan, agentSpan, responseSpan],
      })
      const outerTurn = {
        spanId: 'turn-outer',
        traceId: 't1',
        parentId: 'agent-a',
        spanData: { type: 'turn' },
      }
      const innerTurn = {
        spanId: 'turn-inner',
        traceId: 't1',
        parentId: 'turn-outer',
        spanData: { type: 'turn' },
      }
      const response = {
        spanId: 'resp-1',
        traceId: 't1',
        parentId: 'turn-inner',
        spanData: { type: 'response' },
      }

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)
      driveSpan(processor, outerTurn)
      driveSpan(processor, innerTurn)
      driveSpan(processor, response)

      processor.onSpanEnd(outerTurn)
      processor.onSpanEnd(innerTurn)

      assert.strictEqual(integration.getDDSpan('turn-outer'), agentSpan)
      assert.strictEqual(integration.getDDSpan('turn-inner'), agentSpan)

      processor.onSpanEnd(response)

      assert.strictEqual(integration.getDDSpan('turn-outer'), undefined)
      assert.strictEqual(integration.getDDSpan('turn-inner'), undefined)

      processor.onSpanEnd(agentASpan)
      processor.onSpanEnd(taskSpan)
    })

    it('keeps ended structural ancestry until all concurrent children complete', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const firstResponseSpan = makeFakeSpan('response-1-dd')
      const secondResponseSpan = makeFakeSpan('response-2-dd')
      const { integration, processor } = buildWithProcessor({
        tracerSpans: [workflowSpan, agentSpan, firstResponseSpan, secondResponseSpan],
      })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)
      driveSpan(processor, turnSpan)
      const firstResponse = driveSpan(processor, {
        spanId: 'resp-1',
        traceId: 't1',
        parentId: 'turn-1',
        spanData: { type: 'response' },
      })
      const secondResponse = driveSpan(processor, {
        spanId: 'resp-2',
        traceId: 't1',
        parentId: 'turn-1',
        spanData: { type: 'response' },
      })

      processor.onSpanEnd(turnSpan)
      processor.onSpanEnd(firstResponse)

      assert.strictEqual(integration.getDDSpan('turn-1'), agentSpan)

      processor.onSpanEnd(secondResponse)

      assert.strictEqual(integration.getDDSpan('turn-1'), undefined)

      processor.onSpanEnd(agentASpan)
      processor.onSpanEnd(taskSpan)
    })

    it('ignores a duplicate structural end while an active child retains the span', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-a-dd')
      const responseSpan = makeFakeSpan('response-dd')
      const { integration, processor } = buildWithProcessor({
        tracerSpans: [workflowSpan, agentSpan, responseSpan],
      })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskSpan)
      driveSpan(processor, agentASpan)
      driveSpan(processor, turnSpan)
      const response = driveSpan(processor, {
        spanId: 'resp-1',
        traceId: 't1',
        parentId: 'turn-1',
        spanData: { type: 'response' },
      })

      processor.onSpanEnd(turnSpan)
      processor.onSpanEnd(turnSpan)
      assert.strictEqual(integration.getDDSpan('turn-1'), agentSpan)

      integration.endTrace({ traceId: 't1' })
      processor.onSpanEnd(taskSpan)
      processor.onSpanEnd(agentASpan)

      sinon.assert.notCalled(workflowSpan.finish)

      processor.onSpanEnd(response)

      sinon.assert.calledOnce(workflowSpan.finish)
      assert.strictEqual(integration.getDDSpan('turn-1'), undefined)
    })

    for (const depth of [32, 33]) {
      it(`prunes a completed structural chain at depth ${depth}`, () => {
        const workflowSpan = makeFakeSpan('workflow')
        const agentSpan = makeFakeSpan('agent-a-dd')
        const responseSpan = makeFakeSpan('response-dd')
        const { integration, processor } = buildWithProcessor({
          tracerSpans: [workflowSpan, agentSpan, responseSpan],
        })
        const turns = []

        integration.startTrace({ traceId: 't1' })
        driveSpan(processor, taskSpan)
        driveSpan(processor, agentASpan)

        for (let index = 1; index <= depth; index++) {
          const turn = {
            spanId: `turn-${index}`,
            traceId: 't1',
            parentId: index === 1 ? 'agent-a' : `turn-${index - 1}`,
            spanData: { type: 'turn' },
          }
          turns.push(turn)
          driveSpan(processor, turn)
        }

        const response = driveSpan(processor, {
          spanId: 'resp-1',
          traceId: 't1',
          parentId: `turn-${depth}`,
          spanData: { type: 'response' },
        })

        for (const turn of turns) processor.onSpanEnd(turn)
        processor.onSpanEnd(response)

        assert.strictEqual(integration.getDDSpan('turn-1'), undefined)

        processor.onSpanEnd(agentASpan)
        processor.onSpanEnd(taskSpan)
      })
    }

    it('completes and cleans concurrent traces independently', () => {
      const workflowOne = makeFakeSpan('workflow-1')
      const agentOne = makeFakeSpan('agent-1')
      const workflowTwo = makeFakeSpan('workflow-2')
      const agentTwo = makeFakeSpan('agent-2')
      const { integration, processor } = buildWithProcessor({
        tracerSpans: [workflowOne, agentOne, workflowTwo, agentTwo],
      })
      const taskOne = { spanId: 'task-1', traceId: 't1', parentId: null, spanData: { type: 'task' } }
      const agentOneOai = {
        spanId: 'agent-1',
        traceId: 't1',
        parentId: 'task-1',
        spanData: { type: 'agent' },
      }
      const taskTwo = { spanId: 'task-2', traceId: 't2', parentId: null, spanData: { type: 'task' } }
      const agentTwoOai = {
        spanId: 'agent-2',
        traceId: 't2',
        parentId: 'task-2',
        spanData: { type: 'agent' },
      }
      const turnTwo = { spanId: 'turn-2', traceId: 't2', parentId: 'agent-2', spanData: { type: 'turn' } }

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, taskOne)
      driveSpan(processor, agentOneOai)
      integration.startTrace({ traceId: 't2' })
      driveSpan(processor, taskTwo)
      driveSpan(processor, agentTwoOai)
      driveSpan(processor, turnTwo)

      integration.endTrace({ traceId: 't1' })
      processor.onSpanEnd(taskOne)
      processor.onSpanEnd(agentOneOai)

      sinon.assert.calledOnce(workflowOne.finish)
      sinon.assert.notCalled(workflowTwo.finish)
      assert.strictEqual(integration.getDDSpan('turn-2'), agentTwo)

      integration.endTrace({ traceId: 't2' })
      processor.onSpanEnd(agentTwoOai)
      processor.onSpanEnd(taskTwo)
      processor.onSpanEnd(turnTwo)

      sinon.assert.calledOnce(workflowTwo.finish)
    })

    it('keeps the pre-0.14 flat hierarchy unchanged', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const agentSpan = makeFakeSpan('agent-dd')
      const responseSpan = makeFakeSpan('response-dd')
      const { integration, tracer, processor } = buildWithProcessor({
        tracerSpans: [workflowSpan, agentSpan, responseSpan],
      })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, { spanId: 'agent-a', traceId: 't1', parentId: null, spanData: { type: 'agent' } })
      driveSpan(processor, {
        spanId: 'resp-1',
        traceId: 't1',
        parentId: 'agent-a',
        spanData: { type: 'response' },
      })

      assert.strictEqual(tracer.startSpan.secondCall.args[1].childOf, workflowSpan)
      assert.strictEqual(tracer.startSpan.thirdCall.args[1].childOf, agentSpan)
      assert.strictEqual(integration.getDDSpan('agent-a'), agentSpan)
    })

    it('falls back to the trace root without spinning on a cyclic untraced chain', () => {
      const workflowSpan = makeFakeSpan('workflow')
      const responseSpan = makeFakeSpan('response-dd')
      const { integration, tracer, processor } = buildWithProcessor({
        tracerSpans: [workflowSpan, responseSpan],
      })

      integration.startTrace({ traceId: 't1' })
      driveSpan(processor, { spanId: 'u1', traceId: 't1', parentId: 'u2', spanData: { type: 'turn' } })
      driveSpan(processor, { spanId: 'u2', traceId: 't1', parentId: 'u1', spanData: { type: 'turn' } })
      driveSpan(processor, { spanId: 'resp-1', traceId: 't1', parentId: 'u1', spanData: { type: 'response' } })

      assert.strictEqual(tracer.startSpan.secondCall.args[1].childOf, workflowSpan)
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
