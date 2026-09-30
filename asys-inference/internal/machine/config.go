// Package machine manages a provider network contributed to a shared dcomp system.
package machine

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/glguida/dcomp/composition"
)

const Service = "cyclo.provider.v1.Provider"
const GlobalName = "inference_endpoint"
const Version = "0.2.1"

type Provider struct {
	Name    string              `json:"name"`
	Source  string              `json:"source"`
	Context string              `json:"context,omitempty"`
	NoBuild bool                `json:"no_build,omitempty"`
	Runtime composition.Runtime `json:"runtime"`
	Links   map[string]string   `json:"links"`
}

type Config struct {
	System         string     `json:"system"`
	DCompRoot      string     `json:"dcomp_state_root"`
	RuntimeRoot    string     `json:"runtime_root"`
	ComponentsRoot string     `json:"components_root"`
	Prefix         string     `json:"prefix"`
	Running        bool       `json:"running"`
	Endpoint       string     `json:"endpoint"`
	Providers      []Provider `json:"providers"`
}

// Bundle is only this machine's contribution, never a whole-system snapshot.
type Bundle struct {
	Components []composition.Instance `json:"components"`
	Links      []composition.Link     `json:"links"`
	Global     composition.Global     `json:"global"`
}

type Pending struct {
	Digest   string `json:"digest"`
	Revision uint64 `json:"revision"`
	Bundle   Bundle `json:"bundle"`
}

type Document struct {
	Version         int      `json:"version"`
	ID              string   `json:"id"`
	Revision        uint64   `json:"revision"`
	AppliedRevision uint64   `json:"applied_revision"`
	Config          Config   `json:"config"`
	Applied         *Bundle  `json:"applied,omitempty"`
	Pending         *Pending `json:"pending,omitempty"`
}

func NewDocument(config Config) (*Document, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return nil, err
	}
	return &Document{Version: 1, ID: hex.EncodeToString(data), Revision: 1, Config: config}, nil
}

func (config Config) Physical(name string) string { return config.Prefix + "-" + name }

func isNamedSource(source string) bool {
	return source != "" && source != "." && source != ".." && !strings.ContainsRune(source, filepath.Separator)
}

func (config Config) Source(provider Provider) (string, string, error) {
	source := provider.Source
	context := provider.Context
	if isNamedSource(source) {
		source = filepath.Join(config.ComponentsRoot, source)
		if context == "" {
			context = config.ComponentsRoot
		}
	}
	if !filepath.IsAbs(source) {
		return "", "", fmt.Errorf("stored source must be absolute: %s", source)
	}
	if context == "" {
		context = source
	}
	relative, err := filepath.Rel(context, source)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("build context must contain provider source %s", source)
	}
	return source, context, nil
}

// RuntimeDefaults belongs to the component, independent of its directory name.
// The defaults are copied into machine state when the component is added.
func (config Config) RuntimeDefaults(provider Provider) (composition.Runtime, error) {
	defaults, err := config.loadRuntimeDefaults(provider)
	return defaults.Runtime, err
}

type runtimeDefaults struct {
	composition.Runtime
	HostChannel string `json:"host_channel,omitempty"`
}

