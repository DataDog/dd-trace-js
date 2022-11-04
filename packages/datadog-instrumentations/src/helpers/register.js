'use strict'

const { channel } = require('diagnostics_channel')
const { extractModuleRootAndHandler, splitHandlerString } = require('./lambda')
const fs = require('fs')
const path = require('path')
const semver = require('semver')
const Hook = require('./hook')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const log = require('../../../dd-trace/src/log')

const hooks = require('./hooks')

if (process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined) {
  const lambdaTaskRoot = process.env.LAMBDA_TASK_ROOT
  const originalLambdaHandler = process.env.DD_LAMBDA_HANDLER

  const [moduleRoot, moduleAndHandler] = extractModuleRootAndHandler(originalLambdaHandler)
  const [module, _] = splitHandlerString(moduleAndHandler);

  const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, module) + '.js'
  if (fs.existsSync(lambdaStylePath)) {
    hooks[lambdaStylePath] = () => require('../aws-lambda-handler')
  }
}

const instrumentations = require('./instrumentations')
const names = Object.keys(hooks)
const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')

const loadChannel = channel('dd-trace:instrumentation:load')

// TODO: make this more efficient

for (const packageName of names) {
  Hook([packageName], (moduleExports, moduleName, moduleBaseDir) => {
    moduleName = moduleName.replace(pathSepExpr, '/')

    hooks[packageName]()

    for (const { name, file, versions, hook } of instrumentations[packageName]) {
      const fullFilename = filename(name, file)

      if (moduleName === fullFilename) {
        const version = getVersion(moduleBaseDir)

        if (matchVersion(version, versions)) {
          try {
            loadChannel.publish({ name, version, file })

            moduleExports = hook(moduleExports)
          } catch (e) {
            log.error(e)
          }
        }
      }
    }

    return moduleExports
  })
}

function matchVersion (version, ranges) {
  return !version || (ranges && ranges.some(range => semver.satisfies(semver.coerce(version), range)))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, module).version
  }
}

function filename (name, file) {
  return [name, file].filter(val => val).join('/')
}
