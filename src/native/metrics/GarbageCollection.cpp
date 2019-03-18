#include "GarbageCollection.hpp"

namespace datadog {
  GarbageCollection::GarbageCollection() {
    pause_[v8::GCType::kGCTypeAll] = Histogram();
  }

  void GarbageCollection::before(v8::GCType type) {
    start_time_ = uv_hrtime();
  }

  void GarbageCollection::after(v8::GCType type) {
    uint64_t usage = uv_hrtime() - start_time_;

    if (pause_.find(type) == pause_.end()) {
      pause_[type] = Histogram();
    }

    pause_[type].add(usage);
    pause_[v8::GCType::kGCTypeAll].add(usage);
  }

  void GarbageCollection::inject(Object carrier) {
    Object value;

    for (std::map<v8::GCType, Histogram>::iterator it = pause_.begin(); it != pause_.end(); ++it) {
      value.set(types_[it->first], it->second);
      it->second.reset();
    }

    carrier.set("gc", value);
  }
}
