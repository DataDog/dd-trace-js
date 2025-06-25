'use strict'

const t = require('tap')
require('../../setup/core')

t.test('docker', t => {
  let docker
  let fs
  let carrier
  let externalEnv

  t.beforeEach(() => {
    fs = {
      readFileSync: sinon.stub(),
      statSync: sinon.stub()
    }
    carrier = {}
    externalEnv = process.env.DD_EXTERNAL_ENV
  })

  t.afterEach(() => {
    process.env.DD_EXTERNAL_ENV = externalEnv
  })

  t.test('should not inject IDs when the cgroup cannot be read', t => {
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.be.undefined
    expect(carrier['Datadog-Entity-ID']).to.be.undefined
    t.end()
  })

  t.test('should support IDs with long format', t => {
    const id = '34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
    const cgroup = [
      `1:name=systemd:/docker/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup', 'utf8').returns(cgroup)
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`ci-${id}`)
    t.end()
  })

  t.test('should support IDs with UUID format', t => {
    const id = '34dc0b5e-626f-2c5c-4c51-70e34b10e765'
    const cgroup = [
      `1:name=systemd:/uuid/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup', 'utf8').returns(cgroup)
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`ci-${id}`)
    t.end()
  })

  t.test('should support IDs with ECS task format', t => {
    const id = '34dc0b5e626f2c5c4c5170e34b10e765-1234567890'
    const cgroup = [
      `1:name=systemd:/ecs/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup', 'utf8').returns(cgroup)
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`ci-${id}`)
    t.end()
  })

  t.test('should support IDs with Kubernetes format', t => {
    const id = '7b8952daecf4c0e44bbcefe1b5c5ebc7b4839d4eefeccefe694709d3809b6199'
    const cgroup = [
      `1:name=systemd:/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod2d3da189_6407_48e3_9ab6_78188d75e609.slice/docker-${id}.scope` // eslint-disable-line @stylistic/max-len
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup', 'utf8').returns(cgroup)
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`ci-${id}`)
    t.end()
  })

  t.test('should support finding IDs on any line of the cgroup', t => {
    const id = '34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
    const cgroup = [
      '1:name=systemd:/nope',
      `2:pids:/docker/${id}`,
      '3:cpu:/invalid'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup', 'utf8').returns(cgroup)
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`ci-${id}`)
    t.end()
  })

  t.test('should support Control Group v2', t => {
    const id = '34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
    const cgroup = [
      `0::/docker/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup', 'utf8').returns(cgroup)
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`ci-${id}`)
    t.end()
  })

  t.test('should support Cloud Foundry', t => {
    const id = '6f265890-5165-7fab-6b52-18d1'
    const cgroup = [
      `1:name=systemd:/system.slice/garden.service/garden/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup', 'utf8').returns(cgroup)
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`ci-${id}`)
    t.end()
  })

  t.test('should support inode when the ID is not available', t => {
    const ino = 1234
    const cgroup = [
      '1:name=systemd:/system.slice/garden.service/garden/'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup', 'utf8').returns(cgroup)
    fs.statSync.withArgs('/sys/fs/cgroup/system.slice/garden.service/garden').returns({ ino })
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.be.undefined
    expect(carrier['Datadog-Entity-ID']).to.equal(`in-${ino}`)
    t.end()
  })

  t.test('should support inode when the ID is not available (any line)', t => {
    const ino = 1234
    const cgroup = [
      '1:name=systemd:/',
      '0::/'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup', 'utf8').returns(cgroup)
    fs.statSync.withArgs('/sys/fs/cgroup/').returns({ ino })
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.be.undefined
    expect(carrier['Datadog-Entity-ID']).to.equal(`in-${ino}`)
    t.end()
  })

  t.test('should support external env', t => {
    process.env.DD_EXTERNAL_ENV = 'test'

    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-External-Env']).to.equal('test')
    t.end()
  })
  t.end()
})
