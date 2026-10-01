/* Map: the workflow drawn in the style guide's grammar, as an Xt widget. */
#ifndef ASYS_MAP_H
#define ASYS_MAP_H

#include <X11/Intrinsic.h>
#include "json.h"

extern WidgetClass mapWidgetClass;

#define XtNselectCallback "selectCallback"     /* call_data: const char *step path, or NULL */
#define XtNactivateCallback "activateCallback" /* call_data: const char *step path (double click) */
#define XtNconnectCallback "connectCallback"   /* call_data: MapConnection * */
#define XtNsansFont "sansFont"
#define XtNsansBoldFont "sansBoldFont"
#define XtNmonoFont "monoFont"
#define XtNpaper "paper"
#define XtNink "ink"
#define XtNverde "verde"
#define XtNblu "blu"
#define XtNrosso "rosso"
#define XtNgiallo "giallo"
#define XtCFontName "FontName"

typedef struct {
    const char *from, *to;
    const char *key;            /* "next", or "on_error" with Shift held */
} MapConnection;

/* GRAPH is the `graph` of an asys workflow serve reply; the map copies it. */
void MapSetGraph(Widget map, const Json *graph);
/* STATES maps step paths to {state, visits}; NULL leaves editing mode. */
void MapSetStates(Widget map, const Json *states);
/* PROBLEMS is the reply's list; each is shown beside the step it concerns. */
void MapSetProblems(Widget map, const Json *problems);
void MapSelect(Widget map, const char *path);
/* The spec line at the head of the page: name, format, counts. */
void MapSetSpec(Widget map, const char *spec);
const char *MapSelection(Widget map);
void MapZoom(Widget map, double factor);   /* 0: the largest legible zoom at which every line fits */
double MapZoomLevel(Widget map);
void MapSetZoom(Widget map, double zoom);
/* Move the selection along the flow: 'n'ext, 'p'revious, 'u'p, 'd'own. */
void MapStep(Widget map, int direction);
/* Each step path, for the palette; returns how many were written. */
int MapSteps(Widget map, const char **paths, int capacity);

#endif
