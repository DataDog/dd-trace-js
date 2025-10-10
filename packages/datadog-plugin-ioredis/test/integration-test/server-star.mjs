import 'dd-trace/init.js'
import * as modioredis from 'ioredis'
const Redis = modioredis.default

const client = new Redis({ connectionName: 'test' })
await client.get('foo')
client.quit()

