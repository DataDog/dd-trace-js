'use strict'

var sinon = require('sinon')
var chai = require('chai')
var sinonChai = require('sinon-chai')
var proxyquire = require('proxyquire')
var nock = require('nock')

chai.use(sinonChai)
nock.disableNetConnect()

global.sinon = sinon
global.expect = chai.expect
global.proxyquire = proxyquire.noCallThru()
global.nock = nock
