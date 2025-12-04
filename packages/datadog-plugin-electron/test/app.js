'use strict'

/* eslint-disable no-console */

const { app, net } = require('electron')

app.on('ready', () => {
  process.send('ready')
  process.on('message', msg => {
    try {
      switch (msg.name) {
        case 'quit': return app.quit()
        case 'fetch': return onFetch(msg)
        case 'request': return onRequest(msg)
      }
    } catch (e) {
      console.error(e)
    }
  })
})

function onFetch ({ url }) {
  net.fetch(url)
}

function onRequest ({ options }) {
  const req = net.request(options)

  req.on('error', e => console.error(e))
  req.on('response', res => {
    res.on('data', () => {})
  })

  req.end()
}
