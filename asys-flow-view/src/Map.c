/*
 * The map draws a workflow in the style guide's grammar (docs/styleguide.pdf):
 * steps are triangles resting on a rail that runs left to right; hue names the
 * kind of work (verde agents, blu programs, rosso humans, giallo gateways),
 * never its state; rails are ink at 45 %; forks and joins turn at 45 degrees
 * and carry no arrowheads; groups and repeats are flat fields of campo. A run
 * shows state by form: open steps have not run, filled ones have, the running
 * one has the verde cursor beneath it, and a failure says so in words.
 *
 * The rail carries order the way a line carries words: a run longer than the
 * window wraps into lines, left to right and top to bottom, breaking only
 * between columns. A rail that continues on the next line returns along the
 * left margin, like a carriage return.
 *
 * Everything is drawn with XRender into a back buffer, so shapes are
 * antialiased, and text with Xft.
 */
#include "MapP.h"

#include <X11/StringDefs.h>
#include <X11/keysym.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define UNIT_X 96.0          /* pixels per layout unit at zoom 1 */
#define UNIT_Y 76.0
#define STEP 26.0            /* triangle base */
#define RAIL 2.0
#define THIN 1.25
#define MARGIN 40.0
/* The gap under a line, in units, top to bottom: the steps' labels, the
 * lane of returns within the line, the lanes of rails leaving for other
 * lines; then, above the next line, the lanes of rails arriving there. */
#define LINE_GAP 1.8
#define LANE_RETURN 0.5
#define LANE_ONWARD 0.75
#define LANE_BACK 1.0
#define LANE_ARRIVE 0.35     /* above the target line */
#define LANE_ARRIVE_BACK 0.6
#define BAR 7.0              /* scrollbar thickness */

enum { C_PAPER, C_INK, C_RAIL, C_CAMPO, C_VERDE, C_BLU, C_ROSSO, C_GIALLO };

#define offset(field) XtOffsetOf(MapRec, map.field)
static XtResource resources[] = {
    { XtNselectCallback, XtCCallback, XtRCallback, sizeof(XtPointer), offset(select_callback), XtRCallback, NULL },
    { XtNactivateCallback, XtCCallback, XtRCallback, sizeof(XtPointer), offset(activate_callback), XtRCallback, NULL },
    { XtNconnectCallback, XtCCallback, XtRCallback, sizeof(XtPointer), offset(connect_callback), XtRCallback, NULL },
    { XtNsansFont, XtCFontName, XtRString, sizeof(String), offset(sans_name), XtRString, (XtPointer)"Nimbus Sans" },
    { XtNsansBoldFont, XtCFontName, XtRString, sizeof(String), offset(sans_bold_name), XtRString, (XtPointer)"Nimbus Sans:bold" },
    { XtNmonoFont, XtCFontName, XtRString, sizeof(String), offset(mono_name), XtRString, (XtPointer)"Nimbus Mono PS" },
    { XtNpaper, "Paper", XtRString, sizeof(String), offset(paper), XtRString, (XtPointer)"#EFE7D6" },
    { XtNink, "Ink", XtRString, sizeof(String), offset(ink), XtRString, (XtPointer)"#201A12" },
    { XtNverde, "Verde", XtRString, sizeof(String), offset(verde), XtRString, (XtPointer)"#3E7C5A" },
    { XtNblu, "Blu", XtRString, sizeof(String), offset(blu), XtRString, (XtPointer)"#2A5CAA" },
    { XtNrosso, "Rosso", XtRString, sizeof(String), offset(rosso), XtRString, (XtPointer)"#D8402E" },
    { XtNgiallo, "Giallo", XtRString, sizeof(String), offset(giallo), XtRString, (XtPointer)"#EFB02C" },
};
#undef offset

/* Colours are resources by name, so Xdefaults can set them. */
static XRenderColor parse_color(Display *display, Colormap colormap, const char *spec, const char *fallback) {
    XColor exact, screen;
    XRenderColor color = { 0, 0, 0, 0xffff };
    if (!spec || !XLookupColor(display, colormap, spec, &exact, &screen))
        XLookupColor(display, colormap, fallback, &exact, &screen);
    color.red = exact.red; color.green = exact.green; color.blue = exact.blue;
    return color;
}

static XRenderColor mix(XRenderColor ink, XRenderColor paper, double amount) {
    XRenderColor color = { 0, 0, 0, 0xffff };
    color.red = (unsigned short)(paper.red + (ink.red - paper.red) * amount);
    color.green = (unsigned short)(paper.green + (ink.green - paper.green) * amount);
    color.blue = (unsigned short)(paper.blue + (ink.blue - paper.blue) * amount);
    return color;
}

/* Geometry */

static double px(MapWidget w, double unit) { return unit * UNIT_X * w->map.zoom + w->map.offset_x; }
static double py(MapWidget w, double unit) { return unit * UNIT_Y * w->map.zoom + w->map.offset_y; }
static double z(MapWidget w, double length) { return length * w->map.zoom; }

typedef struct { double x, y; } Point;

static double rail_y(MapWidget w, const MapNode *n) { return py(w, n->ly + n->h / 2); }

static Point node_in(MapWidget w, const MapNode *n) {
    Point p = { px(w, n->lx) + (n->box ? 0 : z(w, 10)), rail_y(w, n) };
    return p;
}

static Point node_out(MapWidget w, const MapNode *n) {
    Point p = { px(w, n->lx + n->w) - (n->box ? 0 : z(w, 10)), rail_y(w, n) };
    return p;
}

static int is_gateway(const MapNode *n) {
    return !strcmp(n->kind, "parallel") || !strcmp(n->kind, "switch") || !strcmp(n->kind, "choose");
}

/* Fonts follow the zoom. */

static XftFont *open_font(MapWidget w, const char *family, double size, int bold) {
    char name[256];
    snprintf(name, sizeof name, "%s:pixelsize=%.1f%s:antialias=true:hinting=true", family, size, bold ? ":weight=bold" : "");
    XftFont *font = XftFontOpenName(XtDisplay(w), XScreenNumberOfScreen(XtScreen(w)), name);
    return font ? font : XftFontOpenName(XtDisplay(w), XScreenNumberOfScreen(XtScreen(w)), "sans");
}

static void load_fonts(MapWidget w) {
    Display *d = XtDisplay(w);
    XftFont **fonts[] = { &w->map.sans, &w->map.sans_bold, &w->map.mono, &w->map.mono_bold, &w->map.caps };
    for (unsigned i = 0; i < sizeof fonts / sizeof *fonts; i++)
        if (*fonts[i]) { XftFontClose(d, *fonts[i]); *fonts[i] = NULL; }
    double scale = w->map.zoom < 0.6 ? 0.6 : w->map.zoom > 2.0 ? 2.0 : w->map.zoom;
    w->map.sans = open_font(w, w->map.sans_name, 12.5 * scale, 0);
    w->map.sans_bold = open_font(w, w->map.sans_bold_name, 12.5 * scale, 1);
    w->map.mono = open_font(w, w->map.mono_name, 12.0 * scale, 0);
    w->map.mono_bold = open_font(w, w->map.mono_name, 12.0 * scale, 1);
    w->map.caps = open_font(w, w->map.sans_bold_name, 9.0 * scale, 1);
}

/* Drawing primitives: every shape is antialiased triangles. */

