/*
 * asys-flow-view: view and edit workflow files, and follow runs, on X11.
 *
 *   asys-flow-view [--environment DIR] FILE.yaml
 *   asys-flow-view --run RUN [--root DIR]
 *
 * The model is `asys workflow serve`: this program sends it requests and
 * draws what it returns. Windows, menus, lists and text fields are the stock
 * Athena widgets; the map is the one custom widget. Nothing is modal: prompts
 * and the command palette (/) use the line at the bottom, and validation
 * problems appear beside the steps they concern.
 */
#define _GNU_SOURCE   /* vasprintf, open_memstream, strndup */
#include <X11/Intrinsic.h>
#include <X11/StringDefs.h>
#include <X11/Shell.h>
#include <X11/Xaw/AsciiText.h>
#include <X11/Xaw/Box.h>
#include <X11/Xaw/Form.h>
#include <X11/Xaw/Label.h>
#include <X11/Xaw/List.h>
#include <X11/Xaw/MenuButton.h>
#include <X11/Xaw/Paned.h>
#include <X11/Xaw/SimpleMenu.h>
#include <X11/Xaw/SmeBSB.h>
#include <X11/Xaw/SmeLine.h>
#include <X11/Xaw/Viewport.h>

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "Map.h"
#include "json.h"
#include "service.h"

#define MAX_ROWS 128
#define MAX_ITEMS 512
#define PALETTE_ROWS 14

typedef enum { MINI_NONE, MINI_PALETTE, MINI_RENAME, MINI_ADD, MINI_CONNECT, MINI_ON_ERROR, MINI_FIELD } MiniMode;

typedef struct {
    char *key;              /* dotted path inside the step */
    Json *value;            /* the value shown, to keep its type on commit */
    Widget label, text;
} Row;

static struct {
    XtAppContext app;
    Widget top, paned, bar, title, status, split, map, side, heading, fields_view, fields, details, yaml;
    Widget problems_view, problems, mini, prompt, entry, palette, matches;
    char *file, *environment, *run, *root;
    int run_mode, dirty, can_undo, can_redo, quit_armed, yaml_shown;
    char *selected;
    Row rows[MAX_ROWS];
    int row_count;
    MiniMode mini_mode;
    char *items[MAX_ITEMS];           /* palette entries: "step PATH" or a command name */
    String labels[MAX_ITEMS + 1];
    int item_count, shown;           /* shown: the first matches, which the list displays */
    String problem_lines[MAX_ITEMS + 1];
    char *problem_steps[MAX_ITEMS];
    int problem_count;
    char settings[1024];
} v;

/* Utilities */

static char *format(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char *text = NULL;
    if (vasprintf(&text, fmt, args) < 0) { perror("asys-flow-view"); exit(1); }
    va_end(args);
    return text;
}

static void status(const char *fmt, ...) {
    char text[512];
    va_list args;
    va_start(args, fmt);
    vsnprintf(text, sizeof text, fmt, args);
    va_end(args);
    XtVaSetValues(v.status, XtNlabel, text, NULL);
}

static const char *base_name(const char *path) {
    const char *slash = strrchr(path, '/');
    return slash ? slash + 1 : path;
}

/* Keyboard focus goes to TEXT, or back to the map; only the focused text
 * field shows its caret. */
static Widget focused;

static void focus(Widget text) {
    if (focused && focused != text) XtVaSetValues(focused, XtNdisplayCaret, False, NULL);
    focused = text;
    if (text) XtVaSetValues(text, XtNdisplayCaret, True, NULL);
    XtSetKeyboardFocus(v.top, text ? text : v.map);
}

static Json *request(const char *op) {
    Json *r = json_object();
    json_set(r, "op", json_string(op));
    return r;
}

static int failed(const Json *reply) {
    if (json_get_bool(reply, "ok")) return 0;
    const char *error = json_get_string(reply, "error");
    status("%s", error ? error : "the request failed");
    return 1;
}

/* Rendering a reply */

static void inspect(void);

static void show_title(void) {
    char text[512];
    const char *name = v.run_mode ? v.run : v.file ? base_name(v.file) : "no file";
    snprintf(text, sizeof text, "%s%s", name, v.dirty ? "   (unsaved)" : "");
    XtVaSetValues(v.title, XtNlabel, text, NULL);
    char window[600];
    snprintf(window, sizeof window, "asys - %s%s", name, v.dirty ? " *" : "");
    XtVaSetValues(v.top, XtNtitle, window, NULL);
}

static void show_problems(const Json *problems) {
    for (int i = 0; i < v.problem_count; i++) { free(v.problem_lines[i]); free(v.problem_steps[i]); }
    v.problem_count = 0;
    for (size_t i = 0; problems && i < problems->count && v.problem_count < MAX_ITEMS; i++) {
        const Json *p = json_at(problems, i);
        const char *file = json_get_string(p, "file"), *at = json_get_string(p, "at"), *message = json_get_string(p, "message");
        v.problem_lines[v.problem_count] = format("%s  %s  %s", file ? base_name(file) : "", at ? at : "", message ? message : "");
        v.problem_steps[v.problem_count] = NULL;
        if (at && !strncmp(at, "steps.", 6)) {   /* the step a problem names, for selecting it */
            char path[256];
            snprintf(path, sizeof path, "%s", at + 6);
            char *dot = strchr(path, '.');
            if (dot) *dot = 0;
            v.problem_steps[v.problem_count] = strdup(path);
        }
        v.problem_count++;
    }
    if (!v.problem_count) v.problem_lines[v.problem_count++] = strdup("No problems.");
    v.problem_lines[v.problem_count] = NULL;
    XawListChange(v.problems, (const char **)v.problem_lines, v.problem_count, 0, True);
    MapSetProblems(v.map, problems);
}

