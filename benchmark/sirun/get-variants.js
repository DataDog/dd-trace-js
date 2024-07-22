#!/usr/bin/env node

'use strict'

const path = require('path')
const metaJson = require(path.join(process.cwd(), 'meta.json'))
const variants = Object.keys(metaJson.variants)

process.stdout.write(variants.join(' '))