static void triangles(MapWidget w, int color, const XTriangle *list, int count) {
    XRenderCompositeTriangles(XtDisplay(w), PictOpOver, w->map.fills[color], w->map.picture,
                              XRenderFindStandardFormat(XtDisplay(w), PictStandardA8), 0, 0, list, count);
}

static XPointFixed fixed(double x, double y) {
    XPointFixed p = { XDoubleToFixed(x), XDoubleToFixed(y) };
    return p;
}

static void triangle(MapWidget w, int color, Point a, Point b, Point c) {
    XTriangle t = { fixed(a.x, a.y), fixed(b.x, b.y), fixed(c.x, c.y) };
    triangles(w, color, &t, 1);
}

static void quad(MapWidget w, int color, Point a, Point b, Point c, Point d) {
    XTriangle t[2] = { { fixed(a.x, a.y), fixed(b.x, b.y), fixed(c.x, c.y) },
                       { fixed(a.x, a.y), fixed(c.x, c.y), fixed(d.x, d.y) } };
    triangles(w, color, t, 2);
}

static void disc(MapWidget w, int color, Point c, double radius) {
    XTriangle t[8];
    for (int i = 0; i < 8; i++) {
        double a0 = i * M_PI / 4, a1 = (i + 1) * M_PI / 4;
        t[i].p1 = fixed(c.x, c.y);
        t[i].p2 = fixed(c.x + radius * cos(a0), c.y + radius * sin(a0));
        t[i].p3 = fixed(c.x + radius * cos(a1), c.y + radius * sin(a1));
    }
    triangles(w, color, t, 8);
}

static void segment(MapWidget w, int color, Point a, Point b, double width) {
    double dx = b.x - a.x, dy = b.y - a.y, length = sqrt(dx * dx + dy * dy);
    if (length < 0.01) return;
    double nx = -dy / length * width / 2, ny = dx / length * width / 2;
    Point p1 = { a.x + nx, a.y + ny }, p2 = { b.x + nx, b.y + ny }, p3 = { b.x - nx, b.y - ny }, p4 = { a.x - nx, a.y - ny };
    quad(w, color, p1, p2, p3, p4);
}

static void polyline(MapWidget w, int color, const Point *points, int count, double width) {
    for (int i = 0; i + 1 < count; i++) segment(w, color, points[i], points[i + 1], width);
    for (int i = 1; i + 1 < count; i++) disc(w, color, points[i], width / 2);   /* round joins */
}

static void rectangle(MapWidget w, int color, double x, double y, double width, double height) {
    XRenderFillRectangle(XtDisplay(w), PictOpOver, w->map.picture, &w->map.colors[color],
                         (int)floor(x), (int)floor(y), (unsigned)ceil(width), (unsigned)ceil(height));
}

static double text_width(MapWidget w, XftFont *font, const char *text) {
    XGlyphInfo extents;
    XftTextExtentsUtf8(XtDisplay(w), font, (const FcChar8 *)text, (int)strlen(text), &extents);
    return extents.xOff;
}

static void text(MapWidget w, XftFont *font, XftColor *color, double x, double y, const char *string) {
    XftDrawStringUtf8(w->map.draw, color, font, (int)lround(x), (int)lround(y), (const FcChar8 *)string, (int)strlen(string));
}

/* Small capitals: upper case, bold, tracked by 0.2 em. Returns the width. */
static double caps(MapWidget w, XftColor *color, double x, double y, const char *string, int measure_only) {
    double tracking = w->map.caps->height * 0.2, start = x;
    char letter[8];
    for (const char *s = string; *s; ) {
        int length = 1;
        while (s[length] && (s[length] & 0xC0) == 0x80) length++;
        memcpy(letter, s, (size_t)length);
        letter[length] = 0;
        if (length == 1 && letter[0] >= 'a' && letter[0] <= 'z') letter[0] = (char)(letter[0] - 'a' + 'A');
        if (letter[0] == '_') letter[0] = ' ';
        if (!measure_only) text(w, w->map.caps, color, x, y, letter);
        x += text_width(w, w->map.caps, letter) + tracking;
        s += length;
    }
    return x - start - tracking;
}

/* The step mark: an equilateral triangle resting on the rail, or a gateway
 * balanced on it. OPEN draws the outline only. */
static void mark(MapWidget w, int color, Point base, double size, int inverted, int open) {
    double half = size / 2, height = size * 0.866;
    Point a, b, c;
    if (inverted) {
        double top = base.y - height * 0.62;
        a = (Point){ base.x - half, top }; b = (Point){ base.x + half, top }; c = (Point){ base.x, top + height };
    } else {
        a = (Point){ base.x - half, base.y }; b = (Point){ base.x + half, base.y }; c = (Point){ base.x, base.y - height };
    }
    if (!open) { triangle(w, color, a, b, c); return; }
    Point outline[4] = { a, b, c, a };
    triangle(w, C_PAPER, a, b, c);
    polyline(w, color, outline, 4, z(w, 2.2));
    disc(w, color, a, z(w, 1.1));
}

static int work_color(const MapNode *n) {
    const char *work = n->work ? n->work : "";
    if (!strcmp(n->kind, "call")) return C_VERDE;
    if (!strcmp(work, "program")) return C_BLU;
    if (!strcmp(work, "human")) return C_ROSSO;
    if (!strcmp(work, "agent") || !strcmp(work, "goal") || !strcmp(work, "senate") || !strcmp(work, "swarm")) return C_VERDE;
    return C_RAIL;
}

/* Edges */

static int edge_color(MapWidget w, const MapEdge *e) {
    return w->map.selected >= 0 && (e->from == w->map.selected || e->to == w->map.selected) ? C_VERDE : C_RAIL;
}

static int is_thin(const char *role) {
    return !strcmp(role, "error") || !strcmp(role, "timeout") || !strcmp(role, "undo") || !strcmp(role, "compensate");
}

/* POINTS, a path of horizontal and vertical runs, with each corner cut at
 * 45 degrees: rails never turn square. */
static int chamfer(MapWidget w, const Point *points, int count, Point *out) {
    int n = 0;
    out[n++] = points[0];
    for (int i = 1; i + 1 < count; i++) {
        Point p = points[i], before = points[i - 1], after = points[i + 1];
        double in = hypot(p.x - before.x, p.y - before.y), away = hypot(after.x - p.x, after.y - p.y);
        double cut = fmin(z(w, 12), fmin(in, away) / 2);
        if (cut < 0.5) { out[n++] = p; continue; }
        out[n++] = (Point){ p.x - (p.x - before.x) / in * cut, p.y - (p.y - before.y) / in * cut };
        out[n++] = (Point){ p.x + (after.x - p.x) / away * cut, p.y + (after.y - p.y) / away * cut };
    }
    out[n++] = points[count - 1];
    return n;
}

