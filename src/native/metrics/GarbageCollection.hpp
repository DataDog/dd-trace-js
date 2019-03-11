#pragma once

#include <map>
#include <stdint.h>
#include <uv.h>
#include <v8.h>

#include "Collector.hpp"
#include "Histogram.hpp"
#include "Object.hpp"

namespace datadog {
  class GarbageCollection : public Collector {
    public:
      GarbageCollection();

      void before(v8::GCType type);
      void after(v8::GCType type);
      void inject(Object carrier);
    private:
      std::map<v8::GCType, Histogram> pause_;
      uint64_t start_time_;
  };
}
