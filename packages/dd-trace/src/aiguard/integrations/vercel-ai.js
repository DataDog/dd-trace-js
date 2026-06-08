'use strict'

const { channel } = require('dc-polyfill')

const { buildOutputMessages, convertVercelPromptToMessages } = require('../messages/vercel-ai')
const { SOURCE_AUTO } = require('../tags')
const { pushEvaluation } = require('./evaluate')

const doGenerateBeforeChannel = channel('dd-trace:vercel-ai:doGenerate:before')
const doGenerateAfterChannel = channel('dd-trace:vercel-ai:doGenerate:after')
const doStreamBeforeChannel = channel('dd-trace:vercel-ai:doStream:before')
const doStreamAfterChannel = channel('dd-trace:vercel-ai:doStream:after')

/**
 * Subscribes AI Guard to Vercel AI lifecycle channels.
 *
 * @param {object} aiguard
 * @param {boolean} block
 * @returns {() => void}
 */
function enable (aiguard, block) {
  const opts = { block, source: SOURCE_AUTO, integration: 'ai' }

  function onBefore (ctx) {
    pushEvaluation(ctx, aiguard, convertVercelPromptToMessages(ctx.prompt), opts)
  }

  function onGenerateAfter (ctx) {
    const inputMessages = convertVercelPromptToMessages(ctx.prompt)
    if (!inputMessages.length || !ctx.result?.content?.length) return

    pushEvaluation(ctx, aiguard, buildOutputMessages(inputMessages, ctx.result.content), opts)
  }

  function onStreamAfter (ctx) {
    const inputMessages = convertVercelPromptToMessages(ctx.prompt)
    if (!inputMessages.length || !ctx.chunks?.length) return

    pushEvaluation(ctx, aiguard, buildOutputMessages(inputMessages, getStreamContent(ctx.chunks)), opts)
  }

  doGenerateBeforeChannel.subscribe(onBefore)
  doGenerateAfterChannel.subscribe(onGenerateAfter)
  doStreamBeforeChannel.subscribe(onBefore)
  doStreamAfterChannel.subscribe(onStreamAfter)

  return function disable () {
    doGenerateBeforeChannel.unsubscribe(onBefore)
    doGenerateAfterChannel.unsubscribe(onGenerateAfter)
    doStreamBeforeChannel.unsubscribe(onBefore)
    doStreamAfterChannel.unsubscribe(onStreamAfter)
  }
}

/**
 * Converts Vercel stream chunks into the content shape used by doGenerate results.
 *
 * @param {Array<object>} chunks
 * @returns {Array<object>}
 */
function getStreamContent (chunks) {
  const toolCalls = []
  const textParts = []

  for (const chunk of chunks) {
    if (chunk?.type === 'text-delta') {
      textParts.push(chunk.textDelta)
    } else if (chunk?.type === 'tool-call') {
      toolCalls.push(chunk)
    }
  }

  if (toolCalls.length) return toolCalls
  const text = textParts.join('')
  return text ? [{ type: 'text', text }] : []
}

module.exports = { enable }