static void apply_state(const Json *reply, void *data) {
    (void)data;
    if (failed(reply)) return;
    const Json *graph = json_get(reply, "graph");
    if (graph) {
        MapSetGraph(v.map, graph);
        if (v.selected) MapSelect(v.map, v.selected);   /* the selection survives edits, and follows a rename */
    }
    if (json_get(reply, "problems")) show_problems(json_get(reply, "problems"));
    v.dirty = json_get_bool(reply, "dirty");
    v.can_undo = json_get_bool(reply, "canUndo");
    v.can_redo = json_get_bool(reply, "canRedo");
    const char *text = json_get_string(reply, "text");
    if (text) XtVaSetValues(v.yaml, XtNstring, text, NULL);
    show_title();
    if (v.selected && !MapSelection(v.map)) { free(v.selected); v.selected = NULL; }
    inspect();
}

static void edit_reply(const Json *reply, void *data) {
    if (json_get_bool(reply, "ok")) { status("%s", (const char *)data); v.quit_armed = 0; }
    apply_state(reply, NULL);
}

static void send_edit(Json *r, const char *done) { service_send(r, edit_reply, (void *)done); }

/* Inspector */

/* Rows are a pool: a realized Form lays out reliably only children it keeps,
 * so rows are reused and unmanaged, never destroyed. */
static int pooled;

static void clear_rows(void) {
    for (int i = 0; i < v.row_count; i++) {
        free(v.rows[i].key);
        json_free(v.rows[i].value);
        v.rows[i].key = NULL;
        v.rows[i].value = NULL;
        if (focused == v.rows[i].text) focus(NULL);
    }
    v.row_count = 0;
}

static void show_rows(void) {
    for (int i = 0; i < pooled; i++) {
        if (i < v.row_count) { XtManageChild(v.rows[i].label); XtManageChild(v.rows[i].text); }
        else { XtUnmanageChild(v.rows[i].label); XtUnmanageChild(v.rows[i].text); }
    }
}

static char *value_text(const Json *value) {
    if (value->type == JSON_STRING) return strdup(value->string);
    return json_write(value);
}

static char field_keys[];

static void add_row(const char *key, const Json *value) {
    if (v.row_count >= MAX_ROWS) return;
    Row *row = &v.rows[v.row_count];
    row->key = strdup(key);
    char *shown = value_text(value), *written = json_write(value);
    const char *error;
    row->value = json_parse(written, &error);              /* a private copy */
    free(written);
    if (v.row_count == pooled) {
        Widget above = pooled ? v.rows[pooled - 1].text : NULL;
        row->label = XtVaCreateWidget("key", labelWidgetClass, v.fields, XtNfromVert, above, XtNwidth, 120, XtNresize, False,
                                      XtNjustify, XtJustifyLeft, XtNleft, XtChainLeft, XtNright, XtChainLeft, NULL);
        row->text = XtVaCreateWidget("value", asciiTextWidgetClass, v.fields, XtNfromVert, above, XtNfromHoriz, row->label,
                                     XtNeditType, XawtextEdit, XtNwidth, 260, XtNdisplayCaret, False,
                                     XtNleft, XtChainLeft, XtNright, XtChainRight, NULL);
        static XtTranslations keys;
        if (!keys) keys = XtParseTranslationTable(field_keys);
        XtOverrideTranslations(row->text, keys);
        pooled++;
    }
    XtVaSetValues(row->label, XtNlabel, key, NULL);
    XtVaSetValues(row->text, XtNstring, shown, NULL);
    free(shown);
    v.row_count++;
}

static void flatten(const char *prefix, const Json *value) {
    if (value->type == JSON_OBJECT && value->count && *prefix) {
        for (size_t i = 0; i < value->count; i++) {
            char *key = format("%s.%s", prefix, value->keys[i]);
            flatten(key, value->items[i]);
            free(key);
        }
        return;
    }
    if (value->type == JSON_OBJECT && !*prefix) {
        for (size_t i = 0; i < value->count; i++) flatten(value->keys[i], value->items[i]);
        return;
    }
    add_row(prefix, value);
}

static void show_details(const char *text) {
    XtVaSetValues(v.details, XtNstring, text, NULL);
}

static void inspected(const Json *reply, void *data) {
    (void)data;
    clear_rows();
    if (!json_get_bool(reply, "ok")) { show_rows(); return; }
    const Json *fields = json_get(reply, "data");
    if (fields) flatten("", fields);
    Json *blank = json_string("");
    add_row("+ field", blank);              /* a new key: type key=value */
    json_free(blank);
    show_rows();
}

/* Run mode: the step's jobs, results and log ends. */
static void step_details(const Json *reply, void *data) {
    (void)data;
    if (!json_get_bool(reply, "ok")) { show_details(json_get_string(reply, "error")); return; }
    size_t size = 0;
    char *text = NULL;
    FILE *out = open_memstream(&text, &size);
    const Json *state = json_get(reply, "state");
    fprintf(out, "%s\nstate: %s", json_get_string(reply, "step"), json_get_string(state, "state"));
    int visits = (int)json_get_number(state, "visits", 0);
    if (visits > 1) fprintf(out, ", run %d times", visits);
    fprintf(out, "\n");
    const Json *jobs = json_get(reply, "jobs");
    if (!jobs || !jobs->count) fprintf(out, "\nNo jobs.\n");
    for (size_t i = 0; jobs && i < jobs->count; i++) {
        const Json *job = json_at(jobs, i);
        fprintf(out, "\njob %s  %s  %s", json_get_string(job, "id"), json_get_string(job, "type"), json_get_string(job, "status"));
        if (json_get(job, "item") && json_get(job, "item")->type == JSON_NUMBER) fprintf(out, "  item %d", (int)json_get_number(job, "item", 0));
        const char *elapsed = json_get_string(job, "elapsed");
        if (elapsed) fprintf(out, "  %s", elapsed);
        fprintf(out, "\n");
        const Json *result = json_get(job, "result");
        if (result && result->type != JSON_NULL) { char *r = json_write(result); fprintf(out, "result: %s\n", r); free(r); }
        const char *streams[] = { "stdout", "stderr" };
        for (int s = 0; s < 2; s++) {
            const Json *lines = json_get(job, streams[s]);
            if (!lines || !lines->count) continue;
            fprintf(out, "%s:\n", streams[s]);
            for (size_t k = 0; k < lines->count; k++) fprintf(out, "  %s\n", json_at(lines, k)->string);
        }
    }
    fclose(out);
    show_details(text);
    free(text);
}

