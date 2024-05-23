'use strict'

let enabled = false

function isStandaloneEnabled () {
  return enabled
}

function configure (config) {
  enabled = !!config.appsec?.standalone?.enabled
}

module.exports = {
  isStandaloneEnabled,
  configure
}
