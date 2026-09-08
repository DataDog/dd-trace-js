'use strict'
require('./_runner').run('invoke-anthropic-messages').catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