static void inspect(void) {
    const char *selected = MapSelection(v.map);
    char heading[300];
    snprintf(heading, sizeof heading, "%s", selected ? selected : v.run_mode ? "Select a step" : "Select a step to edit it");
    XtVaSetValues(v.heading, XtNlabel, heading, NULL);
    if (!selected) { clear_rows(); if (v.fields) show_rows(); show_details(""); return; }
    Json *r = request(v.run_mode ? "step" : "inspect");
    json_set(r, "step", json_string(selected));
    service_send(r, v.run_mode ? step_details : inspected, NULL);
}

/* Commit an inspector field: keep the value's type where the text allows. */
static Json *typed(const char *text, const Json *before) {
    const char *error;
    if (before && before->type == JSON_STRING) return json_string(text);
    Json *parsed = json_parse(text, &error);
    return parsed ? parsed : json_string(text);
}

static void commit(Widget text) {
    const char *selected = MapSelection(v.map);
    if (!selected || v.run_mode) return;
    for (int i = 0; i < v.row_count; i++) {
        if (v.rows[i].text != text) continue;
        String value;
        XtVaGetValues(text, XtNstring, &value, NULL);
        Json *r = request("set");
        json_set(r, "step", json_string(selected));
        if (!strcmp(v.rows[i].key, "+ field")) {
            char *equals = strchr(value, '=');
            if (!equals || equals == value) { status("Type key=value to add a field"); json_free(r); return; }
            char *key = strndup(value, (size_t)(equals - value));
            while (*key && isspace((unsigned char)key[strlen(key) - 1])) key[strlen(key) - 1] = 0;
            const char *rest = equals + 1;
            while (isspace((unsigned char)*rest)) rest++;
            json_set(r, "key", json_string(key));
            json_set(r, "value", typed(rest, NULL));
            free(key);
        } else {
            json_set(r, "key", json_string(v.rows[i].key));
            json_set(r, "value", *value ? typed(value, v.rows[i].value) : json_null());   /* empty removes */
        }
        send_edit(r, "Changed.");
        return;
    }
}

/* Minibuffer and palette */

static const char *COMMANDS[] = {
    "save", "undo", "redo", "add step after", "rename step", "remove step", "connect next",
    "connect on_error", "open called workflow", "fit", "zoom in", "zoom out", "toggle yaml", "quit", NULL,
};

static void mini_close(void) {
    v.mini_mode = MINI_NONE;
    XtPopdown(v.palette);
    XtVaSetValues(v.prompt, XtNlabel, "/ commands and steps", NULL);
    XtVaSetValues(v.entry, XtNstring, "", NULL);
    focus(NULL);
}

/* How well CANDIDATE matches QUERY, lower is better, or -1: the query as one
 * piece beats its letters starting words, which beat letters anywhere in order. */
static int score(const char *candidate, const char *query) {
    char wanted[128];
    size_t n = 0;
    for (const char *q = query; *q && n + 1 < sizeof wanted; q++)
        if (!isspace((unsigned char)*q)) wanted[n++] = (char)tolower((unsigned char)*q);
    wanted[n] = 0;
    if (!n) return 0;
    const char *found = strcasestr(candidate, wanted);
    if (found) return (int)(found - candidate) + (found == candidate || !isalnum((unsigned char)found[-1]) ? 0 : 100);
    int starts = 1, gaps = 0;
    const char *c = candidate;
    for (const char *q = wanted; *q; q++) {
        const char *before = c;
        while (*c && tolower((unsigned char)*c) != *q) c++;
        if (!*c) return -1;
        if (c != before) gaps++;
        if (c != candidate && isalnum((unsigned char)c[-1]) && c != before) starts = 0;
        c++;
    }
    return (starts ? 200 : 400) + gaps;
}

static int by_score(const void *a, const void *b) {
    const int *x = a, *y = b;
    return x[0] != y[0] ? x[0] - y[0] : x[1] - y[1];
}

