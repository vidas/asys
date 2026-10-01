.DEFAULT_GOAL := build

include build.mk

PREFIX ?= $(HOME)/.local
DESTDIR ?=
PYTHON ?= python3
HOST_DEPS ?= .host-deps
NODE ?= node
NPM ?= npm
export PREFIX DESTDIR

JS_PACKAGES := $(patsubst %/package.json,%,$(wildcard asys-inference/components/protocol/*/package.json asys-inference/components/*/package.json)) asys-workers asys-bpmn asys-human-interface
HOST_TOOLS := asys asys-run asys-workers asys-environment
REMOVED_HOST_TOOLS := asys-oneshot asys-goal asys-senate asys-swarm asys-bpmn
REMOVED_HOST_MODULES := oneshot goal senate swarm swarm_view

.PHONY: all host install-host install-skills install-designs build install test test-deps help

all: build

host: $(HOST_DEPS)/.installed
	@set -e; for name in $(HOST_TOOLS); do install -D -m 0755 "tools/$$name" "bin/$$name"; done
	@set -e; for name in $(REMOVED_HOST_TOOLS); do rm -f "bin/$$name" "$$name/bin/$$name"; done

# Private Python dependencies of the host commands; see python/requirements-host.txt.
$(HOST_DEPS)/.installed: python/requirements-host.txt
	$(PYTHON) -m pip install --disable-pip-version-check --no-compile --no-deps --upgrade --target "$(HOST_DEPS)" -r python/requirements-host.txt
	touch "$@"

