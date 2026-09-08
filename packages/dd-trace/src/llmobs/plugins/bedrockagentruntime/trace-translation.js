'use strict'

const log = require('../../../log')
const { parseModelId } = require('../../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')

const DEFAULT_SPAN_DURATION_MS = 1
const SUPPORTED_TRACE_TYPES = new Set([
  'customOrchestrationTrace',
  'failureTrace',
  'guardrailTrace',
  'orchestrationTrace',
  'postProcessingTrace',
  'preProcessingTrace',
  'routingClassifierTrace',
])
const SPECIAL_TRACE_TYPES = new Set(['customOrchestrationTrace', 'failureTrace', 'guardrailTrace'])

/**
 * @typedef {import('../../../../opentracing/span')} Span
 * @typedef {{ span: Span, inputValue?: string, outputValue?: string, hasInput: boolean, children: Span[] }} StepState
 * @typedef {{ tracer: object, tagger: object, rootSpan: Span, traces: object[] }} TranslationOptions
 */

function timeMs (value, fallback) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  if (typeof value === 'number') return value
  return fallback
}

function eventStart (trace, rootSpan) {
  return timeMs(trace.eventTime, rootSpan._startTime)
}

function metadataTiming (metadata, rootSpan) {
  const start = timeMs(metadata?.startTime, rootSpan._startTime)
  const duration = typeof metadata?.totalTimeMs === 'number' ? metadata.totalTimeMs : DEFAULT_SPAN_DURATION_MS
  return { start, duration }
}

function traceType (trace) {
  const value = trace?.trace
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1) return ''
  const type = Object.keys(value)[0]
  return SUPPORTED_TRACE_TYPES.has(type) ? type : ''
}

function traceStepId (trace) {
  const type = traceType(trace)
  if (!type) return
  const value = trace?.trace?.[type]
  if (!value || typeof value !== 'object' || !Object.keys(value)[0]) return
  if (value.traceId) return value.traceId
  if (SPECIAL_TRACE_TYPES.has(type) || Object.keys(value).length !== 1) return
  const nested = Object.values(value)
  return nested[0] && typeof nested[0] === 'object' ? nested[0].traceId : undefined
}

function json (value) {
  return JSON.stringify(value)
}

function createSpan (tracer, tagger, name, kind, parent, start, metadata, input, output) {
  const span = tracer.startSpan(name, {
    childOf: parent,
    startTime: start,
    tags: { 'span.type': 'llm' },
  })
  tagger.registerLLMObsSpan(span, {
    parent,
    kind,
    name,
    sessionId: undefined,
    integration: 'bedrock_agents',
  })
  if (metadata) tagger.tagMetadata(span, metadata)
  if (kind === 'llm') {
    if (input !== undefined || output !== undefined) tagger.tagLLMIO(span, input, output)
  } else if (input !== undefined || output !== undefined) {
    tagger.tagTextIO(span, input, output)
  }
  return span
}

function propagate (state, input, output) {
  if (input && !state.inputValue) {
    state.inputValue = typeof input === 'string' ? input : json(input)
    state.hasInput = true
  }
  if (output) state.outputValue = typeof output === 'string' ? output : json(output)
}

function modelInput (trace, value, parent, rootSpan, tagger, tracer, state) {
  let parsed
  try {
    parsed = JSON.parse(value.text || '{}')
  } catch {
    parsed = {}
  }
  const messages = [{ role: 'system', content: parsed.system || '' },
    ...(parsed.messages || []).map(message => ({ role: message.role || '', content: message.content || '' }))]
  const parsedModel = parseModelId(value.foundationModel || '')
  const span = createSpan(
    tracer,
    tagger,
    'modelInvocation',
    'llm',
    parent,
    eventStart(trace, rootSpan),
    { model_name: parsedModel.modelName, model_provider: parsedModel.modelProvider },
    messages
  )
  state.children.push(span)
  propagate(state, json(messages))
  return span
}

