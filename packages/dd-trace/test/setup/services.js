'use strict'

const path = require('path')
const fs = require('fs')

waitForServices()
  .catch(err => {
    setImmediate(() => { throw err })
  })

function waitForServices () {
  let names = fs.readdirSync(path.join(__dirname, 'services'))
    .map(item => item.replace('.js', ''))

  if (!process.env.SERVICES) return Promise.resolve()

  if (process.env.SERVICES !== '*') {
    const filter = process.env.SERVICES.split('|')
    names = names.filter(name => ~filter.indexOf(name))
  }

  const promises = names
    .map(name => require(`./services/${name}`))
    .map(service => service())

  return Promise.all(promises)
}
