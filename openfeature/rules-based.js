'use strict'

const rules = require('../vendor/dist/@datadog/openfeature-node-server/rules-based')

exports.configurationToString = rules.configurationToString
exports.ConfigurationFetchError = rules.ConfigurationFetchError
exports.fetchRulesConfiguration = rules.fetchRulesConfiguration
