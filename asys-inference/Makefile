include ../build.mk

GO ?= go
MACHINE := github.com/glguida/asys/asys-inference/internal/machine
PREFIX ?= $(HOME)/.local
GO_SOURCES := $(shell find cmd internal -name '*.go') go.mod go.sum
.PHONY: build test integration install prepare-runtime FORCE
prepare-runtime:
	install -d components/vendor/asys-runtime
	install -m 0644 ../asys-runtime/javascript/channel.mjs ../asys-runtime/javascript/queue.mjs ../asys-runtime/javascript/permissions.mjs components/vendor/asys-runtime/
	install -m 0644 ../LICENSE ../asys-runtime/LICENSE.multiagent components/vendor/asys-runtime/
build: prepare-runtime bin/asys-inference
# The stamp changes only with the build ID, so an unchanged tree skips Go.
bin/.build-id: FORCE
	@mkdir -p bin
	@echo '$(ASYS_BUILD)' | cmp -s - $@ || echo '$(ASYS_BUILD)' > $@
bin/asys-inference: $(GO_SOURCES) bin/.build-id
	CGO_ENABLED=0 $(GO) build -buildvcs=false -trimpath \
		-ldflags "-X $(MACHINE).Version=$(ASYS_VERSION) -X $(MACHINE).Build=$(ASYS_BUILD)" \
		-o bin/asys-inference ./cmd/asys-inference
test: prepare-runtime
	$(GO) test ./...
integration: build
	tools/integration-test
install:
	@test -x bin/asys-inference || { echo "asys-inference is not built; run make first." >&2; exit 1; }
	install -d "$(DESTDIR)$(PREFIX)/bin" "$(DESTDIR)$(PREFIX)/share/asys-inference/components"
	install -m 0755 bin/asys-inference "$(DESTDIR)$(PREFIX)/bin/"
	tar --exclude=node_modules --exclude=__pycache__ -C components -cf - . | tar -C "$(DESTDIR)$(PREFIX)/share/asys-inference/components" -xf -
	install -m 0644 tools/gateway-channel "$(DESTDIR)$(PREFIX)/share/asys-inference/gateway-channel"
	install -m 0644 tools/provider-channel "$(DESTDIR)$(PREFIX)/share/asys-inference/provider-channel"
	install -d "$(DESTDIR)$(PREFIX)/share/asys-inference/python/asys_runtime"
	install -m 0644 ../asys-runtime/asys_runtime/*.py "$(DESTDIR)$(PREFIX)/share/asys-inference/python/asys_runtime/"
	install -m 0644 ../LICENSE ../asys-runtime/LICENSE.multiagent "$(DESTDIR)$(PREFIX)/share/asys-inference/"
