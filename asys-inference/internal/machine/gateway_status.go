package machine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

type InferenceFailure struct {
	Timestamp string `json:"timestamp"`
	Model     string `json:"model"`
	Outcome   string `json:"outcome"`
	Failure   struct {
		RequestID  string `json:"request_id"`
		Type       string `json:"type"`
		Message    string `json:"message"`
		HTTPStatus int    `json:"http_status,omitempty"`
	} `json:"failure"`
}
type GatewayStatus struct {
	Name           string             `json:"name"`
	RecentFailures []InferenceFailure `json:"recent_failures,omitempty"`
	Error          string             `json:"error,omitempty"`
}

// Historical failure diagnostics must not turn an otherwise serving provider
// network into a failed health check.
func (cli CLI) gatewayStatuses(ctx context.Context, runtime *Runtime, document *Document) []GatewayStatus {
	var results []GatewayStatus
	for _, provider := range document.Config.Providers {
		defaults, err := document.Config.loadRuntimeDefaults(provider)
		if err != nil || defaults.HostChannel != "gateway" {
			continue
		}
		result := GatewayStatus{Name: provider.Name}
		func() {
			lock, exists, err := runtime.Controller.State.AcquireShared(ctx, document.Config.System)
			if err != nil || !exists {
				result.Error = "Gateway is not running"
				return
			}
			defer lock.Close()
			root, err := gatewayRoot(ctx, runtime, document, provider.Name)
			if err != nil {
				result.Error = err.Error()
				return
			}
			requestCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			defer cancel()
			var output, errors bytes.Buffer
			client := cli
			client.Out, client.Err = &output, &errors
			if err = client.requestGateway(requestCtx, root, "status", map[string]any{}); err != nil {
				result.Error = "Gateway status unavailable (older gateway, interrupted request, or timeout)"
				return
			}
			if err = json.Unmarshal(output.Bytes(), &result); err != nil {
				result.Error = "Invalid gateway status response"
			}
		}()
		results = append(results, result)
	}
	return results
}

func printGatewayStatuses(out io.Writer, gateways []GatewayStatus) error {
	for _, gateway := range gateways {
		fmt.Fprintf(out, "\nGateway %s diagnostics\n", gateway.Name)
		if gateway.Error != "" {
			fmt.Fprintln(out, gateway.Error)
			continue
		}
		if len(gateway.RecentFailures) == 0 {
			fmt.Fprintln(out, "No inference failures recorded since gateway startup.")
		}
		for _, failure := range gateway.RecentFailures {
			fmt.Fprintf(out, "Last failure for %s at %s: %s: %s (request %s)\n", failure.Model, failure.Timestamp, failure.Failure.Type, failure.Failure.Message, failure.Failure.RequestID)
		}
	}
	return nil
}