static void palette_fill(const char *query) {
    for (int i = 0; i < v.item_count; i++) free(v.items[i]);
    v.item_count = 0;
    const char *steps[MAX_ITEMS];
    int count = MapSteps(v.map, steps, MAX_ITEMS);
    int ranks[MAX_ITEMS][2];   /* score, order of appearance */
    if (v.mini_mode == MINI_PALETTE)
        for (int i = 0; COMMANDS[i] && v.item_count < MAX_ITEMS; i++) {
            int s = score(COMMANDS[i], query);
            if (s < 0 || (v.run_mode && strcmp(COMMANDS[i], "fit") && strncmp(COMMANDS[i], "zoom", 4) && strcmp(COMMANDS[i], "quit")))
                continue;
            ranks[v.item_count][0] = s; ranks[v.item_count][1] = v.item_count;
            v.items[v.item_count++] = strdup(COMMANDS[i]);
        }
    if (v.mini_mode == MINI_PALETTE || v.mini_mode == MINI_CONNECT || v.mini_mode == MINI_ON_ERROR)
        for (int i = 0; i < count && v.item_count < MAX_ITEMS; i++) {
            const char *name = strrchr(steps[i], '/');   /* a step is found by its own name first */
            int s = score(name ? name + 1 : steps[i], query), whole = score(steps[i], query);
            if (s < 0 || (whole >= 0 && whole < s)) s = whole;
            if (s < 0) continue;
            ranks[v.item_count][0] = s; ranks[v.item_count][1] = v.item_count;
            v.items[v.item_count++] = format("step %s", steps[i]);
        }
    qsort(ranks, (size_t)v.item_count, sizeof ranks[0], by_score);
    char *ordered[MAX_ITEMS];
    for (int i = 0; i < v.item_count; i++) ordered[i] = v.items[ranks[i][1]];
    memcpy(v.items, ordered, sizeof(char *) * (size_t)v.item_count);
    v.shown = v.item_count < PALETTE_ROWS ? v.item_count : PALETTE_ROWS;
    for (int i = 0; i < v.shown; i++) v.labels[i] = v.items[i];
    v.labels[v.shown] = NULL;
    if (!v.shown) { v.labels[0] = "(nothing matches)"; v.labels[1] = NULL; }
    XawListChange(v.matches, (const char **)v.labels, v.shown ? v.shown : 1, 0, True);
    if (v.shown) XawListHighlight(v.matches, 0);
    /* Sit on the prompt line, sized to the matches. */
    XFontStruct *font;
    Dimension spacing, inner, width = 420, height;
    Position x, y;
    XtVaGetValues(v.matches, XtNfont, &font, XtNrowSpacing, &spacing, XtNinternalHeight, &inner, NULL);
    for (int i = 0; i < (v.shown ? v.shown : 1); i++) {
        int text = XTextWidth(font, v.labels[i], (int)strlen(v.labels[i])) + 40;
        if (text > width) width = (Dimension)text;
    }
    height = (Dimension)((v.shown ? v.shown : 1) * (font->ascent + font->descent + spacing) + 2 * inner + 4);
    XtTranslateCoords(v.entry, 0, 0, &x, &y);
    XtVaSetValues(v.palette, XtNx, x, XtNy, (Position)(y - height - 4), XtNwidth, width, XtNheight, height, NULL);
}

static void mini_open(MiniMode mode, const char *prompt, const char *initial) {
    v.mini_mode = mode;
    XtVaSetValues(v.prompt, XtNlabel, prompt, NULL);
    XtVaSetValues(v.entry, XtNstring, initial ? initial : "", NULL);
    XawTextSetInsertionPoint(v.entry, initial ? (XawTextPosition)strlen(initial) : 0);
    if (mode == MINI_PALETTE || mode == MINI_CONNECT || mode == MINI_ON_ERROR) {
        palette_fill(initial ? initial : "");
        XtPopup(v.palette, XtGrabNone);
    }
    focus(v.entry);
}

static void text_changed(Widget source, XtPointer client, XtPointer call) {
    (void)source; (void)client; (void)call;
    if (v.mini_mode != MINI_PALETTE && v.mini_mode != MINI_CONNECT && v.mini_mode != MINI_ON_ERROR) return;
    String query;
    XtVaGetValues(v.entry, XtNstring, &query, NULL);
    palette_fill(query);
}

static void command(const char *name);

static void select_step(const char *path) {
    MapSelect(v.map, path);
    free(v.selected);
    v.selected = path ? strdup(path) : NULL;
    inspect();
}

static const char *scope_of(const char *path, char *buffer, size_t size) {
    snprintf(buffer, size, "%s", path);
    char *slash = strrchr(buffer, '/');
    if (slash) *slash = 0; else *buffer = 0;
    return buffer;
}

static void mini_accept(void) {
    String text;
    XtVaGetValues(v.entry, XtNstring, &text, NULL);
    char *value = strdup(text);
    const char *selected = MapSelection(v.map);
    MiniMode mode = v.mini_mode;
    const char *choice = NULL;
    if (mode == MINI_PALETTE || mode == MINI_CONNECT || mode == MINI_ON_ERROR) {
        XawListReturnStruct *current = XawListShowCurrent(v.matches);
        int index = current && current->list_index != XAW_LIST_NONE ? current->list_index : 0;
        choice = index < v.item_count ? v.items[index] : NULL;
        if (!choice) { status("Nothing matches %s", value); free(value); return; }
        choice = strdup(choice);
    }
    mini_close();
    if (mode == MINI_PALETTE) {
        if (!strncmp(choice, "step ", 5)) select_step(choice + 5);
        else command(choice);
    } else if ((mode == MINI_CONNECT || mode == MINI_ON_ERROR) && selected && !strncmp(choice, "step ", 5)) {
        char scope[256];
        const char *target = choice + 5, *name = strrchr(target, '/');
        Json *r = request("connect");
        json_set(r, "step", json_string(selected));
        json_set(r, "key", json_string(mode == MINI_CONNECT ? "next" : "on_error"));
        json_set(r, "to", json_string(name ? name + 1 : target));
        (void)scope;
        send_edit(r, mode == MINI_CONNECT ? "Connected." : "Error path set.");
    } else if (mode == MINI_RENAME && selected) {
        Json *r = request("rename");
        json_set(r, "step", json_string(selected));
        json_set(r, "to", json_string(value));
        send_edit(r, "Renamed; references follow.");
        char scope[256];
        scope_of(selected, scope, sizeof scope);
        free(v.selected);
        v.selected = *scope ? format("%s/%s", scope, value) : strdup(value);
        MapSelect(v.map, v.selected);
    } else if (mode == MINI_ADD) {
        /* NAME [WORKER]: a run step after the selection, continuing where it continued. */
        char name[128] = "", worker[128] = "";
        sscanf(value, "%127s %127s", name, worker);
        char scope[256] = "";
        if (selected) scope_of(selected, scope, sizeof scope);
        Json *step = json_object();
        if (*worker) json_set(step, "run", json_string(worker));
        else json_set(step, "end", json_string(name));
        Json *r = request("add");
        json_set(r, "scope", json_string(scope));
        json_set(r, "name", json_string(name));
        json_set(r, "step", step);
        send_edit(r, *worker ? "Added." : "Added an end; give it a worker with run to make it a step.");
        if (selected) {
            Json *c = request("connect");
            json_set(c, "step", json_string(selected));
            json_set(c, "key", json_string("next"));
            json_set(c, "to", json_string(name));
            send_edit(c, "Added after the selection.");
        }
    }
    free((void *)choice);
    free(value);
}

