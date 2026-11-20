import 'dd-trace/init.js'
import { GraphQLSchema, GraphQLString, graphql, GraphQLObjectType } from 'graphql'

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'test',
    fields: {
      hello: {
        type: GraphQLString,
        resolve (obj, args) {
          return args.name
        },
      },
    },
  }),
})

await graphql({
  schema,
  source: 'query MyQuery { hello(name: "world") }',
  variableValues: { who: 'world' },
})
