import 'dd-trace/init.js'
import graphql from 'graphql'
import * as pluginHelpers from './plugin-helpers.mjs'

const schema = new graphql.GraphQLSchema({
  query: new graphql.GraphQLObjectType({
    name: 'test',
    fields: {
      hello: {
        type: graphql.GraphQLString,
        resolve (obj, args) {
          return args.name
        }
      }
    }
  })
})

pluginHelpers.onMessage(async () => {
  const source = `query MyQuery { hello(name: "world") }`
  const variableValues = { who: 'world' }
  await graphql.graphql({ schema, source, variableValues })
})
