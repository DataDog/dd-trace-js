'use strict'

const RetryOperation = require('../operation')
process.env.PUBSUB_EMULATOR_HOST = 'localhost:8081'
const { PubSub } = require('../../../../../versions/@google-cloud/pubsub').get()

function waitForGpubsub () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('googgle-cloud-pubsub')
    operation.attempt(currentAttempt => {
      const ps = new PubSub({ projectId: 'setupProjectId' })

      ps.createTopic('setup-topic-test-' + Math.random(), (err, topic) => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        topic.delete((err) => {
          if (operation.retry(err)) return
          if (err) return reject(err)

          resolve()
        })
      })
    })
  })
}

module.exports = waitForGpubsub
