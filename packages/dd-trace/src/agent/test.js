'use strict'

/* eslint-disable no-console */

const agent = require('.')

const query = `SELECT * FROM db WHERE password='pass'`
const spanData = {
  type: 'sql',
  resource: query
}

agent.load()
  .then(() => {
    agent.obfuscate(spanData)

    console.log('in:', query)
    console.log('out:', spanData.resource)
  })
  .catch(e => {
    console.error(e)
  })
