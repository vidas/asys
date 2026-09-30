package machine

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/glguida/dcomp/engine"
	"github.com/glguida/dcomp/lifecycle"
)

type imageEngine struct {
	engine.Engine
	image engine.Image
	refs  []string
}

func (e *imageEngine) ResolveImage(_ context.Context, ref string) (engine.Image, error) {
	e.refs = append(e.refs, ref)
	return e.image, nil
}

func TestPrepareRefreshesExistingProviderImages(t *testing.T) {
	for _, build := range []bool{false, true} {
		name := "declared image"
		if build {
			name = "source build"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			source := filepath.Join(root, "custom")
			if err := os.Mkdir(source, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(source, "component.dcomp"), []byte("docker provider:current\noutput "+Service+" provider\n"), 0600); err != nil {
				t.Fatal(err)
			}
			if build {
				if err := os.WriteFile(filepath.Join(source, "Dockerfile"), []byte("FROM asys-runtime\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			document, err := NewDocument(Config{System: "test", Prefix: "providers", Running: true,
				ComponentsRoot: root, DCompRoot: filepath.Join(root, "dcomp"), RuntimeRoot: filepath.Join(root, "run"),
				Endpoint: "custom.provider", Providers: []Provider{{Name: "custom", Source: "custom"}}})
			if err != nil {
				t.Fatal(err)
			}
			e := &imageEngine{image: engine.Image{ID: "sha256:first", HasHealthcheck: true}}
			builds := 0
			runtime := Runtime{Store: Store{Root: root}, Report: io.Discard, Controller: &lifecycle.Controller{Engine: e},
				Build: func(_ context.Context, gotSource, gotContext, tag string) error {
					builds++
					if gotSource != source || gotContext != root || tag == "" {
						t.Fatalf("incorrect build inputs: %s %s %s", gotSource, gotContext, tag)
					}
					return nil
				}}
			first, err := runtime.Prepare(context.Background(), document)
			if err != nil {
				t.Fatal(err)
			}
			document.Applied = &first
			e.image.ID = "sha256:updated"
			second, err := runtime.Prepare(context.Background(), document)
			if err != nil {
				t.Fatal(err)
			}
			if first.Components[0].Component.Image != "sha256:first" || second.Components[0].Component.Image != "sha256:updated" {
				t.Fatal("reused the saved provider image instead of resolving its source again")
			}
			if len(e.refs) != 2 || e.refs[0] != e.refs[1] || (build && builds != 2) || (!build && (builds != 0 || e.refs[1] != "provider:current")) {
				t.Fatalf("incorrect image refresh: builds=%d refs=%v", builds, e.refs)
			}
		})
	}
}
