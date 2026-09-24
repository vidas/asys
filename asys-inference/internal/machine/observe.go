package machine

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"text/tabwriter"
	"time"

	"github.com/glguida/dcomp/composition"
	"github.com/glguida/dcomp/engine"
	"github.com/glguida/dcomp/lifecycle"
	"golang.org/x/sys/unix"
)

type ComponentObservation struct {
	Name        string `json:"name"`
	Source      string `json:"source"`
	Component   string `json:"component"`
	ContainerID string `json:"container_id"`
	State       string `json:"state"`
	Health      string `json:"health"`
	ExitCode    int    `json:"exit_code"`
	Problem     string `json:"problem,omitempty"`
}

type Observation struct {
	System             string                 `json:"system"`
	Revision           uint64                 `json:"revision"`
	AppliedRevision    uint64                 `json:"applied_revision"`
	Running            bool                   `json:"running"`
	Operational        bool                   `json:"operational"`
	Serving            bool                   `json:"serving"`
	ConfiguredEndpoint string                 `json:"configured_endpoint"`
	Global             composition.Global     `json:"global"`
	Components         []ComponentObservation `json:"components"`
	Gateways           []GatewayStatus        `json:"gateways,omitempty"`
	Operation          string                 `json:"operation,omitempty"`
	Phase              string                 `json:"phase,omitempty"`
}

func Observe(document *Document, status lifecycle.Status) Observation {
	config := document.Config
	result := Observation{System: config.System, Revision: document.Revision, AppliedRevision: document.AppliedRevision, Running: config.Running, ConfiguredEndpoint: config.Endpoint, Components: []ComponentObservation{}, Global: composition.Global{Name: GlobalName, Service: Service}, Operation: status.Operation, Phase: status.Phase}
	if status.Spec != nil {
		for _, g := range status.Spec.Globals {
			if g.Name == GlobalName {
				result.Global = g
			}
		}
	}
	required := requiredProviders(config, status)
	healthy := config.Running && config.Endpoint != "" && document.Revision == document.AppliedRevision && document.Pending == nil && status.Desired && status.Proxy.Ready && status.Proxy.Problem == "" && status.Operation == ""
	for _, p := range config.Providers {
		item := ComponentObservation{Name: p.Name, Source: p.Source, Component: config.Physical(p.Name), State: "absent"}
		for _, c := range status.Components {
			if c.Name == item.Component {
				item.ContainerID = c.ID
				item.State = c.Status
				item.Health = string(c.Health)
				item.ExitCode = c.ExitCode
				item.Problem = c.Problem
			}
		}
		result.Components = append(result.Components, item)
		if _, needed := required[item.Component]; needed && (item.State != "running" || item.Health != "healthy" || item.Problem != "") {
			healthy = false
		}
	}
	target, err := composition.ParseEndpointRef(config.Endpoint)
	if err != nil {
		healthy = false
	} else {
		target.Component = config.Physical(target.Component)
		if result.Global.Service != Service || result.Global.Target != target {
			healthy = false
		}
	}
	result.Operational = healthy
	servingConfig := config
	servingConfig.Endpoint = ""
	for _, provider := range config.Providers {
		if config.Physical(provider.Name) == result.Global.Target.Component {
			servingConfig.Endpoint = provider.Name + "." + result.Global.Target.Endpoint
		}
	}
	serving := requiredProviders(servingConfig, status)
	result.Serving = len(serving) > 0 && result.Global.Service == Service && status.Desired && status.Proxy.Ready && status.Proxy.Problem == "" && status.Operation == ""
	for _, item := range result.Components {
		if _, needed := serving[item.Component]; needed && (item.State != "running" || item.Health != "healthy" || item.Problem != "") {
			result.Serving = false
		}
	}
	return result
}

