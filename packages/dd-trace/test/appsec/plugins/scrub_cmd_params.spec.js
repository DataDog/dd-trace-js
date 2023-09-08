'use strict'
const scrubCmdParams = require('./../../../src/appsec/plugins/scrub_cmd_params')
describe('scrub cmds', () => {
  it('Should not scrub single command', () => {
    expect(scrubCmdParams('ls -la')).to.be.deep.equal(['ls', '-la'])
  })

  it('Should not scrub chained command', () => {
    expect(scrubCmdParams('ls -la|grep something')).to.be.deep.equal(['ls', '-la', '|', 'grep', 'something'])
  })

  it('Should scrub environment variables', () => {
    expect(scrubCmdParams('ENV=XXX LD_PRELOAD=YYY ls')).to.be.deep.equal(['ENV=?', 'LD_PRELOAD=YYY', 'ls'])
  })

  it('Should scrub secret values', () => {
    expect(scrubCmdParams('cmd --pass abc --token=def')).to.be.deep.equal(['cmd', '--pass', '?', '--token=?'])
  })

  it('Should scrub md5 commands', () => {
    expect(scrubCmdParams('md5 -s pony')).to.be.deep.equal(['md5', '?', '?'])
    expect(scrubCmdParams('cat passwords.txt | while read line; do; md5 -s $line; done')).to.be.deep
      .equal([
        'cat',
        'passwords.txt',
        '|',
        'while',
        'read',
        'line',
        ';',
        'do',
        ';',
        'md5',
        '?',
        '?',
        ';',
        'done'
      ])
  })

  it('Should not scrub md5sum commands', () => {
    expect(scrubCmdParams('md5sum file')).to.be.deep.equal(['md5sum', 'file'])
  })

  it('Should maintain varnames', () => {
    expect(scrubCmdParams('echo $something')).to.be.deep.equal(['echo', '$something'])
  })
})