static int route(MapWidget w, const MapEdge *e, Point *points) {
    const MapNode *from = &w->map.nodes[e->from], *to = &w->map.nodes[e->to];
    Point a = node_out(w, from), b = node_in(w, to);
    double dy = b.y - a.y, rise = fabs(dy);
    int n = 0;
    if (from->line != to->line) {
        /* Onto another line: down into the gap below this one, along the left
         * margin, through the gap above the target's line, and down onto its
         * rail just before it, never along another step's rail. A return to an
         * earlier line takes the outer lanes. */
        int back = to->line < from->line;
        double below = py(w, w->map.line_bottom[from->line] + (back ? LANE_BACK : LANE_ONWARD));
        double above = py(w, w->map.line_top[to->line] - (back ? LANE_ARRIVE_BACK : LANE_ARRIVE));
        double margin = px(w, 0) - z(w, back ? 30 : 16), drop = b.x - z(w, 16);
        Point path[8] = { a, { a.x + z(w, 14), a.y }, { a.x + z(w, 14), below }, { margin, below },
                          { margin, above }, { drop, above }, { drop, b.y }, b };
        return chamfer(w, path, 8, points);
    }
    if (e->back || b.x < a.x + z(w, 4)) {
        /* A return: down from the source, back along a lane under the line,
         * and up into the target. */
        double lane = py(w, w->map.line_bottom[from->line] + LANE_RETURN);   /* under every label of the line */
        Point path[6] = { a, { a.x + z(w, 14), a.y }, { a.x + z(w, 14), lane }, { b.x - z(w, 14), lane },
                          { b.x - z(w, 14), b.y }, b };
        return chamfer(w, path, 6, points);
    }
    points[n++] = a;
    if (rise > 0.5 && b.x - a.x > rise) {
        /* Branches and exits leave at once; flows into a join converge late. */
        int fork = is_gateway(from) || is_thin(e->role) || !strcmp(e->role, "branch") || !strcmp(e->role, "case") ||
                   !strcmp(e->role, "default") || !strcmp(e->role, "action");
        if (fork) points[n++] = (Point){ a.x + rise, b.y };      /* split at the gateway */
        else points[n++] = (Point){ b.x - rise, a.y };            /* converge before the join */
    }
    points[n++] = b;
    return n;
}

static void draw_edge(MapWidget w, const MapEdge *e) {
    Point points[16];
    int count = route(w, e, points);
    int thin = is_thin(e->role);
    polyline(w, edge_color(w, e), points, count, z(w, thin ? THIN : RAIL));
    /* A label rides the edge's longest straight run above the rail, shortened
     * to fit it; the inspector has the whole condition. */
    const char *label = !strcmp(e->role, "case") ? e->label : !strcmp(e->role, "default") ? "default"
                      : !strcmp(e->role, "error") ? "on error" : thin ? e->role : NULL;
    if (!label) return;
    int best = -1;
    double room = 0;
    for (int i = 0; i + 1 < count; i++) {
        double run = points[i + 1].x - points[i].x;
        if (fabs(points[i + 1].y - points[i].y) < 0.5 && run > room) { room = run; best = i; }
    }
    room -= z(w, 34);   /* clear of the steps at either end */
    if (best < 0 || room < z(w, 24)) return;
    double x = points[best].x + z(w, 14), y = points[best].y - z(w, 6);
    if (!strcmp(e->role, "case")) {
        char shown[160];
        snprintf(shown, sizeof shown, "%s", label);
        for (size_t length = strlen(shown); length > 1 && text_width(w, w->map.mono, shown) > room; ) {
            length--;
            while (length > 1 && (shown[length] & 0xC0) == 0x80) length--;   /* whole characters */
            snprintf(shown + length, sizeof shown - length, "…");
        }
        text(w, w->map.mono, &w->map.text_soft, x, y, shown);
    } else if (caps(w, NULL, 0, 0, label, 1) <= room) {
        caps(w, &w->map.text_soft, x, y, label, 0);
    }
}

/* Fields: a group or repeat is a flat band of campo the rail crosses. */

static void draw_field(MapWidget w, const MapNode *n, int index) {
    double x = px(w, n->lx), y = py(w, n->ly), width = z(w, n->w * UNIT_X), height = z(w, n->h * UNIT_Y);
    rectangle(w, C_CAMPO, x, y, width, height);
    if (w->map.selected == index) rectangle(w, C_VERDE, x, y, width, z(w, 3));
    char label[160];
    snprintf(label, sizeof label, "%s%s", n->step, !strcmp(n->kind, "repeat") ? " · repeat" : n->for_each ? " · each" : "");
    caps(w, &w->map.text_soft, x + z(w, 10), y + z(w, 16), label, 0);
    /* The rail enters at the left, reaches each first step, and leaves from each last one. */
    Point in = node_in(w, n), out = node_out(w, n);
    for (int i = 0; i < w->map.node_count; i++) {
        const MapNode *inner = &w->map.nodes[i];
        if (strcmp(inner->scope, n->id)) continue;
        int entered = 0, leaves = 0;
        for (int j = 0; j < w->map.edge_count; j++) {
            const MapEdge *e = &w->map.edges[j];
            if (e->back) continue;
            if (e->to == i && !strcmp(w->map.nodes[e->from].scope, n->id)) entered = 1;
            if (e->from == i && !strcmp(w->map.nodes[e->to].scope, n->id)) leaves = 1;
        }
        int color = w->map.selected == index ? C_VERDE : C_RAIL;
        if (!entered) {
            Point to = node_in(w, inner), points[3] = { in, { to.x - fabs(to.y - in.y), in.y }, to };
            if (points[1].x < in.x) points[1].x = in.x;
            polyline(w, color, points, 3, z(w, RAIL));
        }
        if (!leaves && strcmp(inner->kind, "end")) {
            Point from = node_out(w, inner), points[3] = { from, { from.x + fabs(out.y - from.y), out.y }, out };
            if (points[1].x > out.x) points[1].x = out.x;
            polyline(w, color, points, 3, z(w, RAIL));
        }
    }
}

/* Steps */

static void describe(MapWidget w, const MapNode *n, double cx, double line);

