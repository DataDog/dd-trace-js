import 'dd-trace/init.js'
import { app } from '@azure/functions'
import { ServiceBusClient } from '@azure/service-bus'

// ServiceBus
const sbClient = new ServiceBusClient(process.env.MyServiceBus)
const sender1 = sbClient.createSender('queue.1')
const sender2 = sbClient.createSender('queue.2')
const sender3 = sbClient.createSender('topic.1')
const sender4 = sbClient.createSender('topic.2')

const message = { body: 'Hello Datadog!' }

const messages = [
  { body: 'Hello Datadog!' },
  { body: 'Hello Azure!' }
]

const amqpMessage = {
  body: 'Hello from an amqp message',
  annotations: {
    'x-opt-custom-annotation-key': 'custom-value', // Custom annotation
    'x-opt-partition-key': 'myPartitionKey' // Example of a common annotation
  },
}

const amqpMessages = [
  {
    body: 'Hello from an amqp message',
    annotations: {
      'x-opt-custom-annotation-key': 'custom-value', // Custom annotation
      'x-opt-partition-key': 'myPartitionKey' // Example of a common annotation
    },
  },
  {
    body: 'Hello from an amqp message 2 ',
    annotations: {
      'x-opt-custom-annotation-key': 'custom-value-2', // Custom annotation
      'x-opt-partition-key': 'myPartitionKey-2' // Example of a common annotation
    }
  }
]

app.http('send-message-1', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender1.sendMessages(message)
    return {
      status: 200,
      body: 'Sent single message'
    }
  }
})

app.http('send-messages-1', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender1.sendMessages(messages)
    return {
      status: 200,
      body: 'Sent message batch'
    }
  }
})

app.http('send-amqp-message-1', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender1.sendMessages(amqpMessage)
    return {
      status: 200,
      body: 'Sent single AMQP message'
    }
  }
})

app.http('send-amqp-messages-1', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender1.sendMessages(amqpMessages)
    return {
      status: 200,
      body: 'Sent AMQP message batch'
    }
  }
})

app.http('send-message-batch-1', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const batch = await sender1.createMessageBatch()
    for (const msg of messages) {
      batch.tryAddMessage(msg)
    }
    await sender1.sendMessages(batch)
    return {
      status: 200,
      body: 'Sent message batch using createMessageBatch'
    }
  }
})

app.http('send-message-2', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender2.sendMessages(message)
    return {
      status: 200,
      body: 'Sent single message'
    }
  }
})

app.http('send-messages-2', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender2.sendMessages(messages)
    return {
      status: 200,
      body: 'Sent message batch'
    }
  }
})

app.http('send-amqp-message-2', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender2.sendMessages(amqpMessage)
    return {
      status: 200,
      body: 'Sent single AMQP message'
    }
  }
})

app.http('send-amqp-messages-2', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender2.sendMessages(amqpMessages)
    return {
      status: 200,
      body: 'Sent AMQP message batch'
    }
  }
})

app.http('send-message-batch-2', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const batch = await sender2.createMessageBatch()
    for (const msg of messages) {
      batch.tryAddMessage(msg)
    }
    await sender2.sendMessages(batch)
    return {
      status: 200,
      body: 'Sent message batch using createMessageBatch'
    }
  }
})

app.http('servicebus-test3', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender3.sendMessages(messages)
    return {
      status: 200,
    }
  }
})

app.http('servicebus-test4', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await sender4.sendMessages(messages)
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

app.serviceBusQueue('queueTest2', {
  connection: 'MyServiceBus',
  queueName: 'queue.2',
  authLevel: 'anonymous',
  cardinality: 'many',
  handler: async (message, context) => {
    return {
      status: 200,
    }
  }
})

app.serviceBusTopic('topicTest', {
  connection: 'MyServiceBus',
  topicName: 'topic.1',
  subscriptionName: 'subscription.1',
  handler: async (message, context) => {
    return {
      status: 200,
    }
  }
})

app.serviceBusTopic('topicTest2', {
  connection: 'MyServiceBus',
  topicName: 'topic.2',
  subscriptionName: 'subscription.2',
  cardinality: 'many',
  handler: async (message, context) => {
    return {
      status: 200,
    }
  }
})