func (cli CLI) status(ctx context.Context, runtime *Runtime, document *Document, args []string) error {
	flags := cli.flags("status")
	jsonOutput := flags.Bool("json", false, "JSON status")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return usage("status takes no arguments")
	}
	status, err := runtime.Controller.Status(ctx, document.Config.System)
	if err != nil {
		return err
	}
	result := Observe(document, status)
	result.Gateways = cli.gatewayStatuses(ctx, runtime, document)
	if *jsonOutput {
		if err = writeJSON(cli.Out, result); err != nil {
			return err
		}
	} else {
		fmt.Fprintf(cli.Out, "Provider network in dcomp system %s\n", result.System)
		endpoint := result.Global.Target.String()
		state := "not ready"
		if result.Serving {
			state = "serving"
		}
		if result.Global.Target == (composition.EndpointRef{}) {
			endpoint = "unbound"
		}
		if !result.Running && endpoint == "unbound" {
			state = "stopped"
		}
		fmt.Fprintf(cli.Out, "@%s -> %s (%s)\n", GlobalName, endpoint, state)
		if !result.Operational && result.Running && result.ConfiguredEndpoint != "" {
			fmt.Fprintf(cli.Out, "Requested output: %s (not ready)\n", result.ConfiguredEndpoint)
		}
		writer := tabwriter.NewWriter(cli.Out, 0, 4, 2, ' ', 0)
		fmt.Fprintln(writer, "PROVIDER\tSOURCE\tDCOMP COMPONENT\tSTATE\tHEALTH\tDETAILS")
		for _, c := range result.Components {
			detail := c.Problem
			if c.State == "exited" || c.State == "dead" {
				detail = fmt.Sprintf("exit code %d", c.ExitCode)
				if c.Problem != "" {
					detail += "; " + c.Problem
				}
			}
			fmt.Fprintf(writer, "%s\t%s\t%s\t%s\t%s\t%s\n", c.Name, c.Source, c.Component, c.State, c.Health, detail)
		}
		if err := writer.Flush(); err != nil {
			return err
		}
	}
	if !*jsonOutput {
		if err := printGatewayStatuses(cli.Out, result.Gateways); err != nil {
			return err
		}
	}
	if !result.Operational {
		return fmt.Errorf("inference endpoint is not operational")
	}
	return nil
}

func gatewayRoot(ctx context.Context, runtime *Runtime, document *Document, name string) (string, error) {
	return providerRoot(ctx, runtime, document, name, "gateway")
}

func providerRoot(ctx context.Context, runtime *Runtime, document *Document, name, channel string) (string, error) {
	valid := false
	for _, p := range document.Config.Providers {
		if p.Name == name {
			valid = true
		}
	}
	if !valid {
		return "", fmt.Errorf("%s is not a configured provider", name)
	}
	status, err := runtime.Controller.Status(ctx, document.Config.System)
	if err != nil {
		return "", err
	}
	if !status.Desired || status.Operation != "" || !status.Proxy.Ready || status.Proxy.Problem != "" {
		return "", fmt.Errorf("provider runtime is not ready; run start")
	}
	if document.Applied == nil {
		return "", fmt.Errorf("provider has not been applied")
	}
	physical := document.Config.Physical(name)
	var recorded *composition.Instance
	for _, c := range document.Applied.Components {
		if c.Name == physical {
			copy := c
			recorded = &copy
		}
	}
	if recorded == nil || status.Spec == nil {
		return "", fmt.Errorf("provider %s is not owned by this machine", name)
	}
	matched := false
	for _, c := range status.Spec.Authored().Components {
		if c.Name == physical {
			matched = sameComponent(c, *recorded)
		}
	}
	if !matched {
		return "", fmt.Errorf("provider %s configuration changed outside this machine", name)
	}
	for _, c := range status.Components {
		if c.Name == physical {
			if c.Status != "running" || c.Health != engine.HealthHealthy || c.Problem != "" {
				return "", fmt.Errorf("provider %s is not healthy: %s %s %s", name, c.Status, c.Health, c.Problem)
			}
			for _, bind := range recorded.Runtime.Binds {
				if bind.Target == hostRootTarget && !bind.ReadOnly {
					if info, err := os.Stat(filepath.Join(bind.Source, "channels", channel)); err == nil && info.IsDir() {
						return bind.Source, nil
					}
				}
			}
		}
	}
	return "", fmt.Errorf("provider %s has no %s host channel; run start to update it", name, channel)
}

