'use strict'

const { DsmPathwayCodec, getMessageSize } = require('../../datastreams')

/**
 * @typedef {import('../integration-pipeline').PipelineFrame} PipelineFrame
 */

/**
 * Describes where a library keeps the messages an operation sends or receives.
 *
 * Trace propagation and Data Streams Monitoring both need the same three answers: which messages
 * does this invocation handle, where does each one carry its Datadog fields, and how large is its
 * payload. Declaring that once lets the pipeline own the parts neither the library nor the
 * integration should decide: the Data Streams edge-tag format, the pathway encoding, the order of
 * injection against encoding, and the fact that both write the same carrier.
 *
 * `carrier` may return a live reference the pipeline mutates in place (a header map) or a detached
 * object the integration merges back in `commit` (a serialized envelope). Either way the carrier is
 * read or written exactly once per message.
 *
 * @typedef {object} MessagingDescriptor
 * @property {'in' | 'out'} direction Pathway direction. Outbound injects and encodes; inbound decodes.
 * @property {string} system Data Streams `type` tag, for example `bullmq`.
 * @property {(frame: PipelineFrame) => string} topic
 * @property {(frame: PipelineFrame) => unknown[] | undefined} messages
 * @property {(message: unknown, frame: PipelineFrame) => Record<string, unknown> | undefined} carrier
 * @property {(message: unknown, carrier: Record<string, unknown>, frame: PipelineFrame) => void} [commit]
 * @property {(message: unknown, frame: PipelineFrame) => unknown} [payload]
 */

/**
 * Size a message payload the way existing messaging plugins do, without paying for absent payloads.
 *
 * @param {unknown} payload
 * @returns {number}
 */
function sizeOf (payload) {
  return payload ? getMessageSize(payload) : 0
}

/**
 * Build the reusable messaging stage for one operation.
 *
 * @param {MessagingDescriptor} descriptor
 * @returns {import('../integration-pipeline').PipelineStage}
 */
function createMessagingStage (descriptor) {
  const { direction, system, topic, messages, carrier, commit, payload } = descriptor

  if (direction !== 'in' && direction !== 'out') {
    throw new TypeError('Messaging stage requires an "in" or "out" direction')
  }
  if (typeof system !== 'string' || system.length === 0) {
    throw new TypeError('Messaging stage requires a non-empty system')
  }
  if (typeof topic !== 'function') {
    throw new TypeError('Messaging stage requires a topic accessor')
  }
  if (typeof messages !== 'function') {
    throw new TypeError('Messaging stage requires a messages accessor')
  }
  if (typeof carrier !== 'function') {
    throw new TypeError('Messaging stage requires a carrier accessor')
  }
  if (commit !== undefined && typeof commit !== 'function') {
    throw new TypeError('Messaging stage requires a commit function when one is declared')
  }
  if (payload !== undefined && typeof payload !== 'function') {
    throw new TypeError('Messaging stage requires a payload accessor when one is declared')
  }

  const directionTag = `direction:${direction}`
  const systemTag = `type:${system}`

  /**
   * Inject correlation and encode the outgoing pathway into one shared carrier per message.
   *
   * @param {PipelineFrame} frame
   * @returns {void}
   */
  function startOutbound (frame) {
    const list = messages(frame)
    if (!list?.length) return

    const dsmEnabled = Boolean(frame.config.dsmEnabled)
    const edgeTags = dsmEnabled ? [directionTag, `topic:${topic(frame)}`, systemTag] : undefined

    for (const message of list) {
      if (message == null) continue

      const target = carrier(message, frame)
      if (target === undefined) {
        // Data Streams still owes a checkpoint even when the library gave us nowhere to write.
        if (dsmEnabled) frame.dataStreams.setCheckpoint(edgeTags, 0)
        continue
      }

      frame.correlation.inject('text_map', target)
      if (dsmEnabled) {
        const pathway = frame.dataStreams.setCheckpoint(edgeTags, payload ? sizeOf(payload(message, frame)) : 0)
        DsmPathwayCodec.encode(pathway, target)
      }
      commit?.(message, target, frame)
    }
  }

  /**
   * Decode each incoming pathway before recording its checkpoint.
   *
   * @param {PipelineFrame} frame
   * @returns {void}
   */
  function startInbound (frame) {
    if (!frame.config.dsmEnabled) return

    const list = messages(frame)
    if (!list?.length) return

    const edgeTags = [directionTag, `topic:${topic(frame)}`, systemTag]
    for (const message of list) {
      if (message == null) continue

      // Decode every message, including the ones carrying no context: that is what starts a new
      // pathway instead of extending the previous message's.
      frame.dataStreams.decode(carrier(message, frame))
      frame.dataStreams.setCheckpoint(edgeTags, payload ? sizeOf(payload(message, frame)) : 0)
    }
  }

  return {
    name: 'messaging',
    requires: ['tracing'],
    start: direction === 'out' ? startOutbound : startInbound,
  }
}

module.exports = { createMessagingStage }
