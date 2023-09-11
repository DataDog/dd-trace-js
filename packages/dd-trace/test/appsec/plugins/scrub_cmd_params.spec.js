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
    expect(scrubCmdParams('DD_TEST=info SHELL=zsh ls -l')).to.be.deep.equal(['DD_TEST=?', 'SHELL=?', 'ls', '-l'])
  })

  it('Should scrub secret values', () => {
    expect(scrubCmdParams('cmd --pass abc --token=def')).to.be.deep.equal(['cmd', '--pass', '?', '--token=?'])

    expect(scrubCmdParams('mysqladmin -u root password very_secret'))
      .to.be.deep.equal(['mysqladmin', '-u', 'root', 'password', '?'])

    expect(scrubCmdParams('test -password very_secret -api_key 1234'))
      .to.be.deep.equal(['test', '-password', '?', '-api_key', '?'])
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

  it('should scrub shell expressions', () => {
    expect(scrubCmdParams('md5 -s secret ; mysqladmin -u root password 1234 | test api_key 4321'))
      .to.be.deep.equal([
        'md5', '?', '?', ';', 'mysqladmin', '-u', 'root', 'password', '?', '|', 'test', 'api_key', '?'
      ])
  })

  it('Should not scrub md5sum commands', () => {
    expect(scrubCmdParams('md5sum file')).to.be.deep.equal(['md5sum', 'file'])
  })

  it('Should maintain varnames', () => {
    expect(scrubCmdParams('echo $something')).to.be.deep.equal(['echo', '$something'])
  })
})
