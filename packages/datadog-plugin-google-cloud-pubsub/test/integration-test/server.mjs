import 'dd-trace/init.js'
import { PubSub } from '@google-cloud/pubsub'
import id from './id.js'

function getProjectId () {
  return `test-project-${id()}`
}

function getTopic () {
  return `test-topic-${id()}`
}

const pubsub = new PubSub({ projectId: getProjectId() })

const [topic] = await pubsub.createTopic(getTopic())

const [subscription] = await topic.createSubscription('foo')

await topic.publishMessage({ data: Buffer.from('Test message!') })

await subscription.close()

await pubsub.close()