install-host: install-skills install-designs
	@test -f "$(HOST_DEPS)/.installed" || { echo "Host dependencies are not built; run make first." >&2; exit 1; }
	@set -e; for name in $(REMOVED_HOST_TOOLS); do rm -f "$(DESTDIR)$(PREFIX)/bin/$$name"; done
	@set -e; for name in $(REMOVED_HOST_MODULES); do \
		rm -f "$(DESTDIR)$(PREFIX)/share/asys/python/asys/$$name.py" \
		      "$(DESTDIR)$(PREFIX)/share/asys/python/asys/$$name.pyc" \
		      "$(DESTDIR)$(PREFIX)/share/asys/python/asys/__pycache__/$$name."*.pyc; \
	done
	rm -f "$(DESTDIR)$(PREFIX)/share/asys/python/asys_swarm/world_process.py" \
	      "$(DESTDIR)$(PREFIX)/share/asys/python/asys_swarm/world_process.pyc" \
	      "$(DESTDIR)$(PREFIX)/share/asys/python/asys_swarm/__pycache__/world_process."*.pyc
	rm -rf -- "$(DESTDIR)$(PREFIX)/share/asys-swarm" "$(DESTDIR)$(PREFIX)/share/asys-bpmn"
	@set -e; for name in $(HOST_TOOLS); do install -D -m 0755 "tools/$$name" "$(DESTDIR)$(PREFIX)/bin/$$name"; done
	install -d "$(DESTDIR)$(PREFIX)/share/asys/python/asys"
	install -m 0644 python/asys/*.py "$(DESTDIR)$(PREFIX)/share/asys/python/asys/"
	install -d "$(DESTDIR)$(PREFIX)/share/asys/python/asys/dashboard_assets"
	install -m 0644 python/asys/dashboard_assets/* "$(DESTDIR)$(PREFIX)/share/asys/python/asys/dashboard_assets/"
	@set -e; for source in python/asys/system_agents/*.py python/asys/system_agents/*/prompt.md; do \
		install -D -m 0644 "$$source" "$(DESTDIR)$(PREFIX)/share/asys/$$source"; \
	done
	install -d "$(DESTDIR)$(PREFIX)/share/asys/python/asys_runtime"
	install -m 0644 asys-runtime/asys_runtime/*.py "$(DESTDIR)$(PREFIX)/share/asys/python/asys_runtime/"
	install -m 0644 LICENSE "$(DESTDIR)$(PREFIX)/share/asys/"
	install -m 0644 asys-runtime/LICENSE.multiagent "$(DESTDIR)$(PREFIX)/share/asys/"
	rm -rf -- "$(DESTDIR)$(PREFIX)/share/asys/vendor"
	install -d "$(DESTDIR)$(PREFIX)/share/asys/vendor"
	cp -a "$(HOST_DEPS)/." "$(DESTDIR)$(PREFIX)/share/asys/vendor/"
	rm -f "$(DESTDIR)$(PREFIX)/share/asys/vendor/.installed"
	@if test -f release.json; then install -m 0644 release.json "$(DESTDIR)$(PREFIX)/share/asys/"; \
	else echo "warning: no release.json; installed commands need images from make build" >&2; fi
	@if test -d asys-workers/asys_swarm; then \
		install -d "$(DESTDIR)$(PREFIX)/share/asys/python/asys_swarm"; \
		install -m 0644 asys-workers/asys_swarm/*.py "$(DESTDIR)$(PREFIX)/share/asys/python/asys_swarm/"; \
	fi
	@if test -d asys-workers/worlds; then find asys-workers/worlds -type f ! -name '*.pyc' ! -path '*/__pycache__/*' -exec sh -ec '\
		destination=$$1; shift; \
		for source do relative=$${source#asys-workers/}; install -D -m 0644 "$$source" "$$destination/$$relative"; done' \
		_ "$(DESTDIR)$(PREFIX)/share/asys/workers" {} +; fi

install-skills:
	rm -rf -- "$(DESTDIR)$(PREFIX)/share/asys/skills/asys" "$(DESTDIR)$(PREFIX)/share/asys/skills/asys-authoring"
	@find skills/asys skills/asys-authoring -type f -exec sh -ec '\
		destination=$$1; shift; \
		for source do install -D -m 0644 "$$source" "$$destination/$$source"; done' \
		_ "$(DESTDIR)$(PREFIX)/share/asys" {} +

install-designs:
	@find designs -type f -exec sh -ec '\
		destination=$$1; shift; \
		for source do install -D -m 0644 "$$source" "$$destination/$$source"; done' \
		_ "$(DESTDIR)$(PREFIX)/share/asys" {} +

build: host
	$(MAKE) -C asys-inference build
	$(MAKE) -C asys-bpmn build
	$(MAKE) -C asys-human-interface build

# Installation builds first. Under sudo the build runs as the invoking user, so
# root never writes into the checkout; only the copying below runs as root.
ifeq ($(shell id -u),0)
BUILD_USER := $(if $(SUDO_USER),sudo -u $(SUDO_USER) -H)
endif

install:
	$(BUILD_USER) $(MAKE) build ASYS_BUILD=$(ASYS_BUILD)
	$(MAKE) -C asys-inference install
	$(MAKE) -C asys-bpmn install
	$(MAKE) -C asys-human-interface install

test-deps: $(HOST_DEPS)/.installed
	@set -e; for directory in $(JS_PACKAGES); do $(NPM) --prefix "$$directory" ci --ignore-scripts; done
	$(MAKE) -C asys-human-interface host-deps

test:
	$(NODE) --test --test-concurrency=1 'test/*.test.mjs'
	$(MAKE) -C asys-inference test
	cd asys-runtime && $(PYTHON) -m unittest discover -s test
	$(NODE) --test --test-concurrency=1 'asys-runtime/test/*.test.mjs'
	$(MAKE) -C asys-swarm test
	@set -e; for directory in $(JS_PACKAGES); do (cd "$$directory" && $(NODE) --test --test-concurrency=1 'test/*.test.mjs'); done

help:
	@printf '%s\n' \
	  'make build         Build host commands and container images' \
	  'make install       Build, then install under PREFIX (default: $$HOME/.local); sudo builds as you' \
	  'make install-host  Install core commands, agents, designs and both skills (no Docker needed)' \
	  'make test-deps     Install Node and TUI dependencies for development tests' \
	  'make test          Run Go, Python and Node tests (after test-deps)' \
	  'PREFIX and DESTDIR apply to all host tools; dcomp is installed separately.'
