'use strict'

const fs = require('fs')
const path = require('path')

const NODE_MODULES = 'node_modules'
const PACKAGE_JSON = 'package.json'
const PUBLISH_CONFIG = 'publishConfig'
const REGISTRY = 'registry'
const DEFAULT_REGISTRY_URL = 'registry.npmjs.org'

const isPrivateModule = function(file) {
  if (file.indexOf(NODE_MODULES) > -1) {
    const pathTokens = file.split(path.sep)
    const indexOfNodeModules = pathTokens.indexOf(NODE_MODULES)
    let packageFound = false
    let packagePath = ''
    for (let i = pathTokens.length; i--; i > indexOfNodeModules) {
      packagePath = `${pathTokens.slice(0, i).join(path.sep)}${path.sep}${PACKAGE_JSON}`
      if (fs.existsSync(packagePath)) {
          packageFound = true
          break
      }
    }

    return packageFound && hasPackageAPrivateRegistry(packagePath)
  }
  return true;
}
  
const hasPackageAPrivateRegistry = function(packagePath) {
  const packageContentRaw = fs.readFileSync(packagePath).toString()
  const packageContent = JSON.parse(packageContentRaw)
  if (Object.keys(packageContent).indexOf(PUBLISH_CONFIG) === -1 
    || Object.keys(packageContent.publishConfig).indexOf(REGISTRY) === -1) {
      return false
  }
  return packageContent.publishConfig.registry.indexOf(DEFAULT_REGISTRY_URL) === -1
}

module.exports = {
  isPrivateModule
}