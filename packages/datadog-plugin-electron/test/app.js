'use strict'

const { app, net } = require('electron')

const { PORT } = process.env

app.on('ready', () => {
  process.send('ready')
  process.on('message', msg => msg === 'quit' && app.quit())

  net.fetch(`http://127.0.0.1:${PORT}`)
})
