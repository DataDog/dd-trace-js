'use strict'

require('../../..')
  .init({ plugins: false, sampleRate: 0 })
  .use('graphql')

const test = require('tape')
const graphql = require('graphql')
const profile = require('../../profile')

test('graphql plugin should not leak', t => {
  const schema = graphql.buildSchema(`
    type Query {
      hello: String
    }
  `)

  const source = `{ hello }`

  profile(t, operation)

  function operation (done) {
    graphql.graphql(schema, source).then(done)
  }
})