static void draw_step(MapWidget w, const MapNode *n, int index) {
    Point in = node_in(w, n), out = node_out(w, n);
    double cx = is_gateway(n) ? out.x : (in.x + out.x) / 2, y = in.y, size = z(w, STEP);   /* a gateway sits at the split */
    int selected = w->map.selected == index;
    int open = w->map.states && (n->state == STATE_WAITING || n->state == STATE_FAILED);
    polyline(w, selected ? C_VERDE : C_RAIL, (Point[]){ in, out }, 2, z(w, RAIL));

    if (!strcmp(n->kind, "end")) {
        rectangle(w, C_INK, in.x - z(w, 1.5), y - z(w, 11), z(w, 3), z(w, 22));
        text(w, w->map.sans, &w->map.text_ink, in.x + z(w, 8), y - z(w, 6), n->label);
        text(w, w->map.mono, &w->map.text_soft, in.x + z(w, 8), y + z(w, 18), n->step);
        return;
    }
    if (is_gateway(n)) {
        mark(w, C_GIALLO, (Point){ cx, y }, size * 0.8, 1, open);
    } else if (!strcmp(n->kind, "wait") || !strcmp(n->kind, "delay") || !strcmp(n->kind, "compensate")) {
        mark(w, C_RAIL, (Point){ cx, y }, size * 0.62, 0, open);
    } else {
        int color = work_color(n);
        if (n->for_each)    /* many: two echoes behind the step */
            for (int k = 2; k >= 1; k--)
                mark(w, color, (Point){ cx - z(w, 9) * k, y }, size * (1 - 0.22 * k), 0, open);
        mark(w, color, (Point){ cx, y }, size, 0, open);
        if (!strcmp(n->kind, "call"))   /* another workflow runs here: a second rail */
            rectangle(w, color, cx - size / 2, y + z(w, 3.5), size, z(w, 2));
    }
    if (w->map.states && n->state == STATE_RUNNING)   /* the cursor reads from below */
        mark(w, C_VERDE, (Point){ cx, y + z(w, 17) }, size * 0.42, 0, 0);

    /* The ID in mono beneath the rail and what runs it in small capitals; a
     * gateway, where branches leave below and above, carries them above. */
    XftFont *mono = selected ? w->map.mono_bold : w->map.mono;
    char id[160];
    if (n->visits > 1) snprintf(id, sizeof id, "%s ×%d", n->step, n->visits);
    else snprintf(id, sizeof id, "%s", n->step);
    char what[160] = "";
    if (n->worker) snprintf(what, sizeof what, "%s", n->worker);
    else if (n->call) snprintf(what, sizeof what, "%s", n->call);
    else if (strcmp(n->kind, "run")) snprintf(what, sizeof what, "%s", n->kind);
    double what_width = *what ? caps(w, NULL, 0, 0, what, 1) : 0;
    double line = y + z(w, w->map.states && n->state == STATE_RUNNING ? 34 : 20);   /* below the cursor */
    if (is_gateway(n)) {
        double top = y - size * 0.75 - z(w, 8);
        if (*what) caps(w, &w->map.text_soft, cx - what_width / 2, top - z(w, 15), what, 0);
        text(w, mono, &w->map.text_ink, cx - text_width(w, mono, id) / 2, top, id);
        line -= z(w, 15);
    } else {
        text(w, mono, &w->map.text_ink, cx - text_width(w, mono, id) / 2, line, id);
        if (*what) caps(w, &w->map.text_soft, cx - what_width / 2, line + z(w, 15), what, 0);
    }
    line += z(w, 15);
    if (n->label && strcmp(n->label, n->step) && !is_gateway(n)) {
        line += z(w, 15);
        describe(w, n, cx, line);
    }
    if (w->map.states && n->state == STATE_FAILED) {
        line += z(w, 14);
        double width = caps(w, NULL, 0, 0, "failed", 1);
        caps(w, &w->map.text_ink, cx - width / 2, line, "failed", 0);
    }
    if (n->problem) {   /* marked here; the panel says what it is */
        line += z(w, 14);
        double width = caps(w, NULL, 0, 0, "problem", 1), x = cx - width / 2;
        rectangle(w, C_INK, x - z(w, 9), line - z(w, 5), z(w, 5), z(w, 2));
        caps(w, &w->map.text_ink, x, line, "problem", 0);
    }
}

/* A step's description, under its ID and worker, shortened to its column:
 * above the rail is where branches and returning rails run. */
static void describe(MapWidget w, const MapNode *n, double cx, double line) {
    if (!n->label || !strcmp(n->label, n->step) || is_gateway(n) || !strcmp(n->kind, "end")) return;
    double room = z(w, 1.9 * UNIT_X);
    char shown[256];
    snprintf(shown, sizeof shown, "%s", n->label);
    for (size_t length = strlen(shown); length > 1 && text_width(w, w->map.sans, shown) > room; ) {
        length--;
        while (length > 1 && (shown[length] & 0xC0) == 0x80) length--;
        snprintf(shown + length, sizeof shown - length, "…");
    }
    text(w, w->map.sans, &w->map.text_soft, cx - text_width(w, w->map.sans, shown) / 2, line, shown);
}

static int scrollbar(MapWidget w, int axis, double *track, double *start, double *length);

static void render(MapWidget w) {
    if (!XtIsRealized((Widget)w) || !w->map.picture) return;
    rectangle(w, C_PAPER, 0, 0, w->map.width, w->map.height);
    /* The spec line opens the page, top left, as on the style guide's sheets. */
    double head = w->map.offset_y - z(w, (LINE_GAP + 0.1) * UNIT_Y);
    caps(w, &w->map.text_soft, MARGIN - w->map.scroll_x, head,
         w->map.spec ? w->map.spec : w->map.node_count ? "workflow" : "no workflow", 0);
    for (int i = 0; i < w->map.node_count; i++)
        if (w->map.nodes[i].box) draw_field(w, &w->map.nodes[i], i);
    for (int i = 0; i < w->map.edge_count; i++) {
        const MapEdge *e = &w->map.edges[i];
        if (strcmp(e->role, "join")) { draw_edge(w, e); continue; }
        /* Branches rejoin where the join step begins, and a gateway balances there. */
        const MapNode *join = &w->map.nodes[e->to];
        for (int j = 0; j < w->map.edge_count; j++) {
            const MapEdge *branch = &w->map.edges[j];
            if (branch->from != e->from || strcmp(branch->role, "branch")) continue;
            MapEdge rejoin = { branch->to, e->to, (char *)"next", NULL, 0 };
            draw_edge(w, &rejoin);
        }
        Point in = node_in(w, join);
        mark(w, C_GIALLO, (Point){ in.x - z(w, 4), in.y }, z(w, STEP) * 0.8, 1, 0);
    }
    /* The run starts at a tick before its first step. */
    int first = -1;
    for (int i = 0; i < w->map.node_count; i++) {
        const MapNode *n = &w->map.nodes[i];
        if (*n->scope) continue;
        int entered = 0;
        for (int j = 0; j < w->map.edge_count; j++) if (w->map.edges[j].to == i && !w->map.edges[j].back) entered = 1;
        if (!entered && (first < 0 || n->x < w->map.nodes[first].x)) first = i;
    }
    if (first >= 0) {
        Point in = node_in(w, &w->map.nodes[first]);
        polyline(w, C_RAIL, (Point[]){ { in.x - z(w, 30), in.y }, in }, 2, z(w, RAIL));
        rectangle(w, C_INK, in.x - z(w, 31.5), in.y - z(w, 9), z(w, 3), z(w, 18));
    }
    for (int i = 0; i < w->map.node_count; i++)
        if (!w->map.nodes[i].box) draw_step(w, &w->map.nodes[i], i);
    /* Connecting: a verde rail follows the pointer. */
    if (w->map.connecting && w->map.selected >= 0) {
        Point from = node_out(w, &w->map.nodes[w->map.selected]);
        polyline(w, C_VERDE, (Point[]){ from, { w->map.pointer_x, w->map.pointer_y } }, 2, z(w, RAIL));
    }
    /* Scrollbars, only when the page is larger than the window: a campo
     * track and an ink thumb, flat like everything else. */
    double track, start, length;
    if (scrollbar(w, 'v', &track, &start, &length)) {
        rectangle(w, C_CAMPO, w->map.width - BAR - 3, 3, BAR, track);
        rectangle(w, C_RAIL, w->map.width - BAR - 3, 3 + start, BAR, length);
    }
    if (scrollbar(w, 'h', &track, &start, &length)) {
        rectangle(w, C_CAMPO, 3, w->map.height - BAR - 3, track, BAR);
        rectangle(w, C_RAIL, 3 + start, w->map.height - BAR - 3, length, BAR);
    }
}

static void show(MapWidget w) {
    render(w);
    if (XtIsRealized((Widget)w))
        XCopyArea(XtDisplay(w), w->map.buffer, XtWindow(w), DefaultGCOfScreen(XtScreen(w)), 0, 0,
                  (unsigned)w->map.width, (unsigned)w->map.height, 0, 0);
}

/* Buffers */

