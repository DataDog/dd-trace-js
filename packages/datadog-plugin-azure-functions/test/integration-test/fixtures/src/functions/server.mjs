import 'dd-trace/init.js'
import { app } from '@azure/functions'
import { ServiceBusClient } from '@azure/service-bus'

const client = new ServiceBusClient(process.env['MyServiceBus'])
const sender1 = client.createSender('queue.1')
const sender2 = client.createSender('topic.1')

async function handlerFunction (request, context) {
  return {
    status: 200,
    body: 'Hello Datadog!'
  }
}

app.http('httptest', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handlerFunction
})

app.http('httptest2', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await fetch('http://127.0.0.1:7071/api/httptest')
    return {
      status: 200,
      body: 'Hello Datadog 2!'
    }
  }
})

app.http('httptest3', {
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

app.http('httptest4', {
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
