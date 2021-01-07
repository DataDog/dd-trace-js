'use strict'

module.exports = [].concat(
  require('./fastify'),
  require('./find-my-way') // TODO make this its own plugin, since restify uses it too
)
