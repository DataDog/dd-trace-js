import 'dd-trace/init.js'
import { PubSub } from '@google-cloud/pubsub'
import id from './id.js'

const pubsub = new PubSub({ projectId: `test-project-${id()}` })
const [topic] = await pubsub.createTopic(`test-topic-${id()}`)
const [subscription] = await topic.createSubscription('foo')

await topic.publishMessage({ data: Buffer.from('Test message!') })
await subscription.close()
await pubsub.close()