#ifndef ASYS_MAPP_H
#define ASYS_MAPP_H

#include <X11/IntrinsicP.h>
#include <X11/CoreP.h>
#include <X11/Xft/Xft.h>
#include <X11/extensions/Xrender.h>
#include "Map.h"

enum { STATE_NONE, STATE_WAITING, STATE_RUNNING, STATE_DONE, STATE_FAILED };

typedef struct {
    char *id, *step, *scope, *kind, *label, *worker, *work, *call;
    double x, y, w, h;          /* grid units, as laid out in one line */
    double lx, ly;              /* grid units once the run wraps into lines */
    int line;
    int box;                    /* group or repeat: drawn as a field */
    int for_each;
    int state, visits;
    char *problem;
} MapNode;

typedef struct {
    int from, to;
    char *role, *label;
    int back;
} MapEdge;

typedef struct { int unused; } MapClassPart;

typedef struct {
    CoreClassPart core_class;
    MapClassPart map_class;
} MapClassRec;

extern MapClassRec mapClassRec;

typedef struct {
    /* resources */
    XtCallbackList select_callback, activate_callback, connect_callback;
    String sans_name, sans_bold_name, mono_name;
    String paper, ink, verde, blu, rosso, giallo;   /* colour names, parsed when realized */
    /* state */
    MapNode *nodes;
    int node_count;
    MapEdge *edges;
    int edge_count;
    double zoom, offset_x, offset_y;   /* pixel = unit * scale * zoom + offset */
    double scroll_x, scroll_y;          /* how far the page is scrolled, in pixels */
    double content_w, content_h;        /* the page, in pixels */
    double *line_top, *line_bottom;     /* each line's edges, in units */
    int line_count;
    int scrolling;                      /* 'v' or 'h' while a scrollbar is dragged */
    char *spec;                         /* the spec line opening the page */
    int selected;
    int states;                         /* a run is shown */
    /* pointer */
    int pressed, dragging, connecting, panning;
    int press_x, press_y, pointer_x, pointer_y;
    double press_offset_x, press_offset_y;
    Time last_click;
    /* rendering */
    Pixmap buffer;
    Picture picture;
    XftDraw *draw;
    XftFont *sans, *sans_bold, *mono, *mono_bold, *caps;
    XRenderColor colors[8];
    Picture fills[8];
    XftColor text_ink, text_soft, text_paper;
    int width, height;
} MapPart;

typedef struct {
    CorePart core;
    MapPart map;
} MapRec, *MapWidget;

#endif
