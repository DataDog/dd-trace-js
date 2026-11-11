'use strict'

const { createHash } = require('node:crypto')

/** @typedef {import('../../../../index').llmobs.ConversationCostOptions} ConversationCostOptions */
/** @typedef {{mlApp: string, service?: string, env?: string, version?: string}} BuildContext */
/** @typedef {ConversationCostOptions & BuildContext} BuildOptions */

/**
 * @param {unknown} object
 * @param {string} snake
 * @param {string} camel
 */
function field (object, snake, camel) {
  if (!object || typeof object !== 'object') return
  const record = /** @type {Record<string, unknown>} */ (object)
  return Object.hasOwn(record, snake) ? record[snake] : record[camel]
}

/** @param {unknown} amount */
function validAmount (amount) {
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount * 1e9 < 2 ** 63
}

/**
 * @param {string} mlApp
 * @param {string} conversationId
 */
function conversationOwner (mlApp, conversationId) {
  const parts = ['llmobs.provider_cost.v1', mlApp, 'elevenlabs', conversationId, 'conversation']
  let encoded = ''
  for (const part of parts) encoded += `${Buffer.byteLength(part)}:${part}`
  const digest = createHash('sha256').update(encoded).digest()
  const id = digest.readBigUInt64BE(16)
  return { trace_id: digest.subarray(0, 16).toString('hex'), span_id: (id || 1n).toString() }
}

/**
 * Normalize an application-supplied completion response without provider requests.
 * @param {object} conversation
 * @param {BuildOptions} options
 */
function buildConversationCostEvent (conversation, options) {
  const { provider = 'elevenlabs', source = 'conversation_details', totalCost, mlApp } = options
  if (provider !== 'elevenlabs' || !['conversation_details', 'post_call_transcription'].includes(source) ||
      typeof mlApp !== 'string' || !mlApp) return
  const conversationId = field(conversation, 'conversation_id', 'conversationId')
  const status = field(conversation, 'status', 'status')
  if (typeof conversationId !== 'string' || !conversationId || Buffer.byteLength(conversationId) > 256 ||
      !['done', 'failed'].includes(/** @type {string} */ (status))) return
  const metadata = field(conversation, 'metadata', 'metadata')
  const start = field(metadata, 'start_time_unix_secs', 'startTimeUnixSecs')
  const duration = field(metadata, 'call_duration_secs', 'callDurationSecs')
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start <= 0 || start * 1e9 >= 2 ** 64 ||
      typeof duration !== 'number' || !Number.isSafeInteger(duration) ||
      duration < 0 || duration * 1e9 >= 2 ** 64) return
  const charging = field(metadata, 'charging', 'charging')
  /** @type {Record<string, number>} */
  const amounts = {}
  let reported = false
  /** @type {Record<string, {kind: string, field: string}>} */
  const provenance = {}
  for (const [name, amount, path] of [
    ['total', field(metadata, 'cost_fiat', 'costFiat'), 'metadata.cost_fiat'],
    ['llm', field(charging, 'llm_price', 'llmPrice'), 'metadata.charging.llm_price'],
    ['platform', field(charging, 'platform_price', 'platformPrice'), 'metadata.charging.platform_price'],
  ]) {
    if (amount == null) continue
    if (!validAmount(amount)) return
    reported = true
    amounts[/** @type {string} */ (name)] = /** @type {number} */ (amount)
    provenance[/** @type {string} */ (name)] = { kind: source, field: /** @type {string} */ (path) }
  }
  if ((!reported && totalCost == null) || (totalCost != null && !validAmount(totalCost))) return
  const owner = conversationOwner(mlApp, conversationId)
  const tags = [`ml_app:${mlApp}`, 'language:javascript', 'integration:elevenlabs', 'source:integration']
  for (const name of ['service', 'env', 'version']) {
    const value = options[name]
    if (value != null) tags.push(`${name}:${value}`)
  }
  return {
    ...owner,
    parent_id: 'undefined',
    name: 'elevenlabs conversation billing',
    session_id: conversationId,
    start_ns: start * 1e9,
    duration: Math.max(1, duration * 1e9),
    status: 'ok',
    tags,
    metrics: totalCost == null ? {} : { total_cost: totalCost },
    meta: {
      span: { kind: 'workflow' },
      metadata: {
        ttfa_eligible: false,
        provider_cost: {
          version: 1,
          provider: 'elevenlabs',
          currency: 'USD',
          scope: 'conversation',
          status,
          conversation_id: conversationId,
          owner,
          amounts,
          provenance,
        },
      },
    },
    _dd: {},
  }
}

module.exports = { buildConversationCostEvent }
