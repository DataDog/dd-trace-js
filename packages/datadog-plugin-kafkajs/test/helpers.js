'use strict'

// KafkaJS's retryOnLeaderNotAvailable only retries on LEADER_NOT_AVAILABLE. Right after
// topic creation, Kafka can transiently return UNKNOWN_TOPIC_OR_PARTITION in the metadata
// response before the new topic has fully propagated, which KafkaJS re-throws immediately.
async function createTopicWithRetry (admin, topicConfig, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await admin.createTopics(topicConfig)
      return
    } catch (err) {
      if (err.type === 'TOPIC_ALREADY_EXISTS') return
      if (attempt < maxRetries && err.type === 'UNKNOWN_TOPIC_OR_PARTITION') {
        await new Promise(resolve => setTimeout(resolve, 1000))
        continue
      }
      throw err
    }
  }
}

module.exports = { createTopicWithRetry }