function modelOutput (value, pending, parentState, rootSpan, tagger) {
  if (!pending) return
  const { start, duration } = metadataTiming(value.metadata, rootSpan)
  const parsed = value.parsedResponse
  const content = parsed && json(parsed) !== '{}' ? json(parsed) : (value.rawResponse?.content || '')
  const output = [{ role: 'assistant', content }]
  tagger.tagLLMIO(pending, undefined, output)
  const usage = value.metadata?.usage || {}
  tagger.tagMetrics(pending, {
    input_tokens: usage.inputTokens || 0,
    output_tokens: usage.outputTokens || 0,
    total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
  })
  const reasoningText = value.reasoningContent?.reasoningText?.text
  if (reasoningText) tagger.tagMetadata(pending, { reasoningText: String(reasoningText) })
  propagate(parentState, undefined, json(output))
  pending._startTime = start
  pending.finish(start + duration)
}

function toolInput (trace, value, parent, rootSpan, tagger, tracer, state) {
  const type = value.invocationType
  let name = ''
  let args = {}
  let metadata
  if (type === 'ACTION_GROUP') {
    const input = value.actionGroupInvocationInput || {}
    name = input.actionGroupName
    args = Object.fromEntries((input.parameters || []).map(arg => [arg.name, String(arg.value)]))
    metadata = { function: input.function || '', execution_type: input.executionType || '' }
  } else if (type === 'AGENT_COLLABORATOR') {
    const input = value.agentCollaboratorInvocationInput || {}
    name = input.agentCollaboratorName
    args = { text: String(input.input?.text || '') }
  } else if (type === 'ACTION_GROUP_CODE_INTERPRETER') {
    const input = value.codeInterpreterInvocationInput || {}
    name = input.actionGroupName
    args = { code: String(input.code || ''), files: String(input.files || '') }
  } else if (type === 'KNOWLEDGE_BASE') {
    const input = value.knowledgeBaseLookupInput || {}
    name = input.knowledgeBaseId
    args = { text: String(input.text || '') }
  }
  const span = createSpan(tracer, tagger, name || '', 'tool', parent, eventStart(trace, rootSpan), metadata, json(args))
  state.children.push(span)
  propagate(state, json(args))
  return span
}

function toolOutput (value, pending, parentState, rootSpan, tagger) {
  if (!pending) return
  const type = value.type
  if (type === 'FINISH' || type === 'REPROMPT') return
  let output = ''
  let metadata
  if (type === 'ACTION_GROUP') {
    const part = value.actionGroupInvocationOutput || {}
    output = part.text || ''
    metadata = part.metadata
  } else if (type === 'AGENT_COLLABORATOR') {
    const part = value.agentCollaboratorInvocationOutput || {}
    output = part.output?.text || ''
    metadata = part.metadata
  } else if (type === 'KNOWLEDGE_BASE') {
    const part = value.knowledgeBaseLookupOutput || {}
    output = (part.retrievedReferences || []).reduce((result, reference) => {
      const text = reference?.content?.text || ''
      return result ? `${result}\n${text}` : text
    }, '')
    metadata = part.metadata
  } else if (type === 'ACTION_GROUP_CODE_INTERPRETER') {
    const part = value.codeInterpreterInvocationOutput || {}
    output = part.executionOutput || ''
    metadata = part.metadata
  }
  const { start, duration } = metadataTiming(metadata, rootSpan)
  tagger.tagTextIO(pending, undefined, output)
  propagate(parentState, undefined, output)
  pending._startTime = start
  pending.finish(start + duration)
}

