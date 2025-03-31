'use strict'

require('../../setup/tap')

describe('docker', () => {
  let docker
  let fs
  let carrier

  beforeEach(() => {
    fs = {
      readFileSync: sinon.stub(),
      statSync: sinon.stub()
    }
    carrier = {}
  })

  it('should not inject IDs when the cgroup cannot be read', () => {
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.be.undefined
    expect(carrier['Datadog-Entity-ID']).to.be.undefined
  })

  it('should support IDs with long format', () => {
    const id = '34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
    const cgroup = [
      `1:name=systemd:/docker/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`cid-${id}`)
  })

  it('should support IDs with UUID format', () => {
    const id = '34dc0b5e-626f-2c5c-4c51-70e34b10e765'
    const cgroup = [
      `1:name=systemd:/uuid/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`cid-${id}`)
  })

  it('should support IDs with ECS task format', () => {
    const id = '34dc0b5e626f2c5c4c5170e34b10e765-1234567890'
    const cgroup = [
      `1:name=systemd:/ecs/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`cid-${id}`)
  })

  it('should support IDs with Kubernetes format', () => {
    const id = '7b8952daecf4c0e44bbcefe1b5c5ebc7b4839d4eefeccefe694709d3809b6199'
    const cgroup = [
      `1:name=systemd:/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod2d3da189_6407_48e3_9ab6_78188d75e609.slice/docker-${id}.scope` // eslint-disable-line @stylistic/js/max-len
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`cid-${id}`)
  })

  it('should support finding IDs on any line of the cgroup', () => {
    const id = '34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
    const cgroup = [
      '1:name=systemd:/nope',
      `2:pids:/docker/${id}`,
      '3:cpu:/invalid'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`cid-${id}`)
  })

  it('should support Control Group v2', () => {
    const id = '34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
    const cgroup = [
      `0::/docker/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`cid-${id}`)
  })

  it('should support Cloud Foundry', () => {
    const id = '6f265890-5165-7fab-6b52-18d1'
    const cgroup = [
      `1:name=systemd:/system.slice/garden.service/garden/${id}`
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.equal(id)
    expect(carrier['Datadog-Entity-ID']).to.equal(`cid-${id}`)
  })

  it('should support inode when the ID is not available', () => {
    const ino = 1234
    const cgroup = [
      '1:name=systemd:/system.slice/garden.service/garden/'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    fs.statSync.withArgs('/sys/fs/cgroup/system.slice/garden.service/garden').returns({ ino })
    docker = proxyquire('../src/exporters/common/docker', { fs })
    docker.inject(carrier)

    expect(carrier['Datadog-Container-Id']).to.be.undefined
    expect(carrier['Datadog-Entity-ID']).to.equal(`in-${ino}`)
  })
})
