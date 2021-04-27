'use strict'

const { version } = process.env

const build = require(`../../../versions/next@${version}`).get('next/dist/build').default

build(__dirname)
