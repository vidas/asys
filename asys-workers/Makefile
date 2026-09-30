include ../build.mk

.PHONY: build
build:
	$(BUILD_IMAGE) asys-runtime .. ../asys-runtime/Dockerfile
	$(BUILD_IMAGE) asys-worlds .. worlds/Dockerfile
	$(BUILD_IMAGE) asys-workers .. Dockerfile
	$(BUILD_IMAGE) asys-env-default env/default
