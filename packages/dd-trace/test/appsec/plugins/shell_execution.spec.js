'use strict'

const ChildProcessPlugin = require('./../../../src/appsec/plugins/shell_execution')
const { storage } = require('../../../../datadog-core')

describe('Shell execution plugin', () => {
  let tracerStub, configStub, spanStub

  beforeEach(() => {
    spanStub = {
      setTag: sinon.stub(),
      finish: sinon.stub()
    }

    tracerStub = {
      startSpan: sinon.stub()
    }
  })

  it('should call startSpan with proper parameters', () => {
    const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

    shellPlugin.start({ command: 'ls -l' })
    expect(tracerStub.startSpan).to.have.been.calledOnceWithExactly(
      'command_execution',
      {
        childOf: undefined,
        tags: {
          component: 'subprocess',
          'service.name': undefined,
          'resource.name': 'ls',
          'span.kind': undefined,
          'span.type': 'system',
          'cmd.exec': [ 'ls', '-l' ]
        },
        integrationName: 'system'
      }
    )
  })

  it('should not crash if command is not a string', () => {
    const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

    shellPlugin.start({ command: undefined })
    expect(tracerStub.startSpan).not.to.have.been.called
  })

  it('should not crash if command does not exist', () => {
    const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

    shellPlugin.start({})
    expect(tracerStub.startSpan).not.to.have.been.called
  })

  it('should call setTag with proper code', () => {
    sinon.stub(storage, 'getStore').returns({ span: spanStub })
    const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

    shellPlugin.finish({ exitCode: 0 })
    expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', '0')
    expect(spanStub.finish).to.have.been.calledOnceWithExactly()
  })

  it('should return proper prefix', () => {
    expect(ChildProcessPlugin.prefix).to.be.equal('datadog:child_process:execution')
  })

  it('should return proper id', () => {
    expect(ChildProcessPlugin.id).to.be.equal('subprocess')
  })
})
