'use strict'

async function waitForTopicReady (admin, topic, timeoutMs = 20000) {
  if (typeof admin?.fetchTopicMetadata !== 'function') return

  const start = Date.now()
  while ((Date.now() - start) < timeoutMs) {
    try {
      const meta = await admin.fetchTopicMetadata({ topics: [topic], timeout: 1000 })
      const topicMeta = Array.isArray(meta) ? meta[0] : meta?.topics?.[0]

      const partitions = topicMeta?.partitions
      if (Array.isArray(partitions) &&
          partitions.length > 0 &&
          partitions.every(p => typeof p.leader === 'number' && p.leader >= 0)) {
        return
      }
    } catch (err) {
      // Rethrow unexpected errors immediately so they surface rather than masking as a timeout.
      const transient = new Set([
        'ERR_UNKNOWN_TOPIC_OR_PART',
        'ERR_LEADER_NOT_AVAILABLE',
        'ERR__TIMED_OUT',
        'ERR__TIMED_OUT_QUEUE',
        'ERR__TRANSPORT',
        'ERR__ALL_BROKERS_DOWN',
      ])
      if (!transient.has(err?.type)) throw err
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }

  throw new Error(`Timeout: Topic "${topic}" metadata was not ready within ${timeoutMs}ms`)
}

module.exports = { waitForTopicReady }
