#include <algorithm>
#include <string>
#include <vector>
#include <v8.h>
#include <iostream>

#include "Heap.hpp"

namespace datadog {
  Heap::Heap() {
    uv_check_init(uv_default_loop(), &check_handle_);
    uv_unref(reinterpret_cast<uv_handle_t*>(&check_handle_));

    check_handle_.data = (void*)this;
  }

  Heap::~Heap() {
    uv_check_stop(&check_handle_);
  }

  void Heap::check_cb (uv_check_t* handle) {
    Heap* self = (Heap*)handle->data;

    v8::Isolate *isolate = v8::Isolate::GetCurrent();
    std::vector<HeapSpace> spaces;

    for (unsigned int i = 0; i < isolate->NumberOfHeapSpaces(); i++) {
      HeapSpace space;
      v8::HeapSpaceStatistics stats;

      if (isolate->GetHeapSpaceStatistics(&stats, i)) {
        space.space_name =  std::string(stats.space_name());
        space.space_size =  stats.space_size();
        space.space_used_size =  stats.space_used_size();
        space.space_available_size =  stats.space_available_size();
        space.physical_space_size =  stats.physical_space_size();

        spaces.push_back(space);
      }
    }

    self->spaces_ = spaces;
  }

  void Heap::enable() {
    uv_check_start(&check_handle_, &Heap::check_cb);
  }

  void Heap::disable() {
    uv_check_stop(&check_handle_);
  }

  void Heap::inject(Object carrier) {
    Object heap;
    std::vector<Object> objSpaces;
    std::for_each(spaces_.begin(), spaces_.end(), [&objSpaces](HeapSpace space) {
      Object objSpace;
      objSpace.set("space_name", space.space_name);
      objSpace.set("space_size", space.space_size);
      objSpace.set("space_used_size", space.space_used_size);
      objSpace.set("space_available_size", space.space_available_size);
      objSpace.set("physical_space_size", space.physical_space_size);
      objSpaces.push_back(objSpace);
    });
    heap.set("spaces", objSpaces);
    carrier.set("heap", heap);
  }
}
