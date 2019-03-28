#include <string>
#include <vector>
#include <v8.h>

#include "Heap.hpp"

namespace datadog {
  void Heap::inject(Object carrier) {
    v8::Isolate *isolate = v8::Isolate::GetCurrent();
    Object heap;
    std::vector<Object> spaces;

    for (unsigned int i = 0; i < isolate->NumberOfHeapSpaces(); i++) {
      Object space;
      v8::HeapSpaceStatistics stats;

      if (isolate->GetHeapSpaceStatistics(&stats, i)) {
        space.set("space_name", std::string(stats.space_name()));
        space.set("space_size", stats.space_size());
        space.set("space_used_size", stats.space_used_size());
        space.set("space_available_size", stats.space_available_size());
        space.set("physical_space_size", stats.physical_space_size());

        spaces.push_back(space);
      }
    }

    heap.set("spaces", spaces);
    carrier.set("heap", heap);
  }
}
