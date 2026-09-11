// Preflight validation of a demo APM_TRACING config payload against the REAL dd-go
// backend code, rather than against a hand-written assumption about the wire format.
//
// This file is copied into dd-go by ../preflight.sh, run there, and removed again;
// it is not part of either repository's source tree.
//
// It exercises:
//   - jsonconf.Configuration / jsonconf.SDKConfig  -- the real request model, including the
//     object-map form introduced by ddoghq/dd-go#14029 and the legacy {key,value} array
//     decoder in sdkconfig_legacy.go
//   - sdkconfigsecurity.NormalizeAndValidateCanonical / ValidateStored / IsAllowed -- the real
//     server-side allowlist and denylist
//
// Payload file is passed via DEMO_PAYLOAD.

package sdkconfigsecurity_test

import (
	"encoding/json"
	"os"
	"sort"
	"testing"

	"github.com/DataDog/dd-go/remote-config/pkg/products/apmtracing/jsonconf"
	"github.com/DataDog/dd-go/remote-config/pkg/products/apmtracing/sdkconfigsecurity"
)

func TestDemoPayloadPreflight(t *testing.T) {
	path := os.Getenv("DEMO_PAYLOAD")
	if path == "" {
		t.Fatal("DEMO_PAYLOAD not set")
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading payload: %v", err)
	}

	t.Logf("payload file: %s", path)
	t.Logf("raw payload:\n%s", raw)

	// 1. Decode with the real request model. This is where the object-vs-array shape of
	//    sdk_config.config is decided, by jsonconf's own UnmarshalJSON.
	var conf jsonconf.Configuration
	if err := json.Unmarshal(raw, &conf); err != nil {
		t.Fatalf("FAIL: real jsonconf decoder rejected the payload: %v", err)
	}
	t.Log("PASS: decoded by the real jsonconf.Configuration model")

	if conf.SDKConfig == nil {
		t.Fatal("FAIL: payload has no sdk_config block")
	}
	if len(conf.SDKConfig.Config) == 0 {
		t.Fatal("FAIL: sdk_config.config decoded to an empty map")
	}

	keys := make([]string, 0, len(conf.SDKConfig.Config))
	for k := range conf.SDKConfig.Config {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	t.Logf("decoded %d setting(s):", len(keys))
	for _, k := range keys {
		t.Logf("    %s = %q", k, conf.SDKConfig.Config[k])
	}

	// 2. Per-key verdict from the real allowlist/denylist.
	blocked := false
	for _, k := range keys {
		allowed, reason := sdkconfigsecurity.IsAllowed(k)
		if allowed {
			t.Logf("PASS: IsAllowed(%q) = true", k)
			continue
		}
		blocked = true
		t.Errorf("FAIL: IsAllowed(%q) = false  reason=%s", k, reason)
	}

	// 3. The two real validation entry points rc-api calls.
	if err := sdkconfigsecurity.NormalizeAndValidateCanonical(conf.SDKConfig); err != nil {
		blocked = true
		t.Errorf("FAIL: NormalizeAndValidateCanonical: %v", err)
	} else {
		t.Log("PASS: NormalizeAndValidateCanonical")
	}

	if err := sdkconfigsecurity.ValidateStored(conf.SDKConfig); err != nil {
		blocked = true
		t.Errorf("FAIL: ValidateStored: %v", err)
	} else {
		t.Log("PASS: ValidateStored")
	}

	// 4. Re-encode, showing the canonical form the backend would actually store and emit.
	//    Post-#14029 there is no MarshalJSON override, so writes always emit the object form.
	canonical, err := json.MarshalIndent(conf.SDKConfig, "", "  ")
	if err != nil {
		t.Fatalf("re-encoding: %v", err)
	}
	t.Logf("canonical sdk_config as the backend would emit it:\n%s", canonical)

	if blocked {
		t.Fatal("preflight FAILED: the real backend would reject this payload")
	}
	t.Log("preflight OK: the real backend accepts this payload")
}
