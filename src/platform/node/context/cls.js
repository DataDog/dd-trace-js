'use strict'

const cls = require('continuation-local-storage')
const clsBluebird = require('./cls_bluebird')
const namespace = cls.createNamespace('dd-trace')

clsBluebird(namespace)

module.exports = namespace
