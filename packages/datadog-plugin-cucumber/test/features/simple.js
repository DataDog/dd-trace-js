const { Before, Given, When, Then, setWorldConstructor } = require('@cucumber/cucumber')
const { expect } = require('chai')

const CustomWorld = function () {
  this.datadog = 0
}

CustomWorld.prototype.setTo = function (value) {
  this.datadog = value
}

setWorldConstructor(CustomWorld)

Before('@skip', function () {
  return 'skipped'
})

Given('datadog', function () {
  this.setTo('datadog')
})

When('run', () => {})

When('integration', function () {
  const http = require('http')
  return new Promise(resolve => {
    http.request('http://test:123', () => {
      resolve()
    }).end()
  })
})

When('db', () => {
  const { Client } = require('../../../../versions/pg').get()
  const client = new Client({
    user: 'postgres',
    password: 'postgres',
    database: 'postgres'
  })
  return client.connect().then(() => {
    return client.query('SELECT $1::text as message', ['Hello world!'])
  })
})

Then('pass', function () {
  expect(this.datadog).to.eql('datadog')
})

Then('fail', function () {
  expect(this.datadog).to.eql('godatad')
})

Then('skip', function () {
  return 'skipped'
})
