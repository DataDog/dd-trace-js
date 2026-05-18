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
    } catch {
      // Topic creation is async; metadata/leader errors can be transient.
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }

  throw new Error(`Timeout: Topic "${topic}" metadata was not ready within ${timeoutMs}ms`)
}

module.exports = { waitForTopicReady }
