'use strict'

const cls = require('cls-hooked')
const clsBluebird = require('cls-bluebird')
const namespace = cls.createNamespace('dd-trace')

clsBluebird(namespace)

module.exports = namespace
