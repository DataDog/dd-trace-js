'use strict'
require('./_runner').run('invoke-anthropic-tool-use').catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
