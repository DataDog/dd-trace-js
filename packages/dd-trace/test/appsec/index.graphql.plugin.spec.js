'use strict'

const agent = require('../../test/plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const axios = require('axios')
const getPort = require('get-port')
const path = require('path')
const proxyquire = require('proxyquire')

const imagesData = [
  {
    id: 1,
    title: 'Stacked Brwonies',
    owner: 'Ella Olson',
    category: 'Desserts',
    url: 'https://images.pexels.com/photos/3026804/pexels-photo-3026804.jpeg'
  },
  {
    id: 2,
    title: 'Shallow focus photography of Cafe Latte',
    owner: 'Kevin Menajang',
    category: 'Coffee',
    url: 'https://images.pexels.com/photos/982612/pexels-photo-982612.jpeg'
  },
  {
    id: 3,
    title: 'Sliced Cake on White Saucer',
    owner: 'Quang Nguyen Vinh',
    category: 'Desserts',
    url: 'https://images.pexels.com/photos/2144112/pexels-photo-2144112.jpeg'
  },
  {
    id: 4,
    title: 'Beverage breakfast brewed coffee caffeine',
    owner: 'Burst',
    category: 'Coffee',
    url: 'https://images.pexels.com/photos/374885/pexels-photo-374885.jpeg'
  },
  {
    id: 5,
    title: 'Pancake with Sliced Strawberry',
    owner: 'Ash',
    category: 'Desserts',
    url: 'https://images.pexels.com/photos/376464/pexels-photo-376464.jpeg'
  }
]

withVersions('graphql', 'graphql', '>=16.7.1', version => {
  describe('graphql instrumentation', () => {
    let server
    let port

    before(() => {
      return agent.load(['express', 'http', 'graphql'], { client: false })
    })

    before((done) => {
      const graphql = require(`../../../../versions/graphql@${version}`).get()
      const { buildSchema } = graphql
      const express = require('../../../../versions/express').get()

      // Somehow express-graphql ist not picking the right version of graphql so it's been
      // worked around using proxyquire.
      const { graphqlHTTP } = proxyquire('../../../../versions/node_modules/express-graphql', {
        'graphql': graphql
      })

      const schema = buildSchema(`
        type Query {
          image(id: Int!): Image
          images(category: String): [Image]
        }

        type Image {
          id: Int
          title: String
          category: String
          owner: String
          url: String
        }
      `)

      function getImage (args) {
        for (const image of imagesData) {
          if (image.id === args.id) {
            return image
          }
        }
      }

      function getImages (args) {
        if (args.category) {
          return imagesData.filter(
            (image) => image.category.toLowerCase() === args.category.toLowerCase()
          )
        } else {
          return imagesData
        }
      }
      // Resolver
      const root = {
        image: getImage,
        images: getImages
      }

      const app = express()
      app.use(
        '/graphql',
        graphqlHTTP({
          schema: schema,
          rootValue: root,
          graphiql: false
        })
      )

      getPort().then(newPort => {
        port = newPort
        server = app.listen(port, () => {
          done()
        })
      })
    })

    beforeEach(() => {
      appsec.enable(new Config({ appsec: { enabled: true, rules: path.join(__dirname, 'graphql-rules.json') } }))
    })

    afterEach(() => {
      appsec.disable()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not report any attack', async () => {
      const res = await axios({
        url: `http://localhost:${port}/graphql`,
        method: 'post',
        headers: {
          'Content-type': 'application/json'
        },
        data: {
          query: 'query getSingleImage($imageId: Int!) { image(id: $imageId) { title owner category url }}',
          variables: {
            imageId: 1
          },
          operationName: 'getSingleImage'
        }
      })

      expect(res.status).to.be.equals(200)
      expect(res.data).to.deep.equal({
        data: {
          image: {
            title: 'Stacked Brwonies',
            owner: 'Ella Olson',
            category: 'Desserts',
            url: 'https://images.pexels.com/photos/3026804/pexels-photo-3026804.jpeg'
          }
        }
      })
      await agent.use((traces) => {
        const span = traces[0][0]
        expect(span.meta).not.to.haveOwnProperty('_dd.appsec.json')
      })
    })

    it('should report an attack', async () => {
      const result = {
        triggers: [
          {
            rule:
            {
              id: 'test-rule-id-1',
              name: 'test-rule-name-1',
              on_match: ['block'],
              tags:
              {
                category: 'attack_attempt',
                type: 'security_scanner'
              }
            },
            rule_matches: [
              {
                operator: 'phrase_match',
                operator_value: '',
                parameters: [
                  {
                    address: 'graphql.server.all_resolvers',
                    key_path: ['images', '0', 'category'],
                    value: 'testattack',
                    highlight: ['testattack']
                  }
                ]
              }
            ]
          }
        ]
      }

      const res = await axios({
        url: `http://localhost:${port}/graphql`,
        method: 'post',
        headers: {
          'Content-type': 'application/json'
        },
        data: {
          query: 'query getImagesByCategory($category: String) { images(category: $category) { title owner url }}',
          variables: {
            category: 'testattack'
          },
          operationName: 'getImagesByCategory'
        }
      })

      expect(res.status).to.be.equals(200)
      await agent.use((traces) => {
        const span = traces[0][0]
        expect(span.meta['_dd.appsec.json']).to.be.equals(JSON.stringify(result))
        expect(span.meta['appsec.event']).to.be.equals('true')
        expect(span.metrics['_dd.appsec.enabled']).to.be.equals(1)
        expect(span.metrics).to.haveOwnProperty('_dd.appsec.waf.duration')
      })
    })
  })

  withVersions('graphql', '@apollo/server', apolloVersion => {
    describe('graphql apollo instrumentation', () => {
      let server
      let port

      before(() => {
        return agent.load(['express', 'http', 'graphql'], { client: false })
      })

      before(() => {
        const module = '@apollo'
        const apolloPath = require(`../../../../versions/@apollo/server@${apolloVersion}`).getPath()
        const { ApolloServer } = require(apolloPath)

        // Including @apollo/server/standalone in externals led to an error while instaling the dependencies so it'so
        // computed from the module base path
        const standalonePath = apolloPath.substr(0, apolloPath.indexOf(module) + module.length) + '/server/standalone'
        const { startStandaloneServer } = require(standalonePath)

        const typeDefs = `#graphql
            type Image {
              id: Int
              title: String
              category: String
              owner: String
              url: String
            }

            type Query {
              image(id: Int!): Image
              images(category: String): [Image]
            }
          `
        function getImage (parent, args, ctx, info) {
          for (const image of imagesData) {
            if (image.id === args.id) {
              return image
            }
          }
        }

        function getImages (parent, args, ctx, info) {
          if (args.category) {
            return imagesData.filter(
              (image) => image.category.toLowerCase() === args.category.toLowerCase()
            )
          } else {
            return imagesData
          }
        }

        const resolvers = {
          Query: {
            image: getImage,
            images: getImages
          }
        }

        server = new ApolloServer({
          typeDefs,
          resolvers
        })

        getPort().then(async (newPort) => {
          port = newPort
          await startStandaloneServer(server, {
            listen: { port }
          })
        })
      })

      beforeEach(() => {
        appsec.enable(new Config({ appsec: { enabled: true, rules: path.join(__dirname, 'graphql-rules.json') } }))
      })

      afterEach(() => {
        appsec.disable()
      })

      after(async () => {
        await server.stop()
        return agent.close({ ritmReset: false })
      })

      it('should not report any attack', async () => {
        const res = await axios({
          url: `http://localhost:${port}/graphql`,
          method: 'post',
          headers: {
            'Content-type': 'application/json'
          },
          data: {
            query: 'query getSingleImage($imageId: Int!) { image(id: $imageId) { title owner category url }}',
            variables: {
              imageId: 1
            },
            operationName: 'getSingleImage'
          }
        })

        expect(res.status).to.be.equals(200)
        expect(res.data).to.deep.equal({
          data: {
            image: {
              title: 'Stacked Brwonies',
              owner: 'Ella Olson',
              category: 'Desserts',
              url: 'https://images.pexels.com/photos/3026804/pexels-photo-3026804.jpeg'
            }
          }
        })
        await agent.use((traces) => {
          const span = traces[0][0]
          expect(span.meta).not.to.haveOwnProperty('_dd.appsec.json')
        })
      })

      it('should report an attack', async () => {
        const result = {
          triggers: [
            {
              rule:
              {
                id: 'test-rule-id-1',
                name: 'test-rule-name-1',
                on_match: ['block'],
                tags:
                {
                  category: 'attack_attempt',
                  type: 'security_scanner'
                }
              },
              rule_matches: [
                {
                  operator: 'phrase_match',
                  operator_value: '',
                  parameters: [
                    {
                      address: 'graphql.server.all_resolvers',
                      key_path: ['images', '0', 'category'],
                      value: 'testattack',
                      highlight: ['testattack']
                    }
                  ]
                }
              ]
            }
          ]
        }

        const res = await axios({
          url: `http://localhost:${port}/graphql`,
          method: 'post',
          headers: {
            'Content-type': 'application/json'
          },
          data: {
            query: 'query getImagesByCategory($category: String) { images(category: $category) { title owner url }}',
            variables: {
              category: 'testattack'
            },
            operationName: 'getImagesByCategory'
          }
        })

        expect(res.status).to.be.equals(200)
        await agent.use((traces) => {
          const span = traces[0][0]
          expect(span.meta['_dd.appsec.json']).to.be.equals(JSON.stringify(result))
          expect(span.meta['appsec.event']).to.be.equals('true')
          expect(span.metrics['_dd.appsec.enabled']).to.be.equals(1)
          expect(span.metrics).to.haveOwnProperty('_dd.appsec.waf.duration')
        })
      })
    })
  })
})
