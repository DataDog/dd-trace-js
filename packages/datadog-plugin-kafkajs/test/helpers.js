'use strict'

// `admin.createTopics({ waitForLeaders: true })` can still throw
// UNKNOWN_TOPIC_OR_PARTITION (errorCode 3) while the broker propagates
// metadata internally — kafkajs's retryOnLeaderNotAvailable only covers
// LEADER_NOT_AVAILABLE (5). Single-broker dev Kafka makes the lag window
// very visible in CI. Drive create-and-verify until the topic is reachable
// from the client's broker pool.
//
// Two phases, because kafkajs 1.4.0 (unlike >=2.x) throws
// TOPIC_ALREADY_EXISTS rather than returning false, so we can only call
// createTopics safely once and have to retry the metadata fetch separately.
async function createAndAwaitTopics (admin, topicSpecs, { timeoutMs = 8000, pollIntervalMs = 100 } = {}) {
  const topicNames = topicSpecs.map(t => t.topic)
  const deadline = Date.now() + timeoutMs
  let lastError

  while (Date.now() < deadline) {
    try {
      await admin.createTopics({ waitForLeaders: true, topics: topicSpecs })
      lastError = undefined
      break
    } catch (e) {
      if (e.type === 'TOPIC_ALREADY_EXISTS' || /already exists/i.test(e.message ?? '')) {
        lastError = undefined
        break
      }
      lastError = e
      await sleep(pollIntervalMs)
    }
  }
  if (lastError) throw lastError

  while (Date.now() < deadline) {
    try {
      const { topics } = await admin.fetchTopicMetadata({ topics: topicNames })
      const allReady = topics.length === topicNames.length &&
        topics.every(t => t.partitions.length > 0 && t.partitions.every(p => p.leader >= 0))
      if (allReady) return
    } catch (e) {
      lastError = e
    }
    await sleep(pollIntervalMs)
  }

  throw lastError ?? new Error(`Topics never became ready: ${topicNames.join(', ')}`)
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { createAndAwaitTopics }