/* Commands */

static void reload_reply(const Json *reply, void *data) { apply_state(reply, data); }

static void command(const char *name) {
    const char *selected = MapSelection(v.map);
    if (!strcmp(name, "fit")) { MapZoom(v.map, 0); return; }
    if (!strcmp(name, "zoom in")) { MapZoom(v.map, 1.2); return; }
    if (!strcmp(name, "zoom out")) { MapZoom(v.map, 1 / 1.2); return; }
    if (!strcmp(name, "toggle yaml")) {
        v.yaml_shown = !v.yaml_shown;
        if (v.yaml_shown) XtManageChild(v.yaml); else XtUnmanageChild(v.yaml);
        return;
    }
    if (!strcmp(name, "quit")) {
        if (v.dirty && !v.quit_armed) { v.quit_armed = 1; status("Unsaved changes: quit again to discard them, or save."); return; }
        FILE *out = fopen(v.settings, "w");
        if (out) {
            Dimension width, height;
            XtVaGetValues(v.top, XtNwidth, &width, XtNheight, &height, NULL);
            fprintf(out, "%u %u %.3f\n", width, height, MapZoomLevel(v.map));
            fclose(out);
        }
        exit(0);
    }
    if (v.run_mode) { status("A run is read-only."); return; }
    if (!strcmp(name, "save")) { send_edit(request("save"), "Saved."); return; }
    if (!strcmp(name, "undo")) { if (v.can_undo) send_edit(request("undo"), "Undone."); else status("Nothing to undo."); return; }
    if (!strcmp(name, "redo")) { if (v.can_redo) send_edit(request("redo"), "Redone."); else status("Nothing to redo."); return; }
    if (!strcmp(name, "add step after")) { mini_open(MINI_ADD, "New step: NAME WORKER", ""); return; }
    if (!selected) { status("Select a step first."); return; }
    if (!strcmp(name, "rename step")) { mini_open(MINI_RENAME, "Rename to:", strrchr(selected, '/') ? strrchr(selected, '/') + 1 : selected); return; }
    if (!strcmp(name, "connect next")) { mini_open(MINI_CONNECT, "Continue at:", ""); return; }
    if (!strcmp(name, "connect on_error")) { mini_open(MINI_ON_ERROR, "On error continue at:", ""); return; }
    if (!strcmp(name, "remove step")) {
        Json *r = request("remove");
        json_set(r, "step", json_string(selected));
        send_edit(r, "Removed; undo restores it.");
        return;
    }
    if (!strcmp(name, "open called workflow")) {
        status("Double-click a call step to open the file it calls.");
        return;
    }
}

/* Callbacks */

static void map_selected(Widget w, XtPointer client, XtPointer call) {
    (void)w; (void)client;
    free(v.selected);
    v.selected = call ? strdup((const char *)call) : NULL;
    inspect();
}

static void called_reply(const Json *reply, void *data) {
    const char *file = data;
    if (!json_get_bool(reply, "ok")) { failed(reply); return; }
    const char *call = json_get_string(json_get(reply, "data"), "call");
    if (!call) { free((void *)file); return; }
    char directory[1024];
    snprintf(directory, sizeof directory, "%s", file);
    char *slash = strrchr(directory, '/');
    if (slash) *slash = 0; else strcpy(directory, ".");
    char *path = format("%s/%s", directory, call);
    free(v.file);
    v.file = path;
    Json *r = request("load");
    json_set(r, "file", json_string(path));
    if (v.environment) json_set(r, "environment", json_string(v.environment));
    service_send(r, reload_reply, NULL);
    status("Opened %s; the file that calls it is unchanged.", call);
    free((void *)file);
}

static void map_activated(Widget w, XtPointer client, XtPointer call) {
    (void)w; (void)client;
    if (v.run_mode || !v.file) return;
    if (v.dirty) { status("Save before opening another file."); return; }
    Json *r = request("inspect");
    json_set(r, "step", json_string((const char *)call));
    service_send(r, called_reply, strdup(v.file));
}

static void map_connected(Widget w, XtPointer client, XtPointer call) {
    (void)w; (void)client;
    const MapConnection *c = call;
    if (v.run_mode) return;
    const char *name = strrchr(c->to, '/');
    Json *r = request("connect");
    json_set(r, "step", json_string(c->from));
    json_set(r, "key", json_string(c->key));
    json_set(r, "to", json_string(name ? name + 1 : c->to));
    send_edit(r, !strcmp(c->key, "next") ? "Connected." : "Error path set.");
}

static void problem_chosen(Widget w, XtPointer client, XtPointer call) {
    (void)w; (void)client;
    XawListReturnStruct *chosen = call;
    if (chosen->list_index >= 0 && chosen->list_index < v.problem_count && v.problem_steps[chosen->list_index])
        select_step(v.problem_steps[chosen->list_index]);
}

static void match_chosen(Widget w, XtPointer client, XtPointer call) {
    (void)w; (void)client; (void)call;
    mini_accept();
}

static void menu_chosen(Widget w, XtPointer client, XtPointer call) {
    (void)w; (void)call;
    command((const char *)client);
}

static void lost(const char *why) {
    status("%s; restart asys-flow-view to continue.", why);
}