function translateOne (trace, state, pending, rootSpan, tagger, tracer) {
  const type = traceType(trace)
  const value = trace?.trace?.[type] || {}
  const nested = value
  if (type === 'customOrchestrationTrace') {
    const span = createSpan(tracer, tagger, 'customOrchestration', 'task', state.span,
      eventStart(trace, rootSpan), undefined, undefined, value.event?.text || '')
    state.children.push(span)
    span.finish(eventStart(trace, rootSpan) + DEFAULT_SPAN_DURATION_MS)
    return
  }
  if (type === 'failureTrace') {
    const timing = metadataTiming(value.metadata, rootSpan)
    const span = createSpan(tracer, tagger, 'failureEvent', 'task', state.span, timing.start)
    span.setTag('error', 1)
    span.setTag('error.type', value.failureType || String(value.failureCode || ''))
    span.setTag('error.message', value.failureReason || '')
    rootSpan.setTag('error', Object.assign(new Error(value.failureReason || ''), {
      name: 'BedrockFailureException',
    }))
    state.children.push(span)
    span.finish(timing.start + timing.duration)
    return
  }
  if (type === 'guardrailTrace') {
    const timing = metadataTiming(value.metadata, rootSpan)
    const output = json({
      action: value.action || '',
      inputAssessments: value.inputAssessments || [],
      outputAssessments: value.outputAssessments || [],
    })
    const span = createSpan(tracer, tagger, 'guardrail', 'task', state.span, timing.start, undefined, undefined, output)
    state.children.push(span)
    if (value.action === 'INTERVENED') {
      span.setTag('error', 1)
      span.setTag('error.type', 'GuardrailTriggered')
      span.setTag('error.message', 'Guardrail intervened')
      rootSpan.setTag('error', Object.assign(new Error('Guardrail intervened'), {
        name: 'BedrockGuardrailTriggeredException',
      }))
    }
    span.finish(timing.start + timing.duration)
    return
  }
  if (nested.modelInvocationInput) {
    return modelInput(trace, nested.modelInvocationInput, state.span, rootSpan, tagger, tracer, state)
  }
  if (nested.modelInvocationOutput) {
    modelOutput(nested.modelInvocationOutput, pending, state, rootSpan, tagger)
    return
  }
  if (nested.rationale) {
    const text = nested.rationale.text || ''
    const span = createSpan(
      tracer,
      tagger,
      'reasoning',
      'task',
      state.span,
      eventStart(trace, rootSpan),
      undefined,
      undefined,
      text
    )
    state.children.push(span)
    propagate(state, undefined, text)
    span.finish(eventStart(trace, rootSpan) + DEFAULT_SPAN_DURATION_MS)
    return
  }
  if (nested.invocationInput) {
    return toolInput(trace, nested.invocationInput, state.span, rootSpan, tagger, tracer, state)
  }
  if (nested.observation) {
    toolOutput(nested.observation, pending, state, rootSpan, tagger)
  }
}

/**
 * Translate Bedrock Agent trace parts into nested LLMObs spans.
 * @param {TranslationOptions} options
 * @returns {void}
 */
function translateBedrockTraces ({ tracer, tagger, rootSpan, traces }) {
  /** @type {Map<string, StepState>} */
  const steps = new Map()
  /** @type {Map<string, Span>} */
  const pending = new Map()

  if (!traces) return
  for (const trace of traces) {
    if (!traceType(trace)) {
      log.debug('Skipping unsupported Bedrock Agent trace')
      continue
    }
    const id = traceStepId(trace)
    if (!id) continue
    let state = steps.get(id)
    if (!state) {
      const type = traceType(trace) || 'Bedrock Agent'
      const span = createSpan(
        tracer,
        tagger,
        `${type} Step`,
        'workflow',
        rootSpan,
        eventStart(trace, rootSpan),
        { bedrock_trace_id: id }
      )
      state = { span, hasInput: false, children: [] }
      steps.set(id, state)
    }
    const child = translateOne(trace, state, pending.get(id), rootSpan, tagger, tracer)
    pending.delete(id)
    if (child) pending.set(id, child)
  }

  for (const [id, state] of steps) {
    const orphan = pending.get(id)
    if (orphan) orphan.finish(orphan._startTime + DEFAULT_SPAN_DURATION_MS)
    for (const child of state.children) {
      if (child._duration === undefined) child.finish(child._startTime + DEFAULT_SPAN_DURATION_MS)
    }
    if (state.inputValue || state.outputValue) tagger.tagTextIO(state.span, state.inputValue, state.outputValue)
    const childEnds = state.children.map(child => child._startTime + (child._duration || DEFAULT_SPAN_DURATION_MS))
    const end = childEnds.length ? Math.max(...childEnds) : state.span._startTime + DEFAULT_SPAN_DURATION_MS
    if (state.children.length) {
      state.span._startTime = Math.min(state.span._startTime, ...state.children.map(child => child._startTime))
    }
    state.span.finish(end)
  }
}

module.exports = { translateBedrockTraces }
