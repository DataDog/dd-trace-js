'use strict'

describe('docker', () => {
  let docker
  let fs

  beforeEach(() => {
    fs = {
      readFileSync: sinon.stub()
    }
  })

  it('should return an empty ID when the cgroup cannot be read', () => {
    docker = proxyquire('../src/exporters/common/docker', { fs })

    expect(docker.id()).to.be.undefined
  })

  it('should support IDs with long format', () => {
    const cgroup = [
      '1:name=systemd:/docker/34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })

    expect(docker.id()).to.equal('34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376')
  })

  it('should support IDs with UUID format', () => {
    const cgroup = [
      '1:name=systemd:/uuid/34dc0b5e-626f-2c5c-4c51-70e34b10e765'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })

    expect(docker.id()).to.equal('34dc0b5e-626f-2c5c-4c51-70e34b10e765')
  })

  it('should support IDs with ECS task format', () => {
    const cgroup = [
      '1:name=systemd:/ecs/34dc0b5e626f2c5c4c5170e34b10e765-1234567890'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })

    expect(docker.id()).to.equal('34dc0b5e626f2c5c4c5170e34b10e765-1234567890')
  })

  it('should support IDs with Kubernetes format', () => {
    const cgroup = [
      '1:name=systemd:/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod2d3da189_6407_48e3_9ab6_78188d75e609.slice/docker-7b8952daecf4c0e44bbcefe1b5c5ebc7b4839d4eefeccefe694709d3809b6199.scope' // eslint-disable-line max-len
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })

    expect(docker.id()).to.equal('7b8952daecf4c0e44bbcefe1b5c5ebc7b4839d4eefeccefe694709d3809b6199')
  })

  it('should support finding IDs on any line of the cgroup', () => {
    const cgroup = [
      '1:name=systemd:/nope',
      '2:pids:/docker/34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376',
      '3:cpu:/invalid'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })

    expect(docker.id()).to.equal('34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376')
  })

  it('should support Control Group v2', () => {
    const cgroup = [
      '0::/docker/34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
    ].join('\n')

    fs.readFileSync.withArgs('/proc/self/cgroup').returns(Buffer.from(cgroup))
    docker = proxyquire('../src/exporters/common/docker', { fs })

    expect(docker.id()).to.equal('34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376')
  })
})