static void poll_reply(const Json *reply, void *data) {
    (void)data;
    if (!json_get_bool(reply, "ok")) { failed(reply); return; }
    const Json *graph = json_get(reply, "graph");
    if (graph) MapSetGraph(v.map, graph);
    MapSetStates(v.map, json_get(reply, "states"));
    const Json *run = json_get(reply, "run");
    const char *state = json_get_string(run, "status"), *error = json_get_string(run, "error");
    char text[512];
    snprintf(text, sizeof text, "%s%s%s", state ? state : "", error && *error ? ": " : "", error ? error : "");
    XtVaSetValues(v.status, XtNlabel, text, NULL);
    const char *name = json_get_string(run, "name");
    if (name) { free(v.run); v.run = strdup(name); show_title(); }
    if (MapSelection(v.map)) inspect();
}

static void poll(XtPointer client, XtIntervalId *id) {
    (void)client; (void)id;
    if (!service_pending()) service_send(request("poll"), poll_reply, NULL);
    XtAppAddTimeOut(v.app, 1500, poll, NULL);
}

/* Actions bound to keys */

static void Command(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)w; (void)e;
    if (*count) command(params[0]);
}

static void Palette(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)w; (void)e; (void)params; (void)count;
    mini_open(MINI_PALETTE, "Go to:", "");
}

static void MiniAccept(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)w; (void)e; (void)params; (void)count;
    if (v.mini_mode != MINI_NONE) mini_accept();
}

static void MiniCancel(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)w; (void)e; (void)params; (void)count;
    mini_close();
    status("");
}

static void MiniMove(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)w; (void)e;
    if (!*count || !v.shown) return;
    XawListReturnStruct *current = XawListShowCurrent(v.matches);
    int index = current && current->list_index != XAW_LIST_NONE ? current->list_index : 0;
    index += !strcmp(params[0], "up") ? -1 : 1;
    if (index < 0) index = 0;
    if (index >= v.shown) index = v.shown - 1;
    XawListHighlight(v.matches, index);
}

static void FieldCommit(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)e; (void)params; (void)count;
    commit(w);
}

static void FieldLeave(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)w; (void)e; (void)params; (void)count;
    focus(NULL);
}

static void FocusInspector(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)w; (void)e; (void)params; (void)count;
    if (v.row_count) focus(v.rows[0].text);
}

static void FieldNext(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)e; (void)params; (void)count;
    for (int i = 0; i < v.row_count; i++)
        if (v.rows[i].text == w) { focus(v.rows[(i + 1) % v.row_count].text); return; }
}

static XtActionsRec actions[] = {
    { "command", Command }, { "palette", Palette }, { "mini-accept", MiniAccept }, { "mini-cancel", MiniCancel },
    { "mini-move", MiniMove }, { "field-commit", FieldCommit }, { "field-leave", FieldLeave },
    { "focus-inspector", FocusInspector }, { "field-next", FieldNext },
};

static String fallback[] = {
    "AsysFlowView*background: #EFE7D6",
    "AsysFlowView*foreground: #201A12",
    "AsysFlowView*borderWidth: 0",
    "AsysFlowView*font: -adobe-helvetica-medium-r-normal--12-*-*-*-p-*-iso8859-1",
    "AsysFlowView*Text*font: -adobe-courier-medium-r-normal--12-*-*-*-m-*-iso8859-1",
    "AsysFlowView*Text*background: #EFE7D6",
    "AsysFlowView*Text*borderWidth: 0",
    "AsysFlowView*Paned.internalBorderWidth: 1",
    "AsysFlowView*Paned.internalBorderColor: #9B9384",
    "AsysFlowView*showGrip: False",
    "AsysFlowView*bar.background: #201A12",
    "AsysFlowView*bar*background: #201A12",
    "AsysFlowView*bar*foreground: #EFE7D6",
    "AsysFlowView*bar.hSpace: 14",
    "AsysFlowView*bar.vSpace: 6",
    "AsysFlowView*bar*font: -adobe-helvetica-bold-r-normal--12-*-*-*-p-*-iso8859-1",
    "AsysFlowView*bar.title.font: -adobe-helvetica-medium-r-normal--12-*-*-*-p-*-iso8859-1",
    "AsysFlowView*SimpleMenu*background: #EFE7D6",
    "AsysFlowView*SimpleMenu*foreground: #201A12",
    "AsysFlowView*SimpleMenu.borderWidth: 1",
    "AsysFlowView*SimpleMenu*leftMargin: 14",
    "AsysFlowView*SimpleMenu*rightMargin: 14",
    "AsysFlowView*SimpleMenu*font: -adobe-helvetica-medium-r-normal--12-*-*-*-p-*-iso8859-1",
    "AsysFlowView*side*background: #E1D9C8",
    "AsysFlowView*side*Text*background: #E1D9C8",
    "AsysFlowView*side.heading.font: -adobe-helvetica-bold-r-normal--14-*-*-*-p-*-iso8859-1",
    "AsysFlowView*side.heading.internalHeight: 10",
    "AsysFlowView*fields*key.foreground: #6E675B",
    "AsysFlowView*fields.defaultDistance: 6",
    "AsysFlowView*problems*font: -adobe-helvetica-medium-r-normal--12-*-*-*-p-*-iso8859-1",
    "AsysFlowView*problems.background: #EFE7D6",
    "AsysFlowView*mini.background: #E1D9C8",
    "AsysFlowView*mini*background: #E1D9C8",
    "AsysFlowView*prompt.font: -adobe-helvetica-bold-r-normal--12-*-*-*-p-*-iso8859-1",
    "AsysFlowView*matches.defaultColumns: 1",
    "AsysFlowView*matches.forceColumns: True",
    "AsysFlowView*List.highlightColor: #3E7C5A",
    NULL,
};

