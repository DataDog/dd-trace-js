'use strict'

const tracer = require('dd-trace')
const path = require('path')

tracer.init({
  debug: true,
  port: process.env.AGENT_PORT,
  appsec: {
    enabled: true,
    rules: path.join(__dirname, 'graphql-rules.json')
  }
})

const { ApolloServer } = require('@apollo/server')
const { startStandaloneServer } = require('@apollo/server/standalone')

const typeDefs = `#graphql
      type Query {
        image(imageId: Int!): Image
        images(category: String): [Image]
      }

      type Image {
        id: Int
        title: String
        category: String
        owner: String
        url: String
      }
`

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

function getImage (parent, args, contextValue, info) {
  for (const image of imagesData) {
    if (image.id === args.imageId) {
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

const resolvers = {
  Query: {
    image: getImage,
    images: getImages
  }
}

async function main () {
  const server = new ApolloServer({
    typeDefs,
    resolvers
  })

  const { url } = await startStandaloneServer(server, { listen: { port: process.env.APP_PORT || 0 } })
  const port = new URL(url).port
  process.send?.({ port })
}

main()
