const proxyquire = require('proxyquire')
describe('sendData', () => {
  let sendDataModule
  let request
  beforeEach(() => {
    request = sinon.stub()
    sendDataModule = proxyquire('../../src/telemetry/send-data', {
      '../exporters/common/request': request
    })
  })
  it('should call to request', () => {
    sendDataModule.sendData({ hostname: '', port: '12345', tags: { 'runtime-id': '123' } }, 'test', 'test', 'req-type')
    expect(request).to.have.been.calledOnce
  })
})
