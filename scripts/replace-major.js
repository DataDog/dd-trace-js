'use strict'

const fs = require('fs')
const packageJson = require('../package.json')

const major = process.argv[2]

const versionArr = packageJson.version.split('.')
packageJson.version = `${major}.${versionArr[1]}.${versionArr[2]}`

fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2))
