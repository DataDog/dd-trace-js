'use strict'
const fs = require('fs')

const file = require.resolve('../k8s/auto-inst/package.json')
const pkgJson = JSON.parse(fs.readFileSync(file).toString())

pkgJson.dependencies['dd-trace'] = process.argv[2]

fs.writeFileSync(file, JSON.stringify(pkgJson, null, 2))
