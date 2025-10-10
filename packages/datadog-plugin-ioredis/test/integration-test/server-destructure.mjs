import 'dd-trace/init.js'
import { default as Redis } from 'ioredis'

const client = new Redis({ connectionName: 'test' })
await client.get('foo')
client.quit()

