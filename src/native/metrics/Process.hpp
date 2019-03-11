#pragma once

#include "Collector.hpp"
#include "Object.hpp"

namespace datadog {
  class Process : public Collector {
    public:
      Process();

      void enable();
      void disable();
      void inject(Object carrier);
  };
}
