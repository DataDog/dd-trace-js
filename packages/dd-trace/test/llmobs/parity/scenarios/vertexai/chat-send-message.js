'use strict'
require('./_runner').run('chat-send-message').catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
