'use strict'

const graphql = require('../../../versions/graphql-jit').get('graphql')

const items = new Array(20)
for (let i = 0; i < items.length; i++) {
  items[i] = { left: 'left', right: 'right' }
}

const Item = new graphql.GraphQLObjectType({
  name: 'JitBenchmarkItem',
  fields: {
    left: {
      type: graphql.GraphQLString,
    },
    right: {
      type: graphql.GraphQLString,
    },
  },
})

const schema = new graphql.GraphQLSchema({
  query: new graphql.GraphQLObjectType({
    name: 'JitBenchmarkQuery',
    fields: {
      asyncValue: {
        type: graphql.GraphQLString,
        resolve: () => Promise.resolve('async'),
      },
      items: {
        type: new graphql.GraphQLList(Item),
        resolve: () => items,
      },
    },
  }),
})

const sources = {
  async: 'query AsyncJitBenchmark { asyncValue }',
  compile: 'query CompileJitBenchmark { items { left right } }',
  fanout: 'query FanoutJitBenchmark { items { left right } }',
}

module.exports = { schema, sources }
