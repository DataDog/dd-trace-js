import 'dd-trace/init.js'
import opensearch from '@opensearch-project/opensearch'

const client = new opensearch.Client({ node: `http://localhost:9201` })
await client.ping()
