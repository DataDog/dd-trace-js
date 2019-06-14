#pragma once

#include "Collector.hpp"
#include "Object.hpp"

namespace datadog {
  class Heap : public Collector {
    public:
      void inject(Object carrier);
  };
}
