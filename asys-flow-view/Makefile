# asys-flow-view: the X11 workflow viewer and editor.
# Needs only the libraries every X11 system has: Xt, Xaw, Xmu, Xft, XRender, fontconfig.

PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
MANDIR ?= $(PREFIX)/share/man
APPDEFAULTSDIR ?= $(PREFIX)/share/X11/app-defaults
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

src/view.o: src/fallback.h src/asys.xbm

# The app-defaults file, as C strings: the resources the program falls back
# on when no AsysFlowView is installed (what ad2c did).
src/fallback.h: AsysFlowView.ad
	sed -e '/^!/d' -e '/^[[:space:]]*$$/d' -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
	    -e 's/^\*/AsysFlowView*/' -e 's/:[[:space:]]*/: /' -e 's/^/    "/' -e 's/$$/",/' $< > $@

install: asys-flow-view
	install -d $(DESTDIR)$(BINDIR) $(DESTDIR)$(MANDIR)/man1 $(DESTDIR)$(APPDEFAULTSDIR)
	install -m 755 asys-flow-view $(DESTDIR)$(BINDIR)/asys-flow-view
	install -m 644 asys-flow-view.1 $(DESTDIR)$(MANDIR)/man1/asys-flow-view.1
	install -m 644 AsysFlowView.ad $(DESTDIR)$(APPDEFAULTSDIR)/AsysFlowView

clean:
	rm -f asys-flow-view $(OBJECTS) src/fallback.h
