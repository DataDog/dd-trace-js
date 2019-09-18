'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')

chai.use(sinonChai)

window.sinon = sinon
window.expect = chai.expect
