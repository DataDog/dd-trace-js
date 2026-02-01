import 'dd-trace/init.js'
import graphqlLib from 'graphql'

const schema = new graphqlLib.GraphQLSchema({
  query: new graphqlLib.GraphQLObjectType({
    name: 'test',
    fields: {
      hello: {
        type: graphqlLib.GraphQLString,
        resolve (obj, args) {
          return args.name
        },
      },
    },
  }),
})

await graphqlLib.graphql({
  schema,
  source: 'query MyQuery { hello(name: "world") }',
  variableValues: { who: 'world' },
})