static char map_keys[] =
    "<Key>slash: palette()\n"
    "Ctrl<Key>s: command(save)\n"
    "Ctrl Shift<Key>z: command(redo)\n"
    "Ctrl<Key>z: command(undo)\n"
    "Ctrl<Key>y: command(redo)\n"
    "<Key>u: command(undo)\n"
    "<Key>a: command(\"add step after\")\n"
    "<Key>r: command(\"rename step\")\n"
    "<Key>c: command(\"connect next\")\n"
    "<Key>e: command(\"connect on_error\")\n"
    "<Key>Delete: command(\"remove step\")\n"
    "<Key>x: command(\"remove step\")\n"
    "<Key>plus: command(\"zoom in\")\n"
    "<Key>equal: command(\"zoom in\")\n"
    "<Key>minus: command(\"zoom out\")\n"
    "<Key>0: command(fit)\n"
    "<Key>y: command(\"toggle yaml\")\n"
    "<Key>q: command(quit)\n"
    "<Key>Return: focus-inspector()\n";

static char entry_keys[] =
    "<Key>Return: mini-accept()\n"
    "<Key>Escape: mini-cancel()\n"
    "<Key>Up: mini-move(up)\n"
    "<Key>Down: mini-move(down)\n"
    "Ctrl<Key>g: mini-cancel()\n";

static char field_keys[] =
    "<Key>Return: field-commit() field-leave()\n"
    "<Key>Tab: field-commit() field-next()\n"
    "<Key>Escape: field-leave()\n";

static Widget menu(Widget bar, const char *name, const char *label, const char *const entries[][2]) {
    Widget button = XtVaCreateManagedWidget(name, menuButtonWidgetClass, bar, XtNlabel, label, XtNmenuName, name, NULL);
    Widget shell = XtVaCreatePopupShell(name, simpleMenuWidgetClass, button, NULL);
    for (int i = 0; entries[i][0]; i++) {
        if (!*entries[i][0]) { XtCreateManagedWidget("line", smeLineObjectClass, shell, NULL, 0); continue; }
        Widget item = XtVaCreateManagedWidget(entries[i][1], smeBSBObjectClass, shell, XtNlabel, entries[i][0], NULL);
        XtAddCallback(item, XtNcallback, menu_chosen, (XtPointer)entries[i][1]);
    }
    return button;
}

static void usage(void) {
    fprintf(stderr, "usage: asys-flow-view [--environment DIR] FILE.yaml\n       asys-flow-view --run RUN [--root DIR]\n");
    exit(2);
}

