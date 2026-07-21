'use strict'

/**
 * @typedef {{
 *   specificationVersion: 'v1' | 'v2' | 'v3',
 *   provider: string,
 *   modelId: string,
 *   defaultObjectGenerationMode: undefined,
 *   supportedUrls: Record<string, RegExp[]>,
 *   doGenerate: () => Promise<Record<string, unknown>>
 * }} ToolResultModel
 */

/**
 * @param {'v1' | 'v2' | 'v3'} specificationVersion
 * @param {Array<Record<string, unknown>>} responses
 * @returns {ToolResultModel}
 */
function createModel (specificationVersion, responses) {
  let responseIndex = 0

  return {
    specificationVersion,
    provider: 'test',
    modelId: 'test',
    defaultObjectGenerationMode: undefined,
    supportedUrls: {},
    async doGenerate () {
      return responses[responseIndex++]
    },
  }
}

function createToolResultModelV1 () {
  const usage = {
    promptTokens: 1,
    completionTokens: 1,
  }
  const rawCall = {
    rawPrompt: undefined,
    rawSettings: {},
  }

  return createModel('v1', [
    {
      toolCalls: [{
        toolCallType: 'function',
        toolCallId: 'call-1',
        toolName: '0',
        args: '{}',
      }],
      finishReason: 'tool-calls',
      usage,
      rawCall,
      warnings: [],
    },
    {
      text: 'done',
      finishReason: 'stop',
      usage,
      rawCall,
      warnings: [],
    },
  ])
}

function createToolResultModelV2 () {
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  }

  return createModel('v2', [
    {
      content: [{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{}',
      }],
      finishReason: 'tool-calls',
      usage,
      warnings: [],
    },
    {
      content: [{ type: 'text', text: 'done' }],
      finishReason: 'stop',
      usage,
      warnings: [],
    },
  ])
}

function createToolResultModelV3 () {
  const usage = {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: 1,
      text: 1,
      reasoning: 0,
    },
  }

  return createModel('v3', [
    {
      content: [{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'testTool',
        input: '{}',
      }],
      finishReason: {
        unified: 'tool-calls',
        raw: 'tool_calls',
      },
      usage,
      warnings: [],
    },
    {
      content: [{ type: 'text', text: 'done' }],
      finishReason: {
        unified: 'stop',
        raw: 'stop',
      },
      usage,
      warnings: [],
    },
  ])
}

module.exports = {
  createToolResultModelV1,
  createToolResultModelV2,
  createToolResultModelV3,
}
