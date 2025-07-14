import 'dd-trace/init.js'
import { Client } from '@elastic/elasticsearch'

const client = new Client({ node: 'http://127.0.0.1:9200' })

await client.ping()
