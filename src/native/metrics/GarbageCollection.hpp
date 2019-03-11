#pragma once

#include "Collector.hpp"
#include "Histogram.hpp"
#include "Object.hpp"

namespace datadog {
  class GarbageCollection : public Collector {
    public:
      GarbageCollection();

      void enable();
      void disable();
      void inject(Object carrier);
    private:
      Histogram pause_;
  };
}
