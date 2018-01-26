'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const proxyquire = require('proxyquire')
const nock = require('nock')

chai.use(sinonChai)
nock.disableNetConnect()

global.sinon = sinon
global.expect = chai.expect
global.proxyquire = proxyquire.noCallThru()
global.nock = nock
