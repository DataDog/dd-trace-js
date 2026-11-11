'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('./setup/core')

const { quantizePeerIpAddresses } = require('../src/quantize-peer-ip-addresses')

// The Agent's `TestQuantizePeerIpAddresses` cases (pkg/obfuscate/ip_address_test.go).
const cases = [
  ['127.0.0.1', '127.0.0.1'],
  ['::1', '::1'],
  ['169.254.169.254', '169.254.169.254'],
  ['fd00:ec2::254', 'fd00:ec2::254'],
  ['169.254.170.2', '169.254.170.2'],
  ['', ''],
  ['foo.dog', 'foo.dog'],
  ['192.168.1.1', 'blocked-ip-address'],
  ['192.168.1.1.foo', 'blocked-ip-address.foo'],
  ['192.168.1.1.2.3.4.5', 'blocked-ip-address.2.3.4.5'],
  ['192_168_1_1', 'blocked-ip-address'],
  ['192-168-1-1', 'blocked-ip-address'],
  ['192-168-1-1.foo', 'blocked-ip-address.foo'],
  ['192-168-1-1-foo', 'blocked-ip-address-foo'],
  ['2001:db8:3333:4444:CCCC:DDDD:EEEE:FFFF', 'blocked-ip-address'],
  ['2001:db8:3c4d:15::1a2f:1a2b', 'blocked-ip-address'],
  ['[fe80::1ff:fe23:4567:890a]:8080', 'blocked-ip-address:8080'],
  ['192.168.1.1:1234', 'blocked-ip-address:1234'],
  ['dnspoll:///10.21.120.145:6400', 'dnspoll:///blocked-ip-address:6400'],
  ['dnspoll:///abc.cluster.local:50051', 'dnspoll:///abc.cluster.local:50051'],
  ['http://10.21.120.145:6400', 'http://blocked-ip-address:6400'],
  ['https://10.21.120.145:6400', 'https://blocked-ip-address:6400'],
  [
    '192.168.1.1:1234,10.23.1.1:53,10.23.1.1,fe80::1ff:fe23:4567:890a,foo.dog',
    'blocked-ip-address:1234,blocked-ip-address:53,blocked-ip-address,foo.dog',
  ],
  [
    'http://172.24.160.151:8091,172.24.163.33:8091,172.24.164.111:8091,172.24.165.203:8091,172.24.168.235:8091,' +
      '172.24.170.130:8091',
    'http://blocked-ip-address:8091,blocked-ip-address:8091',
  ],
  [
    '10-60-160-172.my-service.namespace.svc.abc.cluster.local',
    'blocked-ip-address.my-service.namespace.svc.abc.cluster.local',
  ],
  ['ip-10-152-4-129.ec2.internal', 'ip-blocked-ip-address.ec2.internal'],
  ['1-foo', '1-foo'],
  ['1-2-foo', '1-2-foo'],
  ['1-2-3-foo', '1-2-3-foo'],
  ['1-2-3-999', '1-2-3-999'],
  ['1-2-999-foo', '1-2-999-foo'],
  ['1-2-3-999-foo', '1-2-3-999-foo'],
  ['1-2-3-4-foo', 'blocked-ip-address-foo'],
  ['7-55-2-app.agent.datadoghq.com', '7-55-2-app.agent.datadoghq.com'],
]

describe('quantizePeerIpAddresses', () => {
  for (const [original, quantized] of cases) {
    it(`should quantize ${JSON.stringify(original)}`, () => {
      assert.strictEqual(quantizePeerIpAddresses(original), quantized)
    })
  }
})
