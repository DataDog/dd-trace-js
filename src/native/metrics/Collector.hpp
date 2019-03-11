#pragma once

#include "Object.hpp"

namespace datadog {
  class Collector {
    public:
      virtual void enable() = 0;
      virtual void disable() = 0;
      virtual void inject(Object carrier) = 0;
  };
}
