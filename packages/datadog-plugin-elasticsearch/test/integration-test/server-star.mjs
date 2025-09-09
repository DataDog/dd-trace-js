import 'dd-trace/init.js'
import * as elastic from '@elastic/elasticsearch'

const client = new elastic.Client({ node: 'http://127.0.0.1:9200' })

await client.ping()
