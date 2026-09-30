include ../build.mk

PREFIX ?= $(HOME)/.local
BPMN_ELEMENTS ?= latest
MODDLE_CONTEXT_SERIALIZER ?= latest
.PHONY: test test-upstream-drift build install
test:
	npm test
test-upstream-drift:
	node tools/test-upstream-drift.mjs "$(BPMN_ELEMENTS)" "$(MODDLE_CONTEXT_SERIALIZER)"
build:
	$(MAKE) -C ../asys-workers build
	$(BUILD_IMAGE) asys-bpmn .. Dockerfile
install:
	$(MAKE) -C .. install-host
