# asys-flow-view: the X11 workflow viewer and editor.
# Needs only the libraries every X11 system has: Xt, Xaw, Xmu, Xft, XRender, fontconfig.

PREFIX ?= $(HOME)/.local
PKG_CONFIG ?= pkg-config
LIBRARIES = xaw7 xmu xt xft xrender fontconfig x11
CFLAGS ?= -O2 -g
CFLAGS += -std=gnu11 -Wall -Wextra -Wno-unused-parameter $(shell $(PKG_CONFIG) --cflags $(LIBRARIES))
LDLIBS += $(shell $(PKG_CONFIG) --libs $(LIBRARIES)) -lm

SOURCES = src/view.c src/Map.c src/service.c src/json.c
OBJECTS = $(SOURCES:.c=.o)

.PHONY: all install clean
all: asys-flow-view

asys-flow-view: $(OBJECTS)
	$(CC) $(LDFLAGS) -o $@ $(OBJECTS) $(LDLIBS)

src/%.o: src/%.c src/*.h
	$(CC) $(CFLAGS) -c -o $@ $<

install: asys-flow-view
	install -d $(DESTDIR)$(PREFIX)/bin
	install -m 755 asys-flow-view $(DESTDIR)$(PREFIX)/bin/asys-flow-view

clean:
	rm -f asys-flow-view $(OBJECTS)