static void free_buffer(MapWidget w) {
    Display *d = XtDisplay(w);
    if (w->map.draw) XftDrawDestroy(w->map.draw);
    if (w->map.picture) XRenderFreePicture(d, w->map.picture);
    if (w->map.buffer) XFreePixmap(d, w->map.buffer);
    w->map.draw = NULL; w->map.picture = 0; w->map.buffer = 0;
}

static void make_buffer(MapWidget w) {
    Display *d = XtDisplay(w);
    Visual *visual = DefaultVisualOfScreen(XtScreen(w));
    free_buffer(w);
    w->map.width = w->core.width > 0 ? w->core.width : 1;
    w->map.height = w->core.height > 0 ? w->core.height : 1;
    w->map.buffer = XCreatePixmap(d, XtWindow(w), (unsigned)w->map.width, (unsigned)w->map.height, w->core.depth);
    w->map.picture = XRenderCreatePicture(d, w->map.buffer, XRenderFindVisualFormat(d, visual), 0, NULL);
    w->map.draw = XftDrawCreate(d, w->map.buffer, visual, w->core.colormap);
}

/* Graph */

static char *copy(const char *s) { return s ? strdup(s) : NULL; }


static void clear_graph(MapWidget w) {
    for (int i = 0; i < w->map.node_count; i++) {
        MapNode *n = &w->map.nodes[i];
        free(n->id); free(n->step); free(n->scope); free(n->kind); free(n->label);
        free(n->worker); free(n->work); free(n->call); free(n->problem);
    }
    for (int i = 0; i < w->map.edge_count; i++) { free(w->map.edges[i].role); free(w->map.edges[i].label); }
    free(w->map.nodes); free(w->map.edges);
    w->map.nodes = NULL; w->map.edges = NULL;
    w->map.node_count = w->map.edge_count = 0;
}

static int find(MapWidget w, const char *id) {
    for (int i = 0; id && i < w->map.node_count; i++)
        if (!strcmp(w->map.nodes[i].id, id)) return i;
    return -1;
}

/* Wrapping */

static double left_pad(MapWidget w) { return MARGIN + z(w, 40); }    /* the start tick and returning rails */
static double top_pad(MapWidget w) { return MARGIN + z(w, (LINE_GAP + 0.4) * UNIT_Y); }   /* the spec line, above the lanes into line 1 */

