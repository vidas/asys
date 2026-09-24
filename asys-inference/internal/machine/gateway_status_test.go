package machine

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestGatewayFailureStatusRendering(t *testing.T) {
	var status GatewayStatus
	if err := json.Unmarshal([]byte(`{"name":"gateway","recent_failures":[{"timestamp":"2026-09-24T12:00:00Z","model":"work/model-a","failure":{"request_id":"request-123","type":"context_overflow","message":"Your input exceeds the context window"}}]}`), &status); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := printGatewayStatuses(&out, []GatewayStatus{status}); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"Gateway gateway diagnostics", "work/model-a", "2026-09-24T12:00:00Z", "request-123", "context_overflow", "Your input exceeds the context window"} {
		if !strings.Contains(out.String(), expected) {
			t.Errorf("missing %q in %s", expected, out.String())
		}
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"recent_failures"`) || !strings.Contains(string(encoded), `"request_id":"request-123"`) {
		t.Fatalf("lost failure diagnostics: %s", encoded)
	}
}

func TestUnavailableGatewayStatus(t *testing.T) {
	var out bytes.Buffer
	if err := printGatewayStatuses(&out, []GatewayStatus{{Name: "old", Error: "Gateway status unavailable"}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "unavailable") {
		t.Fatal(out.String())
	}
}
