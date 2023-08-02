import 'dd-trace/init.js'
import graphql from 'graphql'

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

await graphql.graphql({ 
  schema, 
  source: `query MyQuery { hello(name: "world") }`, 
  variableValues: { who: 'world' }
})
