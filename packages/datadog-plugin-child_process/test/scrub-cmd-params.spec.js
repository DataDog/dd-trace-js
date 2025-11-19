'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { describe, it } = require('mocha')

const scrubCmdParams = require('../src/scrub-cmd-params')
describe('scrub cmds', () => {
  it('Should not scrub single command', () => {
    assert.deepStrictEqual(scrubCmdParams('ls -la'), ['ls', '-la'])
  })

  it('Should split correctly comments', () => {
    assert.deepStrictEqual(scrubCmdParams('ls #comment'), ['ls', '#comment'])
    assert.deepStrictEqual(scrubCmdParams('ls #comment with spaces'), ['ls', '#comment with spaces'])
  })

  it('Should split globs', () => {
    assert.deepStrictEqual(scrubCmdParams('ls node_modules/*'), ['ls', 'node_modules/*'])
    assert.deepStrictEqual(scrubCmdParams('ls *'), ['ls', '*'])
  })

  it('Should split correctly texts', () => {
    assert.deepStrictEqual(scrubCmdParams('echo "Hello\\ text"'), ['echo', 'Hello\\ text'])
    expect(scrubCmdParams('node -e "process.exit(1)"')).to.be.deep.equal(['node', '-e', 'process.exit(1)'])
  })

  it('Should not scrub chained command', () => {
    assert.deepStrictEqual(scrubCmdParams('ls -la|grep something'), ['ls', '-la', '|', 'grep', 'something'])
  })

  it('Should scrub environment variables', () => {
    assert.deepStrictEqual(scrubCmdParams('ENV=XXX LD_PRELOAD=YYY ls'), ['ENV=?', 'LD_PRELOAD=YYY', 'ls'])
    assert.deepStrictEqual(scrubCmdParams('DD_TEST=info SHELL=zsh ls -l'), ['DD_TEST=?', 'SHELL=?', 'ls', '-l'])
  })

  it('Should scrub secret values', () => {
    assert.deepStrictEqual(scrubCmdParams('cmd --pass abc --token=def'), ['cmd', '--pass', '?', '--token=?'])

    expect(scrubCmdParams('mysqladmin -u root password very_secret'))
      .to.be.deep.equal(['mysqladmin', '-u', 'root', 'password', '?'])

    expect(scrubCmdParams('test -password very_secret -api_key 1234'))
      .to.be.deep.equal(['test', '-password', '?', '-api_key', '?'])

    expect(scrubCmdParams('test --address https://some.address.com --email testing@to.es --api-key 1234'))
      .to.be.deep.equal(['test', '--address', '?', '--email', '?', '--api-key', '?'])
  })

  it('Should scrub md5 commands', () => {
    assert.deepStrictEqual(scrubCmdParams('md5 -s pony'), ['md5', '?', '?'])

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
    assert.deepStrictEqual(scrubCmdParams('md5 -s secret ; mysqladmin -u root password 1234 | test api_key 4321'), [
      'md5', '?', '?', ';', 'mysqladmin', '-u', 'root', 'password', '?', '|', 'test', 'api_key', '?'
    ])
  })

  it('Should not scrub md5sum commands', () => {
    assert.deepStrictEqual(scrubCmdParams('md5sum file'), ['md5sum', 'file'])
  })

  it('Should maintain var names', () => {
    assert.deepStrictEqual(scrubCmdParams('echo $something'), ['echo', '$something'])
  })
})
