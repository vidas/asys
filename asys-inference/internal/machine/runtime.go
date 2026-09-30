package machine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/glguida/dcomp/composition"
	"github.com/glguida/dcomp/dockerengine"
	"github.com/glguida/dcomp/lifecycle"
	"github.com/glguida/dcomp/proxy"
	"github.com/glguida/dcomp/state"
)

type Runtime struct {
	Store      Store
	Controller *lifecycle.Controller
	Build      func(context.Context, string, string, string) error
	Report     io.Writer
}

func NewRuntime(store Store, config Config, report io.Writer) (*Runtime, error) {
	if report == nil {
		report = io.Discard
	}
	docker, err := dockerengine.NewFromEnvironment()
	if err != nil {
		return nil, err
	}
	manager := &proxy.ProcessManager{}
	if os.Getenv("DCOMP_PROXY_BINARY") == "" {
		if installed, err := exec.LookPath("dcomp-proxy"); err == nil {
			manager.Binary, _ = filepath.Abs(installed)
		} else {
			return nil, fmt.Errorf("dcomp-proxy is required; install dcomp 0.3.2 or set DCOMP_PROXY_BINARY: %w", err)
		}
	}
	controller := &lifecycle.Controller{Engine: docker, Proxy: manager, State: state.Store{Root: config.DCompRoot}, RuntimeRoot: config.RuntimeRoot,
		Report: func(message string) { fmt.Fprintln(report, message) }}
	runtime := &Runtime{Store: store, Controller: controller, Report: report}
	runtime.Build = func(ctx context.Context, source, buildContext, tag string) error {
		command := exec.CommandContext(ctx, "docker", "build", "--tag", tag, "--file", filepath.Join(source, "Dockerfile"),
			"--label", "org.opencontainers.image.version="+Version, "--label", "io.asys.build="+Build, buildContext)
		// Force the same local engine as the dcomp library, ignoring Docker contexts.
		host := os.Getenv("DOCKER_HOST")
		if host == "" {
			host = "unix:///var/run/docker.sock"
		}
		command.Env = append(os.Environ(), "DOCKER_HOST="+host)
		command.Stdout = report
		command.Stderr = report
		if err := command.Run(); err != nil {
			return fmt.Errorf("build %s: %w", source, err)
		}
		return nil
	}
	return runtime, nil
}