int main(int argc, char **argv) {
    XtSetLanguageProc(NULL, NULL, NULL);
    v.top = XtVaOpenApplication(&v.app, "AsysFlowView", NULL, 0, &argc, argv, fallback, sessionShellWidgetClass,
                                XtNwidth, 1280, XtNheight, 820, NULL);
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--environment") && i + 1 < argc) v.environment = strdup(argv[++i]);
        else if (!strcmp(argv[i], "--run") && i + 1 < argc) v.run = strdup(argv[++i]);
        else if (!strcmp(argv[i], "--root") && i + 1 < argc) v.root = strdup(argv[++i]);
        else if (argv[i][0] == '-') usage();
        else v.file = strdup(argv[i]);
    }
    if (!v.file == !v.run) usage();
    v.run_mode = v.run != NULL;

    const char *home = getenv("HOME");
    snprintf(v.settings, sizeof v.settings, "%s/.config/asys", home ? home : ".");
    mkdir(v.settings, 0700);
    strncat(v.settings, "/flow-view", sizeof v.settings - strlen(v.settings) - 1);
    unsigned width = 0, height = 0;
    double zoom = 0;
    FILE *in = fopen(v.settings, "r");
    if (in) { if (fscanf(in, "%u %u %lf", &width, &height, &zoom) != 3) width = height = 0; fclose(in); }
    if (width > 200 && height > 200) XtVaSetValues(v.top, XtNwidth, width, XtNheight, height, NULL);

    XtAppAddActions(v.app, actions, XtNumber(actions));
    v.paned = XtVaCreateManagedWidget("paned", panedWidgetClass, v.top, XtNorientation, XtorientVertical, NULL);
    v.bar = XtVaCreateManagedWidget("bar", boxWidgetClass, v.paned, XtNorientation, XtorientHorizontal,
                                    XtNshowGrip, False, XtNskipAdjust, True, NULL);
    XtVaCreateManagedWidget("wordmark", labelWidgetClass, v.bar, XtNlabel, "asys", NULL);
    static const char *const file_entries[][2] = { { "Save            Ctrl+S", "save" }, { "", "" },
                                                   { "Quit                  q", "quit" }, { NULL, NULL } };
    static const char *const edit_entries[][2] = { { "Undo        Ctrl+Z", "undo" }, { "Redo        Ctrl+Y", "redo" }, { "", "" },
                                                   { "Add step after       a", "add step after" },
                                                   { "Rename step          r", "rename step" },
                                                   { "Continue at...       c", "connect next" },
                                                   { "On error...          e", "connect on_error" },
                                                   { "Remove step        Del", "remove step" }, { NULL, NULL } };
    static const char *const view_entries[][2] = { { "Fit                  0", "fit" }, { "Zoom in              +", "zoom in" },
                                                   { "Zoom out             -", "zoom out" }, { "", "" },
                                                   { "YAML                 y", "toggle yaml" }, { NULL, NULL } };
    menu(v.bar, "file", "File", file_entries);
    if (!v.run_mode) menu(v.bar, "edit", "Edit", edit_entries);
    menu(v.bar, "view", "View", view_entries);
    v.title = XtVaCreateManagedWidget("title", labelWidgetClass, v.bar, XtNlabel, "", XtNwidth, 360, XtNjustify, XtJustifyLeft, NULL);
    v.status = XtVaCreateManagedWidget("status", labelWidgetClass, v.bar, XtNlabel, "", XtNwidth, 520, XtNjustify, XtJustifyLeft, NULL);

    v.split = XtVaCreateManagedWidget("split", panedWidgetClass, v.paned, XtNorientation, XtorientHorizontal,
                                      XtNshowGrip, False, NULL);
    v.map = XtVaCreateManagedWidget("map", mapWidgetClass, v.split, XtNwidth, 1000, XtNheight, 600, NULL);
    XtOverrideTranslations(v.map, XtParseTranslationTable(map_keys));
    XtAddCallback(v.map, XtNselectCallback, map_selected, NULL);
    XtAddCallback(v.map, XtNactivateCallback, map_activated, NULL);
    XtAddCallback(v.map, XtNconnectCallback, map_connected, NULL);

    v.side = XtVaCreateManagedWidget("side", panedWidgetClass, v.split, XtNorientation, XtorientVertical, XtNwidth, 380,
                                     XtNmin, 240, NULL);
    v.heading = XtVaCreateManagedWidget("heading", labelWidgetClass, v.side, XtNlabel, "", XtNjustify, XtJustifyLeft,
                                        XtNshowGrip, False, XtNskipAdjust, True, NULL);
    if (v.run_mode) {
        v.details = XtVaCreateManagedWidget("details", asciiTextWidgetClass, v.side, XtNscrollVertical, XawtextScrollWhenNeeded,
                                            XtNwrap, XawtextWrapLine, XtNeditType, XawtextRead, XtNstring, "",
                                            XtNdisplayCaret, False, NULL);
    } else {
        v.fields_view = XtVaCreateManagedWidget("fieldsView", viewportWidgetClass, v.side, XtNallowVert, True, XtNheight, 480,
                                                XtNforceBars, False, XtNuseRight, True, NULL);
        v.fields = XtVaCreateManagedWidget("fields", formWidgetClass, v.fields_view, XtNwidth, 390, XtNheight, 40, NULL);
        v.details = XtVaCreateWidget("details", asciiTextWidgetClass, v.side, XtNeditType, XawtextRead, NULL);
    }
    v.yaml = XtVaCreateWidget("yaml", asciiTextWidgetClass, v.side, XtNscrollVertical, XawtextScrollWhenNeeded,
                              XtNpreferredPaneSize, 360, XtNmin, 120,
                              XtNeditType, XawtextRead, XtNstring, "", XtNdisplayCaret, False, NULL);

    v.problems_view = XtVaCreateManagedWidget("problemsView", viewportWidgetClass, v.paned, XtNallowVert, True,
                                              XtNheight, 64, XtNmin, 24, XtNmax, 160, XtNpreferredPaneSize, 64,
                                              XtNskipAdjust, True, XtNshowGrip, False, NULL);
    v.problem_lines[0] = "";
    v.problem_lines[1] = NULL;
    v.problems = XtVaCreateManagedWidget("problems", listWidgetClass, v.problems_view, XtNlist, v.problem_lines,
                                         XtNdefaultColumns, 1, XtNforceColumns, True, XtNverticalList, True, NULL);
    XtAddCallback(v.problems, XtNcallback, problem_chosen, NULL);
    if (v.run_mode) XtUnmanageChild(v.problems_view);   /* a run is not edited: nothing to check */

    v.mini = XtVaCreateManagedWidget("mini", formWidgetClass, v.paned, XtNshowGrip, False, XtNskipAdjust, True, NULL);
    v.prompt = XtVaCreateManagedWidget("prompt", labelWidgetClass, v.mini, XtNlabel, "/ commands and steps",
                                       XtNwidth, 220, XtNjustify, XtJustifyLeft, XtNleft, XtChainLeft, XtNright, XtChainLeft, NULL);
    v.entry = XtVaCreateManagedWidget("entry", asciiTextWidgetClass, v.mini, XtNeditType, XawtextEdit, XtNfromHoriz, v.prompt,
                                      XtNdisplayCaret, False,
                                      XtNwidth, 600, XtNleft, XtChainLeft, XtNright, XtChainRight, NULL);
    XtOverrideTranslations(v.entry, XtParseTranslationTable(entry_keys));
    XtAddCallback(XawTextGetSource(v.entry), XtNcallback, text_changed, NULL);
    /* The palette's matches float above the prompt line, over the map. */
    v.palette = XtVaCreatePopupShell("palette", overrideShellWidgetClass, v.top, XtNborderWidth, 1, NULL);
    v.matches = XtVaCreateManagedWidget("matches", listWidgetClass, v.palette, XtNverticalList, True,
                                        XtNdefaultColumns, 1, XtNforceColumns, True, NULL);
    XtAddCallback(v.matches, XtNcallback, match_chosen, NULL);

    XtRealizeWidget(v.top);
    focus(NULL);

    const char *service = getenv("ASYS_FLOW_SERVICE");
    char *command_line[16] = { "asys", "workflow", "serve", NULL };
    if (service && *service) {   /* e.g. "python3 /src/asys/tools/asys workflow serve" */
        char *words = strdup(service), *save = NULL;
        int n = 0;
        for (char *word = strtok_r(words, " ", &save); word && n < 15; word = strtok_r(NULL, " ", &save)) command_line[n++] = word;
        command_line[n] = NULL;
    }
    if (service_start(v.app, command_line, lost) < 0) { perror("asys-flow-view: asys workflow serve"); return 1; }
    if (v.run_mode) {
        Json *r = request("open");
        json_set(r, "run", json_string(v.run));
        if (v.root) json_set(r, "root", json_string(v.root));
        service_send(r, poll_reply, NULL);
        XtAppAddTimeOut(v.app, 1500, poll, NULL);
    } else {
        Json *r = request("load");
        json_set(r, "file", json_string(v.file));
        if (v.environment) json_set(r, "environment", json_string(v.environment));
        service_send(r, reload_reply, NULL);
        if (v.environment) status("Checked against the %s environment.", base_name(v.environment));
        else status("No environment given: worker types are not checked.");
    }
    if (zoom > 0) MapSetZoom(v.map, zoom);
    show_title();
    XtAppMainLoop(v.app);
    return 0;
}
