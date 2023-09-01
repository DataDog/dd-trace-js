'use strict'

const scrubChildProcessCmd = require('../../src/appsec/plugins/scrub_cmd_params')

describe('Scrub shell injection command', () => {
  it('should scrub environment variables', () => {
    const command = 'DD_TEST=info SHELL=zsh ls -l'

    const result = scrubChildProcessCmd(command)
    expect(result).to.be.equal('DD_TEST=? SHELL=? ls -l')
  })

  it('should scrub a parameters value', () => {
    const command = 'mysqladmin -u root password very_secret'

    const result = scrubChildProcessCmd(command)
    expect(result).to.be.equal('mysqladmin -u root password ?')
  })

  it('should scrub several parameters values', () => {
    const command = 'test -password very_secret -api_key 1234'

    const result = scrubChildProcessCmd(command)
    expect(result).to.be.equal('test -password ? -api_key ?')
  })

  it('should scrub all parameters from a command present in the denylist', () => {
    const command = 'md5 -s secret'

    const result = scrubChildProcessCmd(command)
    expect(result).to.be.equal('md5 ? ?')
  })

  it('should scrub a shell expression', () => {
    const command = 'md5 -s secret ; mysqladmin -u root password 1234 | test api_key 4321'

    const result = scrubChildProcessCmd(command)
    expect(result).to.be.equal('md5 ? ? ; mysqladmin -u root password ? | test api_key ?')
  })
})
