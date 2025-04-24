import 'dd-trace/init.js'
import Valkey from 'iovalkey'

const client = new Valkey({ connectionName: 'test' })
await client.get('foo')
client.quit()
