'use strict'

const t = require('tap')
require('../../setup/core')

const getPort = require('get-port')
const { extractIp } = require('../../../src/plugins/util/ip_extractor')
const http = require('http')
const axios = require('axios')

t.test('ip extractor', t => {
  let port, appListener, controller

  t.before(() => {
    return getPort().then(newPort => {
      port = newPort
    })
  })

  t.before(async () => {
    const server = new http.Server(async (req, res) => {
      controller && (await controller(req, res))
      res.writeHead(200)
      res.end(JSON.stringify({ message: 'OK' }))
    })
    appListener = server
      .listen(port, 'localhost', () => t.end())
  })

  t.after(() => {
    appListener && appListener.close()
  })
  const ipHeaderList = [
    'x-forwarded-for',
    'x-real-ip',
    'true-client-ip',
    'x-client-ip',
    'forwarded-for',
    'x-cluster-client-ip',
    'fastly-client-ip',
    'cf-connecting-ip',
    'cf-connecting-ipv6'
  ]
  ipHeaderList.forEach(ipHeader => {
    t.test(`should detect ip in header '${ipHeader}'`, (t) => {
      const expectedIp = '1.2.3.4'
      controller = function (req) {
        const ip = extractIp({}, req)
        try {
          expect(ip).to.be.equal(expectedIp)
          t.end()
        } catch (e) {
          t.error(e)
          t.end()
        }
      }
      axios.get(`http://localhost:${port}/`, {
        headers: {
          [ipHeader]: expectedIp
        }
      }).catch(t.error)
    })

    t.test(`should detect ipv6 in header '${ipHeader}'`, (t) => {
      const expectedIp = '5a54:f844:006c:b8f1:0e96:9e54:54ac:4a2d'
      controller = function (req) {
        const ip = extractIp({}, req)
        try {
          expect(ip).to.be.equal(expectedIp)
          t.end()
        } catch (e) {
          t.error(e)
          t.end()
        }
      }
      axios.get(`http://localhost:${port}/`, {
        headers: {
          [ipHeader]: expectedIp
        }
      }).catch(t.error)
    })
  })

  t.test('should detect ip in custom ip header', (t) => {
    const clientIpHeader = 'x-custom-ip-header'
    const expectedIp = '1.2.3.4'
    controller = function (req) {
      const ip = extractIp({ clientIpHeader }, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        [clientIpHeader]: expectedIp
      }
    }).catch(t.error)
  })

  t.test('should detect ip in custom ipv6 header', (t) => {
    const clientIpHeader = 'x-custom-ip-header'
    const expectedIp = '5a54:f844:006c:b8f1:0e96:9e54:54ac:4a2d'
    controller = function (req) {
      const ip = extractIp({ clientIpHeader }, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        [clientIpHeader]: expectedIp
      }
    }).catch(t.error)
  })

  t.test('should not detect ip in custom header with wrong value', (t) => {
    const clientIpHeader = 'x-custom-ip-header'
    const expectedIp = 'evil-ip'
    controller = function (req) {
      const ip = extractIp({ clientIpHeader }, req)
      try {
        expect(ip).to.be.undefined
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        [clientIpHeader]: expectedIp
      }
    }).catch(t.error)
  })

  t.test('should detect first public ip from multiple header configured', (t) => {
    const ip1 = '1.2.3.4'
    const ip2 = '1.2.3.5'
    const ip3 = '1.2.3.6'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(ip1)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': ip1,
        'x-client-ip': ip2,
        'true-client-ip': ip3
      }
    }).catch(t.error)
  })

  t.test('should detect first public ip from multiple header configured with ipv6', (t) => {
    const ip1 = '2f0e:8a33:3211:6e69:e1e0:63d1:919e:4477'
    const ip2 = '4498:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const ip3 = 'faa4:bf6b:fc08:5fa6:a58d:bd95:c23a:69a9'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(ip1)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': ip1,
        'x-client-ip': ip2,
        'true-client-ip': ip3
      }
    }).catch(t.error)
  })

  t.test('should detect first public ip', (t) => {
    const ip1 = '192.168.10.1'
    const ip2 = '172.16.3.5'
    const expectedIp = '1.2.3.4'
    const ip4 = '1.2.3.6'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': `${ip1},${ip2},${expectedIp},${ip4}`
      }
    }).catch(t.error)
  })

  t.test('should detect first public ipv6', (t) => {
    const ip1 = '192.168.10.1'
    const ip2 = 'fec0:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const expectedIp = '4498:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const ip4 = '::1'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': `${ip1},${ip2},  ${expectedIp} ,${ip4}`
      }
    }).catch(t.error)
  })

  t.test('should detect first private ip when all ips are private', (t) => {
    const expectedIp = '192.168.10.1'
    const ip2 = '172.16.3.5'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': `${expectedIp},${ip2}`
      }
    }).catch(t.error)
  })

  t.test('should detect first private ip when all ips are private ipv6', (t) => {
    const expectedIp = 'fec0:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const ip2 = '::1'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': `${expectedIp},${ip2}`
      }
    }).catch(t.error)
  })

  t.test('should detect ::1 or 127.0.0.1 (socket address in test) if nothing is configured', (t) => {
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(['::1', '127.0.0.1']).to.include(ip)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`).catch(t.error)
  })

  t.test('should detect public ip between multiple headers', (t) => {
    const ip1 = '192.168.10.1'
    const ip2 = '192.168.10.2'
    const ip3Public = '1.2.3.4'
    const ip3 = `192.168.10.2,${ip3Public}`
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(ip3Public)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': ip1,
        'x-client-ip': ip2,
        'true-client-ip': ip3
      }
    }).catch(t.error)
  })
  t.end()
})
