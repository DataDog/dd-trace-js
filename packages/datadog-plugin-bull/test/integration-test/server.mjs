import 'dd-trace/init.js'
import Queue from 'bull'

const queue = new Queue('esm-bull-queue', { redis: { host: '127.0.0.1', port: 6379 } })

queue.process(async () => 'done')

const job = await queue.add({ message: 'hello from esm' })
await job.finished()
await queue.close()
