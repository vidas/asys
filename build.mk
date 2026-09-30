# Build identity shared by every Makefile that builds images or binaries.
# The first make computes the build ID once; recursive makes inherit it, so one
# build or install tags everything with the same ID.
ASYS_ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
ifndef ASYS_BUILD
ASYS_BUILD := $(shell "$(ASYS_ROOT)/tools/build-id")
endif
ASYS_VERSION := $(shell cat "$(ASYS_ROOT)/VERSION")
export ASYS_BUILD
BUILD_IMAGE := "$(ASYS_ROOT)/tools/build-image"
