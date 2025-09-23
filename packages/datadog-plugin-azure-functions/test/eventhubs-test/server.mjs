import 'dd-trace/init.js'
import { app } from '@azure/functions'
import { EventHubProducerClient, EventHubBufferedProducerClient } from '@azure/event-hubs';

const ehClient1 = new EventHubProducerClient(process.env.MyEventHub, 'eh1')
const ehClient2 = new EventHubProducerClient(process.env.MyEventHub, 'eh2')

// const bufferedClient = new EventHubBufferedProducerClient(process.env.MyEventHub, 'eh1')

const eventData = [
  { body: "Hello Event Hub 1" },
  { body: "Hello Event Hub 2" }
]

const amqpMessages = [
  {
    body: "Hello from an amqp message",
    annotations: {
      "x-opt-custom-annotation-key": "custom-value", // Custom annotation
      "x-opt-partition-key": "myPartitionKey" // Example of a common annotation
    },
    applicationProperties: {
      "custom-property-key": "custom-property-value" // Custom property
    }
  },
  {
    body: "Hello from an amqp message 2 ",
    annotations: {
      "x-opt-custom-annotation-key": "custom-value-2", // Custom annotation
      "x-opt-partition-key": "myPartitionKey-2" // Example of a common annotation
    },
    applicationProperties: {
      "custom-property-key2": "custom-property-value2" // Custom property
    }
  }
];

app.http('eh1-eventdata', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await ehClient1.sendBatch(eventData);
    await ehClient1.close();
    return {
      status: 200,
    }
  }
})

app.http('eh1-amqpmessages', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await ehClient1.sendBatch(amqpMessages);
    await ehClient1.close();
    return {
      status: 200,
    }
  }
})

app.http('eh1-batch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const batch = await ehClient1.createBatch();
    batch.tryAdd({ body: "Hello Event Hub 1" });
    batch.tryAdd({ body: "Hello Event Hub 2" });
    //
    // eventData.forEach((item) => {
    //   batch.tryAdd(item)
    // });
    await ehClient1.sendBatch(batch);
    await ehClient1.close();
    return {
      status: 200,
    }
  }
})

app.http('eh2-eventdata', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await ehClient2.sendBatch(eventData);
    await ehClient2.close();
    return {
      status: 200,
    }
  }
})

app.http('eh2-amqpmessages', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await ehClient2.sendBatch(amqpMessages);
    await ehClient2.close();
    return {
      status: 200,
    }
  }
})

app.http('eh2-batch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const batch = await ehClient2.createBatch();
    eventData.forEach(item => batch.tryAdd(item));
    await ehClient2.sendBatch(batch);
    await ehClient2.close();
    return {
      status: 200,
    }
  }
})

app.eventHub('eventHubTest1', {
  connection: 'MyEventHub',
  eventHubName: 'eh1',
  cardinality: 'one',
  handler: async (events, context) => {
    return {
      status: 200,
    }
  }
})

app.eventHub('eventHubTest2', {
  connection: 'MyEventHub',
  eventHubName: 'eh2',
  cardinality: 'many',
  handler: async (events, context) => {
    return {
      status: 200,
    }
  }
})

