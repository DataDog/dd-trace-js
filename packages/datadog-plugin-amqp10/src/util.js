'use strict'

function getAddress (link) {
  if (!link || !link.session || !link.session.connection) return {}

  return link.session.connection.address || {}
}

function getShortName (link) {
  if (!link || !link.name) return null

  const lastUnderscorePosition = link.name.lastIndexOf('_')
  return lastUnderscorePosition === -1 ? link.name : link.name.slice(0, lastUnderscorePosition)
}

module.exports = { getAddress, getShortName }
