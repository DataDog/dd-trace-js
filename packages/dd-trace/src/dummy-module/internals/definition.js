class Leaf {
  constructor (leafData) {
    this._data = leafData
  }

  get data () {
    return this._data
  }
}

module.exports = Leaf
