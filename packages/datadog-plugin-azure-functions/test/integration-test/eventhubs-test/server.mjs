import 'dd-trace/init.js'
import { app } from '@azure/functions'
import {
  EventHubProducerClient,
  EventHubBufferedProducerClient,
} from '@azure/event-hubs'

const eventData = [
  { body: 'Hello Event Hub 1' },
  { body: 'Hello Event Hub 2' },
]

const amqpMessages = [
  {
    body: 'Hello from an amqp message',
    annotations: {
      'x-opt-custom-annotation-key': 'custom-value',
      'x-opt-partition-key': 'myPartitionKey',
    },
    applicationProperties: {
      'custom-property-key': 'custom-property-value',
    },
  },
  {
    body: 'Hello from an amqp message 2 ',
    annotations: {
      'x-opt-custom-annotation-key': 'custom-value-2',
      'x-opt-partition-key': 'myPartitionKey-2',
    },
    applicationProperties: {
      'custom-property-key2': 'custom-property-value2',
    },
  },
]

app.http('eh1-eventdata', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubProducerClient(process.env.MyEventHub, 'eh1')
    await client.sendBatch(eventData)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh1-amqpmessages', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubProducerClient(process.env.MyEventHub, 'eh1')
    await client.sendBatch(amqpMessages)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh1-batch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubProducerClient(process.env.MyEventHub, 'eh1')
    const batch = await client.createBatch()
    eventData.forEach((item) => {
      batch.tryAdd(item)
    })
    await client.sendBatch(batch)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh2-eventdata', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubProducerClient(process.env.MyEventHub, 'eh2')
    await client.sendBatch(eventData)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh2-amqpmessages', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubProducerClient(process.env.MyEventHub, 'eh2')
    await client.sendBatch(amqpMessages)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh2-batch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubProducerClient(process.env.MyEventHub, 'eh2')
    const batch = await client.createBatch()
    eventData.forEach(item => batch.tryAdd(item))
    await client.sendBatch(batch)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh1-enqueueEvent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubBufferedProducerClient(process.env.MyEventHub, 'eh1')
    await client.enqueueEvent({ body: 'Single enqueue event for eh1' })
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh1-enqueueEvents', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubBufferedProducerClient(process.env.MyEventHub, 'eh1')
    await client.enqueueEvents(eventData)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh1-enqueueAmqp', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubBufferedProducerClient(process.env.MyEventHub, 'eh1')
    await client.enqueueEvents(amqpMessages)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh2-enqueueEvent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubBufferedProducerClient(process.env.MyEventHub, 'eh2')
    await client.enqueueEvent({ body: 'Single enqueue event for eh2' })
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh2-enqueueEvents', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubBufferedProducerClient(process.env.MyEventHub, 'eh2')
    await client.enqueueEvents(eventData)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.http('eh2-enqueueAmqp', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const client = new EventHubBufferedProducerClient(process.env.MyEventHub, 'eh2')
    await client.enqueueEvents(amqpMessages)
    await client.close()
    return {
      status: 200,
    }
  },
})

app.eventHub('eventHubTest1', {
  connection: 'MyEventHub',
  eventHubName: 'eh1',
  cardinality: 'one',
  handler: async (events, context) => {
    return {
      status: 200,
    }
  },
})

app.eventHub('eventHubTest2', {
  connection: 'MyEventHub',
  eventHubName: 'eh2',
  cardinality: 'many',
  handler: async (events, context) => {
    return {
      status: 200,
    }
  },
})
