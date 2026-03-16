'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const AIGuard = require('./sdk')
const { convertVercelPromptToMessages, buildOutputMessages } = require('./messages')

const aiguardChannel = channel('dd-trace:ai:aiguard')

let isEnabled = false
let aiguard
let block

function enable (tracer, config) {
  if (isEnabled) return

  try {
    aiguard = new AIGuard(tracer, config)
    block = config.experimental?.aiguard?.block !== false

    aiguardChannel.subscribe(onEvaluate)

    isEnabled = true
  } catch (err) {
    log.error('AIGuard: unexpected error during initialization: %s', err.message)
    disable()
  }
}

function disable () {
  if (!isEnabled) return

  aiguardChannel.unsubscribe(onEvaluate)

  aiguard = undefined
  isEnabled = false
  block = false
}

/**
 * Handles channel messages with the contract: { phase, prompt, content?, resolve, reject }
 *
 * @param {{phase: 'input'|'output', prompt: Array, content?: Array, resolve: Function, reject: Function}} ctx
 */
function onEvaluate (ctx) {
  const inputMessages = convertVercelPromptToMessages(ctx.prompt)
  if (inputMessages.length === 0) {
    ctx.resolve()
    return
  }

  let messagesToEvaluate = inputMessages
  if (ctx.phase === 'output' && ctx.content) {
    messagesToEvaluate = buildOutputMessages(inputMessages, ctx.content)
  }

  aiguard.evaluate(messagesToEvaluate, { block })
    .then(() => {
      ctx.resolve()
    })
    .catch(err => {
      if (err.name === 'AIGuardAbortError') {
        ctx.reject(err)
      } else {
        log.error('AIGuard: unexpected error during evaluation: %s', err.message)
        ctx.resolve()
      }
    })
}

module.exports = { enable, disable }
