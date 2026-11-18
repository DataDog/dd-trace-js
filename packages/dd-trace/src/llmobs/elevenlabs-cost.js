'use strict'

const { channel } = require('dc-polyfill')
const log = require('../log')
const { buildConversationCostEvent } = require('./provider-cost')

const append = channel('llmobs:provider-cost:append')
const active = new WeakMap()
let count = 0
const BUDGET_MS = 30_000
const MAX_ACTIVE = 8
const MAX_ATTEMPTS = 5

/** @param {number} ms */
function delay (ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Use the application's client, but bound even a custom transport that ignores SDK timeouts.
 * @param {object} conversations
 * @param {string} id
 * @param {number} ms
 */
async function request (conversations, id, ms) {
  const controller = new AbortController()
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => conversations.get(id, undefined, {
        maxRetries: 0, timeoutInSeconds: ms / 1000, abortSignal: controller.signal,
      })),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('ElevenLabs billing timeout'))
        }, ms)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Start best-effort collection once per active client/conversation, without extending process lifetime.
 * Retain only the existing client and billing attribution, never a voice session or its audio.
 * @param {object} client
 * @param {string} id
 * @param {object} config
 * @param {object} routing
 * @param {() => boolean} enabled
 */
function collectConversationCost (client, id, config, routing, enabled) {
  const conversations = client?.conversationalAi?.conversations
  if (typeof conversations?.get !== 'function' || typeof id !== 'string' || !id || count >= MAX_ACTIVE) return
  let ids = active.get(client)
  if (ids?.has(id)) return
  if (!ids) {
    ids = new Set()
    active.set(client, ids)
  }
  ids.add(id)
  count++
  const options = {
    mlApp: config.llmobs.DD_LLMOBS_ML_APP || config.service || '',
    service: config.service,
    env: config.env,
    version: config.version,
  }
  const deadline = performance.now() + BUDGET_MS
  async function collect () {
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // Retries must be sequential to bound authenticated provider traffic.
        // eslint-disable-next-line no-await-in-loop
        await delay(Math.min(2 ** attempt * 1000, 12_000, Math.max(0, deadline - performance.now())))
        if (!enabled() || performance.now() >= deadline) return
        try {
          // eslint-disable-next-line no-await-in-loop
          const response = await request(conversations, id, Math.min(3000, deadline - performance.now()))
          if (!enabled()) return
          const event = buildConversationCostEvent(response, options)
          if (!event) continue
          if (event.session_id !== id) return
          const submission = { event, routing, submitted: false }
          append.publish(submission)
          const amounts = event.meta.metadata.provider_cost.amounts
          if (submission.submitted && ['total', 'llm', 'platform'].every(key => amounts[key] !== undefined)) return
        } catch (error) {
          const status = error?.statusCode ?? error?.status
          if (status >= 400 && status < 500 && status !== 429) return
        }
      }
      log.debug('ElevenLabs automatic billing collection exhausted its retry budget')
    } catch {
      log.debug('ElevenLabs automatic billing collection failed')
    } finally {
      ids.delete(id)
      count--
    }
  }
  void collect()
}

module.exports = { collectConversationCost }
