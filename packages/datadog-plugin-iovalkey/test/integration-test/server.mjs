import 'dd-trace/init.js'
import Redis from 'iovalkey'

const client = new Redis({ connectionName: 'test' })
await client.get('foo')
client.quit()
