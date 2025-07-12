import 'dd-trace/init.js'
import opensearch from '@opensearch-project/opensearch'

const client = new opensearch.Client({ node: 'http://127.0.0.1:9201' })
await client.ping()
