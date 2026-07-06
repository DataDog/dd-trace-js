'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  LLMObsExportMode,
  getLLMObsExportMode,
} = require('../../src/llmobs/export-mode')

describe('LLMObs export mode', () => {
  it('uses APM agent mode when APM tracing uses the agent exporter', () => {
    assert.strictEqual(getLLMObsExportMode({
      DD_TRACE_ENABLED: true,
      apmTracingEnabled: true,
      llmobs: { DD_LLMOBS_ENABLED: true },
    }), LLMObsExportMode.APM_AGENT)
  })

  it('uses APM agentless mode when APM tracing uses the agentless exporter', () => {
    assert.strictEqual(getLLMObsExportMode({
      DD_TRACE_ENABLED: true,
      apmTracingEnabled: true,
      experimental: { exporter: 'agentless' },
      llmobs: { DD_LLMOBS_ENABLED: true },
    }), LLMObsExportMode.APM_AGENTLESS)
  })

  it('uses APM agentless mode when LLMObs explicitly uses agentless submission', () => {
    assert.strictEqual(getLLMObsExportMode({
      DD_TRACE_ENABLED: true,
      apmTracingEnabled: true,
      llmobs: {
        DD_LLMOBS_ENABLED: true,
        agentlessEnabled: true,
      },
    }), LLMObsExportMode.APM_AGENTLESS)
  })

  it('uses APM agentless mode when LLMObs auto-detects agentless submission', () => {
    assert.strictEqual(getLLMObsExportMode({
      DD_TRACE_ENABLED: true,
      apmTracingEnabled: true,
      llmobs: {
        DD_LLMOBS_ENABLED: true,
      },
    }, {
      _agentless: true,
    }), LLMObsExportMode.APM_AGENTLESS)
  })

  it('uses LLMObs Agent proxy mode when APM tracing is unavailable and the writer uses the Agent', () => {
    assert.strictEqual(getLLMObsExportMode({
      DD_TRACE_ENABLED: true,
      apmTracingEnabled: false,
      llmobs: { DD_LLMOBS_ENABLED: true },
    }, {
      _agentless: false,
    }), LLMObsExportMode.LLMOBS_AGENT_PROXY)
  })

  it('uses LLMObs agentless mode when APM tracing is unavailable and the writer is agentless', () => {
    assert.strictEqual(getLLMObsExportMode({
      DD_TRACE_ENABLED: true,
      apmTracingEnabled: false,
      llmobs: { DD_LLMOBS_ENABLED: true },
    }, {
      _agentless: true,
    }), LLMObsExportMode.LLMOBS_AGENTLESS)
  })
})
