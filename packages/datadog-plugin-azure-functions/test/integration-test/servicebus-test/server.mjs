import 'dd-trace/init.js'
import { app } from '@azure/functions'
import { ServiceBusClient } from '@azure/service-bus'

// ServiceBus
const sbClient = new ServiceBusClient(process.env.MyServiceBus)
const sender1 = sbClient.createSender('queue.1')
const sender2 = sbClient.createSender('topic.1')

app.http('servicebus-test1', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const message = { body: 'Hello World 1' }
    await sender1.sendMessages(message)
    return {
      status: 200,
    }
  }
})

app.http('servicebus-test2', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const message = { body: 'Hello World 2' }
    await sender2.sendMessages(message)
    return {
      status: 200,
    }
  }
})

app.serviceBusQueue('queueTest', {
  connection: 'MyServiceBus',
  queueName: 'queue.1',
  authLevel: 'anonymous',
  handler: async (message, context) => {
    return {
      status: 200,
    }
  }
})

app.serviceBusTopic('topicTest', {
  connection: 'MyServiceBus',
  topicName: 'topic.1',
  subscriptionName: 'subscription.3',
  handler: async (message, context) => {
    return {
      status: 200,
    }
  }
})
