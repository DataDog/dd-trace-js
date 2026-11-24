import tracer from 'dd-trace'

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

tracer.init({ plugins: false })
tracer.use('graphql', { enabled: process.env.OUTCOME !== 'disabled', source: true })

const require = createRequire(import.meta.url)
const graphql = process.env.LOAD_MODE === 'require' ? require('graphql') : await import('graphql')
assert.equal(graphql.version, process.env.GRAPHQL_VERSION)

await tracer.trace('test.graphql', async () => {
  const schema = graphql.buildSchema('type Query { hello(name: String): String }')
  const document = graphql.parse('query Hello { greeting: hello(name: "world") }')
  assert.deepEqual(graphql.validate(schema, document), [])

  const result = await graphql.execute({
    schema,
    document,
    rootValue: {
      hello: process.env.OUTCOME === 'error' ? async () => { throw new Error('resolver failed') } : ({ name }) => name,
    },
  })

  if (process.env.OUTCOME === 'error') {
    assert.equal(result.errors[0].message, 'resolver failed')
    assert.equal(result.data.greeting, null)
  } else {
    assert.equal(result.data.greeting, 'world')
    assert.equal(result.errors, undefined)
  }
})
