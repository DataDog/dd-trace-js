'use strict'

const { HTTP_ROUTE } = require('../../../../../../ext/tags')
const web = require('../../../plugins/util/web')
const express = require('./express')
const fastify = require('./fastify')

/**
 * Normalize the route using the framework that owns the HTTP span.
 * @param {object} req
 */
function normalizeRoute (req) {
  const spanContext = web.root(req)?.context()
  const component = spanContext?.getTag?.('component')
  const route = spanContext?.getTag?.(HTTP_ROUTE)

  switch (component) {
    case 'express':
      return express.normalizeRequest(req, route)
    case 'fastify':
      return fastify.normalizeRequest(req, route)
    default:
      return null
  }
}

module.exports = { normalizeRoute, onRouteCreate: express.onRouteCreate }