static int by_x(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

/* Break the run into lines that fit the window at this zoom. A line ends
 * only between columns of the outermost scope, so a branch, group or repeat
 * is never split; one wider than the window has a line of its own. */
static void relayout(MapWidget w) {
    int count = w->map.node_count;
    free(w->map.line_bottom);
    free(w->map.line_top);
    w->map.line_bottom = w->map.line_top = NULL;
    w->map.line_count = 0;
    w->map.content_w = w->map.content_h = 0;
    if (!count) return;
    double available = (w->map.width - left_pad(w) - MARGIN - BAR) / (UNIT_X * w->map.zoom);
    double *columns = calloc((size_t)count, sizeof(double)), *starts = calloc((size_t)count, sizeof(double));
    int column_count = 0, lines = 0;
    for (int i = 0; i < count; i++) if (!*w->map.nodes[i].scope) columns[column_count++] = w->map.nodes[i].x;
    qsort(columns, (size_t)column_count, sizeof(double), by_x);
    for (int c = 0; c < column_count; c++) {
        if (c && columns[c] == columns[c - 1]) continue;
        double end = columns[c];
        for (int i = 0; i < count; i++) {
            const MapNode *n = &w->map.nodes[i];
            if (!*n->scope && n->x == columns[c] && n->x + n->w > end) end = n->x + n->w;
        }
        if (!lines || end - starts[lines - 1] > available) starts[lines++] = columns[c];
    }
    /* Each step takes the line of its outermost enclosing step. */
    for (int i = 0; i < count; i++) {
        MapNode *n = &w->map.nodes[i];
        char root[256];
        snprintf(root, sizeof root, "%s", n->id);
        char *slash = strchr(root, '/');
        if (slash) *slash = 0;
        int outer = find(w, root);
        double x = outer >= 0 ? w->map.nodes[outer].x : n->x;
        n->line = 0;
        while (n->line + 1 < lines && starts[n->line + 1] <= x + 1e-9) n->line++;
    }
    /* Lines are as tall as what they hold. */
    double *top = calloc((size_t)lines, sizeof(double)), *bottom = calloc((size_t)lines, sizeof(double));
    for (int l = 0; l < lines; l++) { top[l] = 1e9; bottom[l] = -1e9; }
    for (int i = 0; i < count; i++) {
        const MapNode *n = &w->map.nodes[i];
        top[n->line] = fmin(top[n->line], n->y);
        bottom[n->line] = fmax(bottom[n->line], n->y + n->h);
    }
    w->map.line_bottom = calloc((size_t)lines, sizeof(double));
    w->map.line_top = calloc((size_t)lines, sizeof(double));
    double offset = 0, width = 0;
    for (int l = 0; l < lines; l++) {
        if (top[l] > bottom[l]) { top[l] = bottom[l] = 0; }
        w->map.line_top[l] = offset;
        w->map.line_bottom[l] = offset + bottom[l] - top[l];
        for (int i = 0; i < count; i++) {
            MapNode *n = &w->map.nodes[i];
            if (n->line != l) continue;
            n->lx = n->x - starts[l];
            n->ly = n->y - top[l] + offset;
            width = fmax(width, n->lx + n->w);
        }
        offset = w->map.line_bottom[l] + LINE_GAP;
    }
    w->map.line_count = lines;
    w->map.content_w = left_pad(w) + width * UNIT_X * w->map.zoom + MARGIN;
    w->map.content_h = top_pad(w) + (offset - LINE_GAP) * UNIT_Y * w->map.zoom + z(w, 0.8 * UNIT_Y) + MARGIN;
    free(columns); free(starts); free(top); free(bottom);
}

/* Keep the scroll within the page; a page shorter than the window sits a
 * little above the middle, where the eye rests. */
static void place(MapWidget w) {
    double spare_x = w->map.content_w - w->map.width, spare_y = w->map.content_h - w->map.height;
    w->map.scroll_x = spare_x > 0 ? fmin(fmax(w->map.scroll_x, 0), spare_x) : 0;
    w->map.scroll_y = spare_y > 0 ? fmin(fmax(w->map.scroll_y, 0), spare_y) : 0;
    w->map.offset_x = left_pad(w) - w->map.scroll_x;
    w->map.offset_y = top_pad(w) - w->map.scroll_y + (spare_y < 0 ? -spare_y / 3 : 0);
}

static void reflow(MapWidget w) {
    relayout(w);
    place(w);
}

/* A scrollbar's track, and its thumb's start and length, in pixels; 0 when
 * the page fits that way. */
static int scrollbar(MapWidget w, int axis, double *track, double *start, double *length) {
    double view = axis == 'v' ? w->map.height : w->map.width;
    double page = axis == 'v' ? w->map.content_h : w->map.content_w;
    double scroll = axis == 'v' ? w->map.scroll_y : w->map.scroll_x;
    if (page <= view + 0.5) return 0;
    *track = view - 6 - BAR;
    *length = fmax(*track * view / page, 24);
    *start = (*track - *length) * scroll / (page - view);
    return 1;
}

void MapSetGraph(Widget widget, const Json *graph) {
    MapWidget w = (MapWidget)widget;
    char *selected = w->map.selected >= 0 ? strdup(w->map.nodes[w->map.selected].id) : NULL;
    int first = w->map.node_count == 0;
    clear_graph(w);
    const Json *nodes = json_get(graph, "nodes"), *edges = json_get(graph, "edges");
    int count = nodes && nodes->type == JSON_ARRAY ? (int)nodes->count : 0;
    w->map.nodes = calloc((size_t)count + 1, sizeof(MapNode));
    for (int i = 0; i < count; i++) {
        const Json *j = json_at(nodes, (size_t)i);
        MapNode *n = &w->map.nodes[w->map.node_count++];
        n->id = copy(json_get_string(j, "id")); n->step = copy(json_get_string(j, "step"));
        n->scope = copy(json_get_string(j, "scope")); n->kind = copy(json_get_string(j, "kind"));
        n->label = copy(json_get_string(j, "label")); n->worker = copy(json_get_string(j, "worker"));
        n->work = copy(json_get_string(j, "work")); n->call = copy(json_get_string(j, "call"));
        if (!n->id) n->id = strdup("?");
        if (!n->step) n->step = strdup(n->id);
        if (!n->scope) n->scope = strdup("");
        if (!n->kind) n->kind = strdup("unknown");
        if (!n->label) n->label = strdup(n->step);
        n->x = json_get_number(j, "x", 0); n->y = json_get_number(j, "y", 0);
        n->w = json_get_number(j, "w", 1); n->h = json_get_number(j, "h", 1);
        n->box = !strcmp(n->kind, "group") || !strcmp(n->kind, "repeat");
        n->for_each = json_get_bool(j, "for_each");
    }
    count = edges && edges->type == JSON_ARRAY ? (int)edges->count : 0;
    w->map.edges = calloc((size_t)count + 1, sizeof(MapEdge));
    for (int i = 0; i < count; i++) {
        const Json *j = json_at(edges, (size_t)i);
        int from = find(w, json_get_string(j, "from")), to = find(w, json_get_string(j, "to"));
        if (from < 0 || to < 0) continue;
        MapEdge *e = &w->map.edges[w->map.edge_count++];
        e->from = from; e->to = to;
        e->role = copy(json_get_string(j, "role"));
        if (!e->role) e->role = strdup("next");
        e->label = copy(json_get_string(j, "label"));
        e->back = json_get_bool(j, "back");
    }
    w->map.selected = find(w, selected);
    free(selected);
    if (first) w->map.scroll_x = w->map.scroll_y = 0;
    reflow(w);
    show(w);
}

void MapSetSpec(Widget widget, const char *spec) {
    MapWidget w = (MapWidget)widget;
    free(w->map.spec);
    w->map.spec = spec ? strdup(spec) : NULL;
    show(w);
}

void MapSetStates(Widget widget, const Json *states) {
    MapWidget w = (MapWidget)widget;
    w->map.states = states != NULL;
    for (int i = 0; i < w->map.node_count; i++) {
        MapNode *n = &w->map.nodes[i];
        const Json *entry = json_get(states, n->id);
        const char *state = json_get_string(entry, "state");
        n->state = !states ? STATE_NONE : !state || !strcmp(state, "waiting") ? STATE_WAITING :
                   !strcmp(state, "running") ? STATE_RUNNING : !strcmp(state, "failed") ? STATE_FAILED : STATE_DONE;
        n->visits = (int)json_get_number(entry, "visits", 0);
    }
    show(w);
}

void MapSetProblems(Widget widget, const Json *problems) {
    MapWidget w = (MapWidget)widget;
    for (int i = 0; i < w->map.node_count; i++) { free(w->map.nodes[i].problem); w->map.nodes[i].problem = NULL; }
    for (size_t k = 0; problems && k < problems->count; k++) {
        const Json *problem = json_at(problems, k);
        const char *at = json_get_string(problem, "at"), *message = json_get_string(problem, "message");
        if (!at || !message || strncmp(at, "steps.", 6)) continue;
        /* steps.search.group.steps.local.input -> search/local */
        char path[256] = "", rest[256];
        snprintf(rest, sizeof rest, "%s", at + 6);
        char *save = NULL, *part = strtok_r(rest, ".", &save);
        int expect_step = 1;
        while (part) {
            if (expect_step) {
                if (*path) strncat(path, "/", sizeof path - strlen(path) - 1);
                strncat(path, part, sizeof path - strlen(path) - 1);
                expect_step = 0;
            } else if (!strcmp(part, "group")) {
                part = strtok_r(NULL, ".", &save);   /* steps */
                expect_step = part && !strcmp(part, "steps");
            } else if (!strcmp(part, "repeat")) {
                expect_step = 1;                       /* repeat.step */
            } else {
                break;
            }
            part = strtok_r(NULL, ".", &save);
        }
        int index = find(w, path);
        while (index < 0 && strchr(path, '/')) { *strrchr(path, '/') = 0; index = find(w, path); }
        if (index >= 0 && !w->map.nodes[index].problem) w->map.nodes[index].problem = strdup(message);
    }
    show(w);
}

void MapSelect(Widget widget, const char *path) {
    MapWidget w = (MapWidget)widget;
    w->map.selected = find(w, path);
    if (w->map.selected >= 0) {   /* keep the selection in view */
        const MapNode *n = &w->map.nodes[w->map.selected];
        double left = px(w, n->lx), right = px(w, n->lx + n->w), top = py(w, n->ly), bottom = py(w, n->ly + n->h) + z(w, 40);
        if (left < MARGIN) w->map.scroll_x -= MARGIN - left;
        else if (right > w->map.width - MARGIN) w->map.scroll_x += right - (w->map.width - MARGIN);
        if (top < MARGIN) w->map.scroll_y -= MARGIN - top;
        else if (bottom > w->map.height - MARGIN) w->map.scroll_y += bottom - (w->map.height - MARGIN);
        place(w);
    }
    show(w);
}

const char *MapSelection(Widget widget) {
    MapWidget w = (MapWidget)widget;
    return w->map.selected >= 0 ? w->map.nodes[w->map.selected].id : NULL;
}

int MapSteps(Widget widget, const char **paths, int capacity) {
    MapWidget w = (MapWidget)widget;
    int count = 0;
    for (int i = 0; i < w->map.node_count && count < capacity; i++) paths[count++] = w->map.nodes[i].id;
    return count;
}

double MapZoomLevel(Widget widget) { return ((MapWidget)widget)->map.zoom; }

/* Zooming rewraps the lines, so the page keeps its relative scroll and the
 * selection stays in view. */
static void set_zoom(MapWidget w, double zoom) {
    zoom = zoom < 0.4 ? 0.4 : zoom > 2.5 ? 2.5 : zoom;
    double fraction = w->map.content_h > w->map.height ? w->map.scroll_y / (w->map.content_h - w->map.height) : 0;
    w->map.zoom = zoom;
    if (XtIsRealized((Widget)w)) load_fonts(w);
    reflow(w);
    w->map.scroll_y = fraction * fmax(w->map.content_h - w->map.height, 0);
    place(w);
    if (w->map.selected >= 0) MapSelect((Widget)w, w->map.nodes[w->map.selected].id);
    else show(w);
}

void MapSetZoom(Widget widget, double zoom) { set_zoom((MapWidget)widget, zoom); }

void MapZoom(Widget widget, double factor) {
    MapWidget w = (MapWidget)widget;
    if (factor > 0) { set_zoom(w, w->map.zoom * factor); return; }
    /* Fit: the largest zoom, up to full size, at which every line fits the window. */
    double zoom = 1.25;
    for (; zoom > 0.45; zoom -= 0.05) {
        w->map.zoom = zoom;
        relayout(w);
        if (w->map.content_h <= w->map.height && w->map.content_w <= w->map.width) break;
    }
    w->map.scroll_x = w->map.scroll_y = 0;
    set_zoom(w, zoom);
}

/* Navigation along the flow */

void MapStep(Widget widget, int direction) {
    MapWidget w = (MapWidget)widget;
    int current = w->map.selected, best = -1;
    if (current < 0) {
        for (int i = 0; i < w->map.node_count; i++)
            if (best < 0 || w->map.nodes[i].ly < w->map.nodes[best].ly
                || (w->map.nodes[i].ly == w->map.nodes[best].ly && w->map.nodes[i].lx < w->map.nodes[best].lx)) best = i;
    } else if (direction == 'n' || direction == 'p') {
        for (int i = 0; i < w->map.edge_count && best < 0; i++) {
            const MapEdge *e = &w->map.edges[i];
            if (direction == 'n' && e->from == current && !e->back) best = e->to;
            if (direction == 'p' && e->to == current && !e->back) best = e->from;
        }
        if (best < 0 && direction == 'n')       /* into a field */
            for (int i = 0; i < w->map.node_count && best < 0; i++)
                if (!strcmp(w->map.nodes[i].scope, w->map.nodes[current].id)) best = i;
        if (best < 0 && direction == 'p')       /* out of a field */
            best = find(w, w->map.nodes[current].scope);
    } else {
        const MapNode *c = &w->map.nodes[current];
        double cy = c->ly + c->h / 2, cx = c->lx + c->w / 2, distance = 1e9;
        for (int i = 0; i < w->map.node_count; i++) {
            const MapNode *n = &w->map.nodes[i];
            double ny = n->ly + n->h / 2, nx = n->lx + n->w / 2;
            if ((direction == 'u' && ny >= cy - 0.01) || (direction == 'd' && ny <= cy + 0.01)) continue;
            double d = fabs(ny - cy) + 2 * fabs(nx - cx);
            if (d < distance) { distance = d; best = i; }
        }
    }
    if (best < 0) return;
    MapSelect(widget, w->map.nodes[best].id);
    XtCallCallbackList(widget, w->map.select_callback, (XtPointer)w->map.nodes[best].id);
}

/* Pointer */

static int hit(MapWidget w, int x, int y) {
    for (int i = w->map.node_count - 1; i >= 0; i--) {   /* steps over fields, inner over outer */
        const MapNode *n = &w->map.nodes[i];
        if (n->box) continue;
        if (x >= px(w, n->lx) && x <= px(w, n->lx + n->w) && y >= py(w, n->ly) && y <= py(w, n->ly + n->h)) return i;
    }
    int found = -1;
    double area = 1e18;
    for (int i = 0; i < w->map.node_count; i++) {
        const MapNode *n = &w->map.nodes[i];
        if (!n->box) continue;
        if (x >= px(w, n->lx) && x <= px(w, n->lx + n->w) && y >= py(w, n->ly) && y <= py(w, n->ly + n->h) && n->w * n->h < area) {
            found = i; area = n->w * n->h;
        }
    }
    return found;
}

static void Press(Widget widget, XEvent *event, String *params, Cardinal *count) {
    (void)params; (void)count;
    MapWidget w = (MapWidget)widget;
    XtSetKeyboardFocus(XtParent(widget), widget);
    double track, start, length;
    w->map.scrolling = 0;
    if (scrollbar(w, 'v', &track, &start, &length) && event->xbutton.x >= w->map.width - BAR - 8) w->map.scrolling = 'v';
    else if (scrollbar(w, 'h', &track, &start, &length) && event->xbutton.y >= w->map.height - BAR - 8) w->map.scrolling = 'h';
    if (w->map.scrolling) {
        /* A press off the thumb pages there; dragging moves the page. */
        double at = w->map.scrolling == 'v' ? event->xbutton.y - 3 : event->xbutton.x - 3;
        if (at < start || at > start + length) {
            double page = w->map.scrolling == 'v' ? w->map.content_h - w->map.height : w->map.content_w - w->map.width;
            double target = (at - length / 2) / (track - length) * page;
            if (w->map.scrolling == 'v') w->map.scroll_y = target; else w->map.scroll_x = target;
            place(w);
            show(w);
        }
        w->map.pressed = 1;
        w->map.press_x = event->xbutton.x; w->map.press_y = event->xbutton.y;
        w->map.press_offset_x = w->map.scroll_x; w->map.press_offset_y = w->map.scroll_y;
        return;
    }
    int index = hit(w, event->xbutton.x, event->xbutton.y);
    int twice = index >= 0 && index == w->map.selected && event->xbutton.time - w->map.last_click < 350;
    w->map.last_click = event->xbutton.time;
    w->map.pressed = 1;
    w->map.dragging = w->map.connecting = 0;
    w->map.press_x = event->xbutton.x; w->map.press_y = event->xbutton.y;
    w->map.press_offset_x = w->map.scroll_x; w->map.press_offset_y = w->map.scroll_y;
    w->map.panning = index < 0;
    w->map.selected = index;
    show(w);
    XtCallCallbackList(widget, w->map.select_callback, index >= 0 ? (XtPointer)w->map.nodes[index].id : NULL);
    if (twice) XtCallCallbackList(widget, w->map.activate_callback, (XtPointer)w->map.nodes[index].id);
}

static void Motion(Widget widget, XEvent *event, String *params, Cardinal *count) {
    (void)params; (void)count;
    MapWidget w = (MapWidget)widget;
    if (!w->map.pressed) return;
    int dx = event->xmotion.x - w->map.press_x, dy = event->xmotion.y - w->map.press_y;
    if (w->map.scrolling) {
        double track, start, length;
        int axis = w->map.scrolling;
        if (scrollbar(w, axis, &track, &start, &length)) {
            double page = axis == 'v' ? w->map.content_h - w->map.height : w->map.content_w - w->map.width;
            double moved = (axis == 'v' ? dy : dx) / fmax(track - length, 1) * page;
            if (axis == 'v') w->map.scroll_y = w->map.press_offset_y + moved;
            else w->map.scroll_x = w->map.press_offset_x + moved;
            place(w);
            show(w);
        }
        return;
    }
    if (!w->map.dragging && dx * dx + dy * dy < 36) return;
    w->map.dragging = 1;
    w->map.pointer_x = event->xmotion.x; w->map.pointer_y = event->xmotion.y;
    if (w->map.panning) {
        w->map.scroll_x = w->map.press_offset_x - dx;
        w->map.scroll_y = w->map.press_offset_y - dy;
        place(w);
    } else {
        w->map.connecting = 1;   /* drag from a step to another to connect them */
    }
    show(w);
}

static void Release(Widget widget, XEvent *event, String *params, Cardinal *count) {
    (void)params; (void)count;
    MapWidget w = (MapWidget)widget;
    if (w->map.connecting && w->map.selected >= 0) {
        int target = hit(w, event->xbutton.x, event->xbutton.y);
        if (target >= 0 && target != w->map.selected) {
            MapConnection connection = { w->map.nodes[w->map.selected].id, w->map.nodes[target].id,
                                         event->xbutton.state & ShiftMask ? "on_error" : "next" };
            XtCallCallbackList(widget, w->map.connect_callback, (XtPointer)&connection);
        }
    }
    w->map.pressed = w->map.dragging = w->map.connecting = w->map.panning = w->map.scrolling = 0;
    show(w);
}

static void Scroll(Widget widget, XEvent *event, String *params, Cardinal *count) {
    MapWidget w = (MapWidget)widget;
    if (*count < 1) return;
    int up = !strcmp(params[0], "up"), zoom = *count > 1 && !strcmp(params[1], "zoom");
    if (zoom) { set_zoom(w, w->map.zoom * (up ? 1.1 : 1 / 1.1)); return; }
    if (event->xbutton.state & ShiftMask) w->map.scroll_x += up ? -60 : 60;
    else w->map.scroll_y += up ? -60 : 60;
    place(w);
    show(w);
}

static void StepAction(Widget widget, XEvent *event, String *params, Cardinal *count) {
    (void)event;
    if (*count > 0) MapStep(widget, params[0][0]);
}

static XtActionsRec actions[] = {
    { "map-press", Press }, { "map-motion", Motion }, { "map-release", Release },
    { "map-scroll", Scroll }, { "map-step", StepAction },
};

static char translations[] =
    "<Btn1Down>: map-press()\n"
    "<Btn1Motion>: map-motion()\n"
    "<Btn1Up>: map-release()\n"
    "Ctrl<Btn4Down>: map-scroll(up, zoom)\n"
    "Ctrl<Btn5Down>: map-scroll(down, zoom)\n"
    "<Btn4Down>: map-scroll(up)\n"
    "<Btn5Down>: map-scroll(down)\n"
    "<Key>Right: map-step(n)\n"
    "<Key>Left: map-step(p)\n"
    "<Key>Up: map-step(u)\n"
    "<Key>Down: map-step(d)\n";

/* Widget methods */

static void Initialize(Widget request, Widget created, ArgList args, Cardinal *count) {
    (void)request; (void)args; (void)count;
    MapWidget w = (MapWidget)created;
    w->map.zoom = 1.0;
    w->map.selected = -1;
    if (w->core.width == 0) w->core.width = 900;
    if (w->core.height == 0) w->core.height = 560;
}

static void Realize(Widget widget, XtValueMask *mask, XSetWindowAttributes *attributes) {
    MapWidget w = (MapWidget)widget;
    Display *d = XtDisplay(w);
    int major, minor;
    if (!XRenderQueryExtension(d, &major, &minor)) XtAppError(XtWidgetToApplicationContext(widget), "asys-flow-view needs the X Render extension");
    attributes->bit_gravity = NorthWestGravity;
    *mask |= CWBitGravity;
    XtCreateWindow(widget, InputOutput, CopyFromParent, *mask, attributes);
    Colormap colormap = w->core.colormap;
    XRenderColor paper = parse_color(d, colormap, w->map.paper, "#EFE7D6");
    XRenderColor ink = parse_color(d, colormap, w->map.ink, "#201A12");
    w->map.colors[C_PAPER] = paper;
    w->map.colors[C_INK] = ink;
    w->map.colors[C_RAIL] = mix(ink, paper, 0.45);
    w->map.colors[C_CAMPO] = mix(ink, paper, 0.07);
    w->map.colors[C_VERDE] = parse_color(d, colormap, w->map.verde, "#3E7C5A");
    w->map.colors[C_BLU] = parse_color(d, colormap, w->map.blu, "#2A5CAA");
    w->map.colors[C_ROSSO] = parse_color(d, colormap, w->map.rosso, "#D8402E");
    w->map.colors[C_GIALLO] = parse_color(d, colormap, w->map.giallo, "#EFB02C");
    for (int i = 0; i < 8; i++) w->map.fills[i] = XRenderCreateSolidFill(d, &w->map.colors[i]);
    Visual *visual = DefaultVisualOfScreen(XtScreen(w));
    XRenderColor soft = mix(ink, paper, 0.62);
    XftColorAllocValue(d, visual, colormap, &ink, &w->map.text_ink);
    XftColorAllocValue(d, visual, colormap, &soft, &w->map.text_soft);
    XftColorAllocValue(d, visual, colormap, &paper, &w->map.text_paper);
    XSetWindowBackgroundPixmap(d, XtWindow(w), None);
    load_fonts(w);
    make_buffer(w);
    reflow(w);
}

static void Resize(Widget widget) {
    MapWidget w = (MapWidget)widget;
    if (!XtIsRealized(widget)) return;
    make_buffer(w);
    reflow(w);     /* a different width wraps the run differently */
    show(w);
}

static void Redisplay(Widget widget, XEvent *event, Region region) {
    (void)event; (void)region;
    MapWidget w = (MapWidget)widget;
    if (!w->map.buffer) return;
    XCopyArea(XtDisplay(w), w->map.buffer, XtWindow(w), DefaultGCOfScreen(XtScreen(w)), 0, 0,
              (unsigned)w->map.width, (unsigned)w->map.height, 0, 0);
}

static void Destroy(Widget widget) {
    MapWidget w = (MapWidget)widget;
    Display *d = XtDisplay(w);
    clear_graph(w);
    free(w->map.line_bottom);
    free(w->map.line_top);
    free(w->map.spec);
    free_buffer(w);
    for (int i = 0; i < 8; i++) if (w->map.fills[i]) XRenderFreePicture(d, w->map.fills[i]);
    XftFont *fonts[] = { w->map.sans, w->map.sans_bold, w->map.mono, w->map.mono_bold, w->map.caps };
    for (unsigned i = 0; i < 5; i++) if (fonts[i]) XftFontClose(d, fonts[i]);
}

static Boolean AcceptFocus(Widget widget, Time *time) {
    (void)time;
    if (!XtIsRealized(widget)) return False;
    XSetInputFocus(XtDisplay(widget), XtWindow(widget), RevertToParent, CurrentTime);
    return True;
}

MapClassRec mapClassRec = {
    {
        /* superclass */ (WidgetClass)&widgetClassRec,
        /* class_name */ "Map",
        /* widget_size */ sizeof(MapRec),
        /* class_initialize */ NULL,
        /* class_part_initialize */ NULL,
        /* class_inited */ False,
        /* initialize */ Initialize,
        /* initialize_hook */ NULL,
        /* realize */ Realize,
        /* actions */ actions,
        /* num_actions */ XtNumber(actions),
        /* resources */ resources,
        /* num_resources */ XtNumber(resources),
        /* xrm_class */ NULLQUARK,
        /* compress_motion */ True,
        /* compress_exposure */ XtExposeCompressMultiple,
        /* compress_enterleave */ True,
        /* visible_interest */ False,
        /* destroy */ Destroy,
        /* resize */ Resize,
        /* expose */ Redisplay,
        /* set_values */ NULL,
        /* set_values_hook */ NULL,
        /* set_values_almost */ XtInheritSetValuesAlmost,
        /* get_values_hook */ NULL,
        /* accept_focus */ AcceptFocus,
        /* version */ XtVersion,
        /* callback_private */ NULL,
        /* tm_table */ translations,
        /* query_geometry */ XtInheritQueryGeometry,
        /* display_accelerator */ XtInheritDisplayAccelerator,
        /* extension */ NULL,
    },
    { 0 },
};

WidgetClass mapWidgetClass = (WidgetClass)&mapClassRec;
