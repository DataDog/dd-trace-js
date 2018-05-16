'use strict'

const exec = require('child_process').execSync

exec('npm whoami')
exec('git checkout master')
exec('git pull')
exec('npm publish')
