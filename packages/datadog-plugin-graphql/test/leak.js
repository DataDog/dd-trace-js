'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('graphql')

const test = require('tape')
const graphql = require('../../../versions/graphql').get()
const profile = require('../../dd-trace/test/profile')

test('graphql plugin should not leak', t => {
  const schema = graphql.buildSchema(`
    type Query {
      hello: String
    }
  `)

  const source = '{ hello }'

  profile(t, operation, 2000)

  function operation (done) {
    graphql.graphql(schema, source).then(done)
  }
})
