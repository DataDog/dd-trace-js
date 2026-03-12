'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const runCh = dc.tracingChannel('apm:openai-agents:run')
const toolCh = dc.tracingChannel('apm:openai-agents:tool')
const handoffCh = dc.tracingChannel('apm:openai-agents:handoff')

addHook({ name: '@openai/agents-core', file: 'dist/run.js', versions: ['>=0.1.0'] }, exports => {
  // Wrap the top-level run() function
  shimmer.wrap(exports, 'run', origRun => async function wrappedRun (agent, input, options) {
    if (!runCh.start.hasSubscribers) {
      return origRun.apply(this, arguments)
    }

    const ctx = {
      agent,
      input,
      options,
      agentName: agent?.name,
      model: agent?.model,
      isTopLevelRun: true
    }

    return runCh.tracePromise(origRun, ctx, this, ...arguments)
  })

  // Wrap Runner.prototype.run
  const RunnerProto = exports.Runner?.prototype
  if (RunnerProto) {
    shimmer.wrap(RunnerProto, 'run', origRun => async function wrappedRunnerRun (agent, input, options) {
      if (!runCh.start.hasSubscribers) {
        return origRun.apply(this, arguments)
      }

      const ctx = {
        agent,
        input,
        options,
        agentName: agent?.name,
        model: agent?.model,
        workflowName: this.config?.workflowName,
        isTopLevelRun: false
      }

      return runCh.tracePromise(origRun, ctx, this, ...arguments)
    })
  }

  return exports
})

addHook({ name: '@openai/agents-core', file: 'dist/runner/toolExecution.js', versions: ['>=0.1.0'] }, exports => {
  // Wrap executeFunctionToolCalls to trace each tool invocation
  shimmer.wrap(exports, 'executeFunctionToolCalls', origFn => async function wrappedExecuteFunctionToolCalls (
    agent, toolRuns, runner, state, toolErrorFormatter
  ) {
    if (!toolCh.start.hasSubscribers) {
      return origFn.apply(this, arguments)
    }

    const ctx = {
      agent,
      toolRuns,
      agentName: agent?.name,
      toolNames: toolRuns?.map(tr => tr.tool?.name).filter(Boolean)
    }

    return toolCh.tracePromise(origFn, ctx, this, ...arguments)
  })

  // Wrap executeHandoffCalls to trace handoffs
  shimmer.wrap(exports, 'executeHandoffCalls', origFn => async function wrappedExecuteHandoffCalls (
    agent, originalInput, preStepItems, newStepItems, newResponse, runHandoffs, runner, runContext
  ) {
    if (!handoffCh.start.hasSubscribers) {
      return origFn.apply(this, arguments)
    }

    const firstHandoff = runHandoffs?.[0]
    const ctx = {
      agent,
      runHandoffs,
      agentName: agent?.name,
      toAgentName: firstHandoff?.handoff?.agentName,
      handoffToolName: firstHandoff?.toolCall?.name
    }

    return handoffCh.tracePromise(origFn, ctx, this, ...arguments)
  })

  return exports
})
