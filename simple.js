const { parse } = require('graphql')

const typeDefs = `#graphql
  type Query {
    serviceA: String
  }
`

const resolvers = {
  Query: {
    serviceA () {
      return 'Hello from Service A'
    }
  }
}

const name = 'accounts'

exports.name = name
exports.typeDefs = parse(typeDefs)
exports.url = `https://${name}.api.com.invalid`
exports.resolvers = resolvers
