require('./init')

const { gql } = require('graphql-tag')
const { ApolloGateway, LocalGraphQLDataSource } = require('@apollo/gateway')
const { buildSubgraphSchema } = require('@apollo/subgraph')
const accounts = require('./simple.js')

const fixtures = [accounts]

async function execute (executor, source, variables, operationName) {
  const resp = await executor({
    source,
    document: gql(source),
    request: {
      variables
    },
    operationName,
    queryHash: 'hashed',
    context: null,
    cache: {}
  })
  return resp
}

async function gateway () {
  const localDataSources = { 'accounts': new LocalGraphQLDataSource(buildSubgraphSchema(fixtures[0])) }

  const gateway = new ApolloGateway({
    localServiceList: fixtures,
    buildService (service) {
      return localDataSources[service.name]
    }
  })

  const { executor } = await gateway.load()
  return executor
}

// Create a new async function to use the await keyword
async function main () {
  const executor = await gateway()

  // const source = `#graphql
  //     query GetProduct($upc: String!) {
  //       product(upc: $upc) {
  //         name
  //       }
  //     }
  //   `

  // await execute(executor, source, { upc: '1' }, 'GetProduct')
  const source = `#graphql
      query GetServiceA {
        serviceA
      }
    `

  // Execute the query
  const result = await execute(executor, source, {}, 'GetServiceA') // Note: No variables are needed for this query
  console.log(55, result)
}

main().catch((error) => {
  console.error('Error in main function:', error)
})