func (runtime *Runtime) Prepare(ctx context.Context, document *Document) (Bundle, error) {
	config := document.Config
	bundle := Bundle{Components: []composition.Instance{}, Links: []composition.Link{}, Global: composition.Global{Name: GlobalName, Service: Service}}
	if !config.Running {
		return bundle, nil
	}
	if err := config.Validate(); err != nil {
		return Bundle{}, err
	}
	for _, provider := range config.Providers {
		preparedRuntime, err := runtime.hostRuntime(config, provider)
		if err != nil {
			return Bundle{}, err
		}
		provider.Runtime = preparedRuntime
		source, buildContext, err := config.Source(provider)
		if err != nil {
			return Bundle{}, err
		}
		component, err := config.Definition(provider)
		if err != nil {
			return Bundle{}, err
		}
		dockerfile, err := os.Stat(filepath.Join(source, "Dockerfile"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return Bundle{}, err
		}
		if !provider.NoBuild && err == nil && !dockerfile.IsDir() {
			tag := "asys-inference-" + document.ID + "-" + provider.Name + ":current"
			if err = runtime.Build(ctx, source, buildContext, tag); err != nil {
				return Bundle{}, err
			}
			component.Image = tag
		}
		inspectCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		image, err := runtime.Controller.Engine.ResolveImage(inspectCtx, component.Image)
		cancel()
		if err != nil {
			return Bundle{}, fmt.Errorf("resolve %s: %w", provider.Name, err)
		}
		// Validate the full image/mount contract before creating a runtime operation.
		single := composition.Spec{Name: config.System, Components: []composition.Instance{{Name: config.Physical(provider.Name), Component: component, Runtime: provider.Runtime}}}
		_, err = composition.Resolve(single, map[string]composition.ResolvedImage{config.Physical(provider.Name): {ID: image.ID, HasHealthcheck: image.HasHealthcheck, DeclaredVolumes: image.DeclaredVolumes}})
		if err != nil {
			return Bundle{}, err
		}
		component.Image = image.ID
		bundle.Components = append(bundle.Components, composition.Instance{Name: config.Physical(provider.Name), Component: component, Runtime: provider.Runtime})
		inputs := make([]string, 0, len(provider.Links))
		for name := range provider.Links {
			inputs = append(inputs, name)
		}
		sort.Strings(inputs)
		for _, input := range inputs {
			target, err := composition.ParseTarget(provider.Links[input])
			if err != nil {
				return Bundle{}, err
			}
			if target.Global == "" {
				target.Component = config.Physical(target.Component)
			}
			bundle.Links = append(bundle.Links, composition.Link{Input: composition.EndpointRef{Component: config.Physical(provider.Name), Endpoint: input}, Output: target})
		}
	}
	if config.Endpoint != "" {
		target, err := composition.ParseEndpointRef(config.Endpoint)
		if err != nil {
			return Bundle{}, err
		}
		target.Component = config.Physical(target.Component)
		bundle.Global.Target = target
	}
	sort.Slice(bundle.Components, func(i, j int) bool { return bundle.Components[i].Name < bundle.Components[j].Name })
	return bundle, nil
}

// Merge runs inside Controller.Edit's exclusive dcomp lock. External inputs and
// globals survive, except references to outputs actually removed from the system.
func Merge(current *composition.Spec, previous *Bundle, target Bundle) error {
	if err := checkOwnership(*current, previous, target); err != nil {
		return err
	}
	owned := map[string]bool{}
	if previous != nil {
		for _, component := range previous.Components {
			owned[component.Name] = true
		}
	}
	for _, component := range target.Components {
		owned[component.Name] = true
	}
	components := []composition.Instance{}
	for _, component := range current.Components {
		if !owned[component.Name] {
			components = append(components, component)
		}
	}
	components = append(components, target.Components...)
	outputs := map[composition.EndpointRef]bool{}
	for _, c := range components {
		for _, ep := range c.Component.Definition.Outputs {
			outputs[composition.EndpointRef{Component: c.Name, Endpoint: ep.Name}] = true
		}
	}
	links := []composition.Link{}
	for _, link := range current.Links {
		if owned[link.Input.Component] {
			continue
		}
		if link.Output.Global == "" && owned[link.Output.Component] && !outputs[link.Output] {
			continue
		}
		links = append(links, link)
	}
	links = append(links, target.Links...)
	globals := []composition.Global{}
	for _, global := range current.Globals {
		if global.Name == GlobalName {
			continue
		}
		if owned[global.Target.Component] && !outputs[global.Target] {
			global.Target = composition.EndpointRef{}
		}
		globals = append(globals, global)
	}
	globals = append(globals, target.Global)
	current.Components = components
	current.Links = links
	current.Globals = globals
	return composition.Validate(*current)
}

func sameComponent(a, b composition.Instance) bool {
	// Resolve normalizes slices and runtime policy exactly as dcomp does.
	spec := func(c composition.Instance) composition.ResolvedSpec {
		result, _ := composition.Resolve(composition.Spec{Name: "compare", Components: []composition.Instance{c}}, map[string]composition.ResolvedImage{c.Name: {ID: c.Component.Image, HasHealthcheck: true}})
		return result
	}
	return spec(a).Digest != "" && spec(a).Digest == spec(b).Digest
}

func checkOwnership(current composition.Spec, previous *Bundle, target Bundle) error {
	owned := map[string]composition.Instance{}
	if previous != nil {
		for _, c := range previous.Components {
			owned[c.Name] = c
		}
	}
	adding := map[string]bool{}
	for _, c := range target.Components {
		adding[c.Name] = true
	}
	for _, c := range current.Components {
		if old, exists := owned[c.Name]; exists {
			if !sameComponent(c, old) {
				return fmt.Errorf("owned component %s was changed outside this machine; refusing to overwrite it", c.Name)
			}
		} else if adding[c.Name] {
			return fmt.Errorf("component %s already belongs to another contributor", c.Name)
		}
	}
	for _, global := range current.Globals {
		if global.Name != GlobalName {
			continue
		}
		if global.Service != Service {
			return fmt.Errorf("@%s has incompatible service %s", GlobalName, global.Service)
		}
		if global.Target == (composition.EndpointRef{}) {
			continue
		}
		if previous == nil || global.Target != previous.Global.Target {
			return fmt.Errorf("@%s is assigned outside this machine", GlobalName)
		}
	}
	return nil
}

func matches(current composition.Spec, target Bundle, previous *Bundle) bool {
	indexed := map[string]composition.Instance{}
	for _, c := range current.Components {
		indexed[c.Name] = c
	}
	wanted := map[string]bool{}
	for _, c := range target.Components {
		wanted[c.Name] = true
		actual, ok := indexed[c.Name]
		if !ok || !sameComponent(c, actual) {
			return false
		}
	}
	if previous != nil {
		for _, c := range previous.Components {
			if !wanted[c.Name] {
				if _, ok := indexed[c.Name]; ok {
					return false
				}
			}
		}
	}
	for _, g := range current.Globals {
		if g.Name == GlobalName && g == target.Global {
			actual := map[string]string{}
			for _, link := range current.Links {
				if wanted[link.Input.Component] {
					actual[link.Input.String()] = link.Output.String()
				}
			}
			expected := map[string]string{}
			for _, link := range target.Links {
				expected[link.Input.String()] = link.Output.String()
			}
			return reflect.DeepEqual(actual, expected)
		}
	}
	return false
}

func wiringDigest(spec composition.Spec) (string, error) {
	images := map[string]composition.ResolvedImage{}
	for _, c := range spec.Components {
		if !strings.HasPrefix(c.Component.Image, "sha256:") {
			return "", fmt.Errorf("unresolved image for %s", c.Name)
		}
		images[c.Name] = composition.ResolvedImage{ID: c.Component.Image, HasHealthcheck: true}
	}
	resolved, err := composition.Resolve(spec, images)
	return resolved.Digest, err
}

// Recover only resumes a dcomp apply whose exact target was journaled by this
// machine. A foreign pending operation is left to its owning program.
func (runtime *Runtime) Recover(ctx context.Context, document *Document) error {
	lock, err := runtime.Controller.State.AcquireContext(ctx, document.Config.System)
	if err != nil {
		return err
	}
	operation, pending, err := runtime.Controller.State.ReadOperation(document.Config.System)
	lock.Close()
	if err != nil {
		return err
	}
	if pending {
		if document.Pending == nil || operation.Kind != "apply" || operation.Target.Digest != document.Pending.Digest || operation.RuntimeRoot != document.Config.RuntimeRoot {
			return fmt.Errorf("dcomp system %s has another pending operation; its owner must resume or abort it", document.Config.System)
		}
		if err = runtime.Controller.Resume(ctx, document.Config.System); err != nil {
			return fmt.Errorf("resume inference update: %w", err)
		}
	}
	if document.Pending == nil {
		return nil
	}
	lock, err = runtime.Controller.State.AcquireContext(ctx, document.Config.System)
	if err != nil {
		return err
	}
	defer lock.Close()
	// A peer may have started an operation since our previous observation.
	if _, pending, err = runtime.Controller.State.ReadOperation(document.Config.System); err != nil {
		return err
	} else if pending {
		return fmt.Errorf("dcomp has a pending operation; retry the command")
	}
	deployed, exists, err := runtime.Controller.State.ReadDesired(document.Config.System)
	if err != nil {
		return err
	}
	if exists && matches(deployed.Spec.Authored(), document.Pending.Bundle, document.Applied) {
		document.Applied = &document.Pending.Bundle
		document.AppliedRevision = document.Pending.Revision
		document.Pending = nil
		return runtime.Store.Write(document)
	}
	if exists {
		if err = checkOwnership(deployed.Spec.Authored(), document.Applied, document.Pending.Bundle); err != nil {
			return fmt.Errorf("recover inference intent: %w", err)
		}
	}
	// No matching runtime target landed: retry from saved desired configuration.
	document.Pending = nil
	return runtime.Store.Write(document)
}

func (runtime *Runtime) Sync(ctx context.Context, document *Document) error {
	if err := runtime.Recover(ctx, document); err != nil {
		return err
	}
	target, err := runtime.Prepare(ctx, document)
	if err != nil {
		return err
	}
	if !document.Config.Running || target.Global.Target == (composition.EndpointRef{}) {
		return runtime.applyBundle(ctx, document, target, document.Revision)
	}
	// Make the provider available to its dependencies before publishing it.
	// Keep the previous public output while the new provider starts.
	staged := beforePublication(document.Applied, target)
	if err = runtime.applyBundle(ctx, document, staged, document.AppliedRevision); err != nil {
		return err
	}
	if err = runtime.waitReady(ctx, document.Config); err != nil {
		binding := staged.Global.Target.String()
		if staged.Global.Target == (composition.EndpointRef{}) {
			binding = "unbound"
		}
		return fmt.Errorf("%w\n@%s remains %s; the requested configuration is saved", err, GlobalName, binding)
	}
	if staged.Global != target.Global {
		return runtime.applyBundle(ctx, document, target, document.Revision)
	}
	document.AppliedRevision = document.Revision
	return runtime.Store.Write(document)
}

func beforePublication(previous *Bundle, target Bundle) Bundle {
	staged := target
	staged.Global.Target = composition.EndpointRef{}
	if previous != nil {
		for _, component := range target.Components {
			if component.Name == previous.Global.Target.Component {
				if output, exists := component.Component.Definition.Output(previous.Global.Target.Endpoint); exists && output.Service == Service {
					staged.Global = previous.Global
				}
			}
		}
	}
	return staged
}

func (runtime *Runtime) applyBundle(ctx context.Context, document *Document, target Bundle, appliedRevision uint64) error {
	err := runtime.Controller.Edit(ctx, document.Config.System, true, func(spec *composition.Spec) error {
		if err := Merge(spec, document.Applied, target); err != nil {
			return err
		}
		digest, err := wiringDigest(*spec)
		if err != nil {
			return err
		}
		document.Pending = &Pending{Digest: digest, Revision: appliedRevision, Bundle: target}
		return runtime.Store.Write(document)
	})
	if err != nil {
		return fmt.Errorf("desired revision %d is saved; the update remains incomplete: %w", document.Revision, err)
	}
	document.Applied = &target
	document.AppliedRevision = appliedRevision
	document.Pending = nil
	return runtime.Store.Write(document)
}

func Clone(document *Document) *Document {
	data, _ := json.Marshal(document)
	var copy Document
	_ = json.Unmarshal(data, &copy)
	return &copy
}
