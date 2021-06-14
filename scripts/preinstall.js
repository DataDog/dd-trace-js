'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')

const nodeMajor = Number(process.versions.node.split('.')[0])

const range = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
)['dd-trace'].nodejsVersions

;(() => {
  if (nodeMajor < 8) {
    process.exitCode = 1
    console.error('\n' + `
You're using Node.js v${process.versions.node}, which is not supported by
dd-trace.

Please upgrade to a more recent version of Node.js.
    `.trim() + '\n')
    return
  }

  if (nodeMajor % 2 === 1 && range.includes(nodeMajor)) {
    oddVersion()
  }

  if (!range.includes(nodeMajor)) {
    process.exitCode = 1
    // eslint-disable-next-line no-console
    console.error(incompatMessage())
  }
})()

function incompatMessage () {
  return '\n' + `
The version of dd-trace you're attempting to install is incompatible with the
version of Node.js you're using.

Please use the following to switch to a compatible dd-trace version:

${versionInstall()}
  `.trim() + '\n'
}

function versionInstall () {
  const output = {
    npm () {
      return `npm rm dd-trace; npm install dd-trace@node${nodeMajor}`
    },
    yarn () {
      return `yarn remove dd-trace; yarn add dd-trace@node${nodeMajor}`
    },
    pnpm () {
      return `pnpm rm dd-trace; pnpm install dd-trace@node${nodeMajor}`
    }
  }

  let packageManager = process.env.npm_execpath
    ? path.basename(process.env.npm_execpath)
    : 'npm'

  if (!(packageManager in output)) {
    packageManager = 'npm'
  }

  return '    ' + output[packageManager]()
}

function oddVersion () {
  console.error('\n' + `
You're using Node.js v${process.versions.node}.
Odd-numbered release lines of Node.js do not receive long-term support from
Node.js or from dd-trace. Support for dd-trace with this version of Node.js is
limited.

Please consider switching to an even-numbered release line of Node.js.
`.trim() + '\n')
}
