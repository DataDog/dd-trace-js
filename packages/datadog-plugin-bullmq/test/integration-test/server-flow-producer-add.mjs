import 'dd-trace/init.js'
import bullmq from 'bullmq'

const connection = {
  host: '127.0.0.1',
  port: 6379,
}

const queueName = 'esm-test-flow-producer'

const flowProducer = new bullmq.FlowProducer({ connection })

// Test FlowProducer.add() - tests FlowProducer_add channel
await flowProducer.add({
  name: 'parent-flow-job',
  queueName,
  data: { type: 'parent', message: 'Parent job' },
  children: [
    {
      name: 'child-job-1',
      queueName,
      data: { type: 'child', message: 'Child job' },
    },
  ],
})

await flowProducer.close()