func (cli CLI) gateway(ctx context.Context, runtime *Runtime, document *Document, args []string) error {
	flags := cli.flags("gateway")
	name := flags.String("name", "gateway", "gateway provider instance")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() == 0 {
		return usage("gateway requires providers, models, usage, login, logout, or rename")
	}
	command := flags.Arg(0)
	args = flags.Args()[1:]
	if command == "login" {
		return cli.login(ctx, runtime, document, *name, args)
	}
	var body any = map[string]any{}
	switch command {
	case "providers", "models", "usage":
		if len(args) != 0 {
			return usage(command + " takes no arguments")
		}
	case "logout":
		if len(args) != 1 {
			return usage("logout requires ACCOUNT")
		}
		body = map[string]string{"account": args[0]}
	case "rename":
		if len(args) != 2 {
			return usage("rename requires ACCOUNT NEW_ACCOUNT")
		}
		body = map[string]string{"account": args[0], "new_account": args[1]}
	default:
		return usage("unknown gateway command " + command)
	}
	// Pin the observed deployment until its request has finished.
	lock, exists, err := runtime.Controller.State.AcquireShared(ctx, document.Config.System)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("gateway is absent")
	}
	defer lock.Close()
	root, err := gatewayRoot(ctx, runtime, document, *name)
	if err != nil {
		return err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return cli.requestGateway(requestCtx, root, command, body)
}

func (cli CLI) login(ctx context.Context, runtime *Runtime, document *Document, name string, args []string) error {
	flags := cli.flags("gateway login")
	account := flags.String("as", "", "account name")
	authentication := flags.String("authentication", "auto", "auto, oauth, or api_key")
	keyStdin := flags.Bool("api-key-stdin", false, "read API key from stdin")
	keyEnv := flags.String("api-key-env", "", "read API key from this host environment variable")
	noninteractive := flags.Bool("non-interactive", false, "disable interactive prompts")
	if err := parseOptions(flags, args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return usage("gateway login PROVIDER [OPTIONS]")
	}
	if *authentication != "auto" && *authentication != "oauth" && *authentication != "api_key" {
		return usage("invalid authentication method")
	}
	interactive := false
	if file, ok := cli.In.(*os.File); ok {
		_, err := unix.IoctlGetTermios(int(file.Fd()), unix.TCGETS)
		interactive = err == nil
	}
	if *keyStdin && *keyEnv != "" {
		return usage("select only one API-key input source")
	}
	if *keyStdin || *keyEnv != "" {
		if *authentication == "oauth" {
			return usage("API-key input cannot be used for OAuth")
		}
		*authentication = "api_key"
		interactive = false
	}
	var options []string
	if *keyEnv != "" {
		value, ok := os.LookupEnv(*keyEnv)
		if !ok || value == "" {
			return fmt.Errorf("API-key environment variable is empty")
		}
		options = append(options, "--api-key-env", *keyEnv)
	}
	if *noninteractive {
		interactive = false
	}
	lock, exists, err := runtime.Controller.State.AcquireShared(ctx, document.Config.System)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("gateway is absent")
	}
	defer lock.Close()
	root, err := gatewayRoot(ctx, runtime, document, name)
	if err != nil {
		return err
	}
	return cli.requestGateway(ctx, root, "login", map[string]any{"provider": flags.Arg(0), "account": *account, "authentication": *authentication, "interactive": interactive, "api_key_input": *keyStdin || *keyEnv != ""}, options...)
}
