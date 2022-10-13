'use strict'

function getAddress (link) {
  if (!link || !link.session || !link.session.connection) return {}

  return link.session.connection.address || {}
}

function getShortName (link) {
  if (!link || !link.name) return null

  return link.name.split('_').slice(0, -1).join('_')
}

module.exports = { getAddress, getShortName }
