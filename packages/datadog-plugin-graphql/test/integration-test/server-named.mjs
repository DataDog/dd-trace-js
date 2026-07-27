import 'dd-trace/init.js'
// eslint-disable-next-line @stylistic/max-len -- must match createImportVariants' generated "named" base text verbatim
import { GraphQLSchema, GraphQLString, graphql, GraphQLObjectType } from 'graphql'; const graphqlLib = { GraphQLSchema, GraphQLString, graphql, GraphQLObjectType }

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