func (config Config) loadRuntimeDefaults(provider Provider) (runtimeDefaults, error) {
	source, _, err := config.Source(provider)
	if err != nil {
		return runtimeDefaults{}, err
	}
	file, err := os.Open(filepath.Join(source, "runtime.json"))
	if errors.Is(err, os.ErrNotExist) {
		return runtimeDefaults{}, nil
	}
	if err != nil {
		return runtimeDefaults{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var runtime runtimeDefaults
	if err = decoder.Decode(&runtime); err != nil {
		return runtime, fmt.Errorf("read %s/runtime.json: %w", source, err)
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return runtime, fmt.Errorf("%s/runtime.json contains trailing data", source)
	}
	return runtime, nil
}

func (config Config) Definition(provider Provider) (composition.Component, error) {
	source, _, err := config.Source(provider)
	if err != nil {
		return composition.Component{}, err
	}
	return composition.LoadComponent(source)
}

func ProviderOutput(component composition.Component) (string, error) {
	output := ""
	for _, ep := range component.Definition.Outputs {
		if ep.Service == Service {
			if output != "" {
				return "", fmt.Errorf("provider must expose exactly one %s output", Service)
			}
			output = ep.Name
		}
	}
	if output == "" {
		return "", fmt.Errorf("provider must expose one %s output", Service)
	}
	return output, nil
}

func (config Config) Validate() error {
	if !composition.ValidName(config.System) || !composition.ValidName(config.Prefix) {
		return fmt.Errorf("invalid system name or component prefix")
	}
	for _, p := range []string{config.DCompRoot, config.RuntimeRoot, config.ComponentsRoot} {
		if !filepath.IsAbs(p) || filepath.Clean(p) != p {
			return fmt.Errorf("configuration root must be an absolute clean path: %s", p)
		}
	}
	spec := composition.Spec{Name: config.System}
	names := map[string]composition.Component{}
	for _, p := range config.Providers {
		if !composition.ValidName(p.Name) || !composition.ValidName(config.Physical(p.Name)) {
			return fmt.Errorf("invalid or too long provider name: %s", p.Name)
		}
		if _, exists := names[p.Name]; exists {
			return fmt.Errorf("provider already exists: %s", p.Name)
		}
		component, err := config.Definition(p)
		if err != nil {
			return fmt.Errorf("%s: %w", p.Name, err)
		}
		if _, err = ProviderOutput(component); err != nil {
			return fmt.Errorf("%s: %w", p.Name, err)
		}
		names[p.Name] = component
		spec.Components = append(spec.Components, composition.Instance{Name: p.Name, Component: component, Runtime: p.Runtime})
	}
	for _, p := range config.Providers {
		for input, target := range p.Links {
			ref, err := composition.ParseTarget(target)
			if err != nil {
				return err
			}
			if ref.Global != "" {
				// External globals are checked against live state under dcomp's lock.
				endpoint, exists := names[p.Name].Definition.Input(input)
				if !exists {
					return fmt.Errorf("unknown input %s.%s", p.Name, input)
				}
				found := false
				for _, g := range spec.Globals {
					if g.Name == ref.Global {
						if g.Service != endpoint.Service {
							return fmt.Errorf("conflicting service types for @%s", g.Name)
						}
						found = true
					}
				}
				if !found {
					spec.Globals = append(spec.Globals, composition.Global{Name: ref.Global, Service: endpoint.Service})
				}
			}
			spec.Links = append(spec.Links, composition.Link{Input: composition.EndpointRef{Component: p.Name, Endpoint: input}, Output: ref})
		}
	}
	if err := composition.Validate(spec); err != nil {
		return err
	}
	if config.Endpoint != "" {
		ref, err := composition.ParseEndpointRef(config.Endpoint)
		if err != nil {
			return err
		}
		c, exists := names[ref.Component]
		if !exists {
			return fmt.Errorf("selected provider %s does not exist", ref.Component)
		}
		ep, exists := c.Definition.Output(ref.Endpoint)
		if !exists || ep.Service != Service {
			return fmt.Errorf("selected endpoint must provide %s", Service)
		}
	}
	return nil
}

func CanonicalSource(source, context string) (string, string, error) {
	if context != "" {
		var err error
		context, err = filepath.Abs(context)
		if err == nil {
			context, err = filepath.EvalSymlinks(context)
		}
		if err != nil {
			return "", "", err
		}
	}
	if isNamedSource(source) {
		return source, context, nil
	}
	absolute, err := filepath.Abs(source)
	if err != nil {
		return "", "", err
	}
	absolute, err = filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", "", err
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		if filepath.Base(absolute) != "component.dcomp" {
			return "", "", fmt.Errorf("source must be a component directory or component.dcomp")
		}
		absolute = filepath.Dir(absolute)
	}
	return absolute, context, err
}

func (config *Config) Select(value string) error {
	if value == "-" {
		config.Endpoint = ""
		return nil
	}
	if strings.Contains(value, ".") {
		config.Endpoint = value
		return nil
	}
	for _, p := range config.Providers {
		if p.Name == value {
			c, err := config.Definition(p)
			if err != nil {
				return err
			}
			output, err := ProviderOutput(c)
			if err != nil {
				return err
			}
			config.Endpoint = value + "." + output
			return nil
		}
	}
	return fmt.Errorf("unknown provider %s", value)
}

func (config Config) Names() []string {
	names := []string{}
	for _, p := range config.Providers {
		names = append(names, p.Name)
	}
	sort.Strings(names)
	return names
}
