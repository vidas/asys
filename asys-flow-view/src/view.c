/*
 * asys-flow-view: view and edit workflow files, and follow runs, on X11.
 *
 *   asys-flow-view [-toolkitoption ...] [-environment dir] file.yaml
 *   asys-flow-view [-toolkitoption ...] -run run [-root dir]
 *
 * Everything that can be a resource is one: see AsysFlowView.ad, which is
 * also compiled in as the fallback, and asys-flow-view(1).
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
#include <X11/Xmu/Editres.h>

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>

#include "Map.h"
#include "json.h"
#include "service.h"
#include "asys.xbm"

#define MAX_ROWS 128
#define MAX_ITEMS 512
#define PALETTE_ROWS 14

typedef enum { MINI_NONE, MINI_PALETTE, MINI_RENAME, MINI_ADD, MINI_CONNECT, MINI_ON_ERROR, MINI_FIELD,
               MINI_RUN, MINI_FOLLOW, MINI_NEW, MINI_OPEN } MiniMode;

typedef struct {
    char *key;              /* dotted path inside the step */
    Json *value;            /* the value shown, to keep its type on commit */
    Widget label, text;
} Row;

static struct {
    XtAppContext app;
    Widget top, paned, bar, split, map, side, about, notes, heading, subheading, fields_view, fields, details;
    Widget issues_title, issues_view, issues, yaml, mini, prompt, entry, palette, matches;
    char *file, *environment, *run, *root;
    int run_mode, dirty, can_undo, can_redo, quit_armed, yaml_shown, panel_hidden;
    Json *problems;                   /* the latest validation, for the panel */
    char message[512];                /* the latest message, on the bottom line */
    char *name;                       /* the workflow's name */
    char run_summary[1024];           /* the run as a whole, for the panel */
    int step_count;
    XFontStruct *mono_heading, *sans_heading;
    char *selected;
    Row rows[MAX_ROWS];
    int row_count;
    MiniMode mini_mode;
    char *items[MAX_ITEMS];           /* palette entries: "step PATH" or a command name */
    String labels[MAX_ITEMS + 1];
    int item_count, shown;           /* shown: the first matches, which the list displays */
    String problem_lines[MAX_ITEMS + 1];
    char *problem_steps[MAX_ITEMS];
    int problem_count, listed;        /* listed: the lines the issues List holds */
} v;

/* The program's own options are resources, as the toolkit's are. */
static struct {
    String environment, run, root, service, workspace;
    XFontStruct *title_font, *step_font;
    Boolean help;
} options;

static void follow(const char *run);
static void start_run(const char *text);
static Json *new_step(const char *line);

/* Utilities */

static char *format(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char *text = NULL;
    if (vasprintf(&text, fmt, args) < 0) { perror("asys-flow-view"); exit(1); }
    va_end(args);
    return text;
}

/* Messages go on the bottom line, where prompts also appear. */
static void status(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vsnprintf(v.message, sizeof v.message, fmt, args);
    va_end(args);
    if (v.prompt && v.mini_mode == MINI_NONE)
        XtVaSetValues(v.prompt, XtNlabel, *v.message ? v.message : "/ finds steps and commands", NULL);
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

/* The file names the window; the spec line heads the page. */
static void show_title(void) {
    const char *file = v.run_mode ? v.run : v.file ? base_name(v.file) : "no file";
    char window[600];
    snprintf(window, sizeof window, "%s%s - asys", file, v.dirty ? " (unsaved)" : "");
    XtVaSetValues(v.top, XtNtitle, window, NULL);
    char spec[600];
    snprintf(spec, sizeof spec, "%s  ·  workflow/1  ·  %d steps  ·  %s%s", v.name ? v.name : "untitled",
             v.step_count, v.run_mode ? "run" : file, v.dirty ? "  ·  unsaved" : "");
    MapSetSpec(v.map, spec);
}

static void count_graph(const Json *graph) {
    free(v.name);
    const char *name = json_get_string(graph, "name");
    v.name = name && *name ? strdup(name) : NULL;
    v.step_count = 0;
    const Json *nodes = json_get(graph, "nodes");
    for (size_t i = 0; nodes && i < nodes->count; i++) {
        const char *kind = json_get_string(json_at(nodes, i), "kind");
        if (kind && strcmp(kind, "group") && strcmp(kind, "repeat")) v.step_count++;
    }
}

/* The step a problem concerns: steps.search.group.steps.local.input is
 * search/local. Problems outside steps concern the file. */
static char *problem_step(const Json *problem) {
    const char *at = json_get_string(problem, "at");
    if (!at || strncmp(at, "steps.", 6)) return NULL;
    char path[256] = "", rest[256];
    snprintf(rest, sizeof rest, "%s", at + 6);
    char *save = NULL, *part = strtok_r(rest, ".", &save);
    int expect = 1;
    while (part) {
        if (expect) {
            if (*path) strncat(path, "/", sizeof path - strlen(path) - 1);
            strncat(path, part, sizeof path - strlen(path) - 1);
            expect = 0;
        } else if (!strcmp(part, "group")) {
            part = strtok_r(NULL, ".", &save);
            expect = part && !strcmp(part, "steps");
        } else if (!strcmp(part, "repeat")) {
            expect = 1;
        } else {
            break;
        }
        part = strtok_r(NULL, ".", &save);
    }
    return strdup(path);
}

/* The panel lists the problems of what it shows: the selected step and the
 * steps inside it, or, with nothing selected, all of them. */
static void show_issues(void) {
    const char *selected = MapSelection(v.map);
    /* The List shows these lines until the next change: they live until then. */
    for (int i = 0; i < v.listed; i++) { free(v.problem_lines[i]); free(v.problem_steps[i]); v.problem_steps[i] = NULL; }
    v.problem_count = 0;
    for (size_t i = 0; v.problems && i < v.problems->count && v.problem_count < MAX_ITEMS; i++) {
        const Json *p = json_at(v.problems, i);
        char *step = problem_step(p);
        size_t length = selected ? strlen(selected) : 0;
        if (selected && !(step && !strncmp(step, selected, length) && (!step[length] || step[length] == '/'))) {
            free(step);
            continue;
        }
        const char *message = json_get_string(p, "message");
        v.problem_lines[v.problem_count] = selected || !step ? strdup(message ? message : "")
                                                             : format("%s: %s", step, message ? message : "");
        v.problem_steps[v.problem_count++] = step;
    }
    char title[64];
    snprintf(title, sizeof title, v.problem_count == 1 ? "1 problem" : "%d problems", v.problem_count);
    XtVaSetValues(v.issues_title, XtNlabel, title, NULL);
    v.listed = v.problem_count;
    if (!v.listed) { v.problem_lines[0] = strdup(""); v.problem_steps[0] = NULL; v.listed = 1; }
    v.problem_lines[v.listed] = NULL;
    XawListChange(v.issues, (const char **)v.problem_lines, v.listed, 0, True);
    /* No problems, no space; otherwise as many lines as there are, up to four. */
    if (!v.problem_count || v.run_mode) {
        XtUnmanageChild(v.issues_title);
        XtUnmanageChild(v.issues_view);
        return;
    }
    XFontStruct *font;
    Dimension spacing;
    XtVaGetValues(v.issues, XtNfont, &font, XtNrowSpacing, &spacing, NULL);
    int rows = v.problem_count < 4 ? v.problem_count : 4;
    Dimension height = (Dimension)(rows * (font->ascent + font->descent + spacing) + 8);
    XtVaSetValues(v.issues_view, XtNpreferredPaneSize, height, XtNmin, height, XtNmax, height, NULL);
    XtManageChild(v.issues_title);
    XtManageChild(v.issues_view);
}

static void show_problems(const Json *problems) {
    json_free(v.problems);
    char *copy = json_write(problems);
    const char *error;
    v.problems = json_parse(copy, &error);
    free(copy);
    MapSetProblems(v.map, problems);
    show_issues();
}

static void apply_state(const Json *reply, void *data) {
    (void)data;
    if (failed(reply)) return;
    const Json *graph = json_get(reply, "graph");
    if (graph) {
        count_graph(graph);
        MapSetGraph(v.map, graph);
        if (v.selected) MapSelect(v.map, v.selected);   /* the selection survives edits, and follows a rename */
    }
    if (json_get(reply, "problems")) show_problems(json_get(reply, "problems"));
    v.dirty = json_get_bool(reply, "dirty");
    v.can_undo = json_get_bool(reply, "canUndo");
    v.can_redo = json_get_bool(reply, "canRedo");
    const char *text = json_get_string(reply, "text");
    if (text && focused != v.yaml) XtVaSetValues(v.yaml, XtNstring, text, NULL);   /* not under the typist */
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
    Dimension width = 0;
    XtVaGetValues(v.fields_view, XtNwidth, &width, NULL);
    Dimension text_width = width > 200 ? (Dimension)(width - 160) : 400;
    XtVaSetValues(v.fields, XtNwidth, (Dimension)(text_width + 140), NULL);
    for (int i = 0; i < pooled; i++) {
        if (i < v.row_count) {
            XFontStruct *font;
            XtVaGetValues(v.rows[i].text, XtNfont, &font, NULL);
            XtVaSetValues(v.rows[i].text, XtNwidth, text_width, XtNheight, (Dimension)(font->ascent + font->descent + 6), NULL);
            XtManageChild(v.rows[i].label);
            XtManageChild(v.rows[i].text);
        } else {
            XtUnmanageChild(v.rows[i].label);
            XtUnmanageChild(v.rows[i].text);
        }
    }
}

static char *value_text(const Json *value) {
    if (value->type == JSON_STRING) return strdup(value->string);
    return json_write(value);
}

static char field_keys[];
static char yaml_keys[];

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
                                     XtNeditType, XawtextEdit, XtNwidth, 260, XtNdisplayCaret, False, XtNresizable, True,
                                     XtNleft, XtChainLeft, XtNright, XtChainRight, NULL);
        static XtTranslations keys;
        if (!keys) keys = XtParseTranslationTable(field_keys);
        XtOverrideTranslations(row->text, keys);
        XFontStruct *font;
        XtVaGetValues(row->text, XtNfont, &font, NULL);   /* one line of its font, no more */
        XtVaSetValues(row->text, XtNheight, (Dimension)(font->ascent + font->descent + 6), NULL);
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

/* The panel shows the selected step, or with nothing selected the workflow
 * itself: never an empty pane. */
static void inspect(void) {
    const char *selected = MapSelection(v.map);
    char heading[300], under[300];
    if (selected) {
        snprintf(heading, sizeof heading, "%s", selected);
        XtVaSetValues(v.heading, XtNlabel, heading, XtNfont, v.mono_heading, NULL);
    } else {
        snprintf(heading, sizeof heading, "%s", v.name ? v.name : v.run_mode ? "Run" : "Workflow");
        XtVaSetValues(v.heading, XtNlabel, heading, XtNfont, v.sans_heading, NULL);
    }
    if (selected) snprintf(under, sizeof under, "%s", v.run_mode ? "Step of this run" : "Step  \xb7  Return edits a field, Tab moves on");
    else if (v.run_mode) snprintf(under, sizeof under, "Select a step for its jobs, results and logs");
    else snprintf(under, sizeof under, "%s  \xb7  select a step to edit it", v.file ? base_name(v.file) : "");
    XtVaSetValues(v.subheading, XtNlabel, under, NULL);
    show_issues();
    if (v.run_mode && !selected) { show_details(v.run_summary); return; }
    Json *r = request(v.run_mode ? "step" : "inspect");
    json_set(r, "step", json_string(selected ? selected : ""));
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
    if (v.run_mode) return;
    if (!selected) selected = "";            /* the file's own fields */
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
    "connect on_error", "open called workflow", "fit", "zoom in", "zoom out", "toggle yaml", "toggle panel", "quit", NULL,
};

static void mini_close(void) {
    v.mini_mode = MINI_NONE;
    XtPopdown(v.palette);
    XtVaSetValues(v.entry, XtNstring, "", NULL);
    XtUnmanageChild(v.entry);
    status("%s", v.message);
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
    XtManageChild(v.entry);            /* the field appears only while a prompt waits */
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
    } else if (mode == MINI_RUN) {
        start_run(value);
    } else if (mode == MINI_FOLLOW) {
        if (*value) follow(value);
    } else if (mode == MINI_ADD) {
        Json *step = new_step(value);
        char name[128] = "";
        sscanf(value, "%127s", name);
        if (!step) { status("Write NAME KIND [ARGUMENT]: run WORKER, call FILE, wait MESSAGE, delay DURATION, "
                            "end LABEL, group WORKER, parallel or switch."); }
        else if (selected) {
            Json *r = request("insert");
            json_set(r, "after", json_string(selected));
            json_set(r, "name", json_string(name));
            json_set(r, "step", step);
            send_edit(r, "Added after the selection, which now continues to it.");
            free(v.selected);
            char scope[256];
            scope_of(selected, scope, sizeof scope);
            v.selected = *scope ? format("%s/%s", scope, name) : strdup(name);
        } else {
            Json *r = request("add");
            json_set(r, "scope", json_string(""));
            json_set(r, "name", json_string(name));
            json_set(r, "step", step);
            send_edit(r, "Added; drag from a step to it to connect it.");
        }
    } else if (mode == MINI_NEW || mode == MINI_OPEN) {
        Json *r = request(mode == MINI_NEW ? "create" : "load");
        json_set(r, "file", json_string(value));
        if (v.environment) json_set(r, "environment", json_string(v.environment));
        free(v.file);
        v.file = strdup(value);
        free(v.selected);
        v.selected = NULL;
        send_edit(r, mode == MINI_NEW ? "Created; a with a step selected adds the next." : "Opened.");
    }
    free((void *)choice);
    free(value);
}

/* NAME KIND [ARGUMENT] as a new step, or NULL when it does not read as one. */
static Json *new_step(const char *line) {
    char name[128] = "", kind[32] = "", argument[512] = "";
    if (sscanf(line, "%127s %31s %511[^\n]", name, kind, argument) < 2) return NULL;
    Json *step = json_object();
    if (!strcmp(kind, "run") && *argument) {
        json_set(step, "run", json_string(argument));
        Json *input = json_object();
        json_set(input, "request", json_string("${request}"));
        json_set(step, "input", input);
    } else if (!strcmp(kind, "call") && *argument) {
        json_set(step, "call", json_string(argument));
        Json *input = json_object();
        json_set(input, "request", json_string("${request}"));
        json_set(step, "input", input);
    } else if (!strcmp(kind, "wait") && *argument) {
        json_set(step, "wait", json_string(argument));
    } else if (!strcmp(kind, "delay")) {
        json_set(step, "delay", json_string(*argument ? argument : "PT1M"));
    } else if (!strcmp(kind, "end")) {
        json_set(step, "end", json_string(*argument ? argument : name));
    } else if (!strcmp(kind, "group") && *argument) {
        /* A group starts as one step running ARGUMENT; add more inside it. */
        Json *inner = json_object(), *steps = json_object(), *group = json_object(), *input = json_object();
        json_set(inner, "run", json_string(argument));
        json_set(input, "request", json_string("${request}"));
        json_set(inner, "input", input);
        json_set(steps, "first", inner);
        json_set(group, "start", json_string("first"));
        json_set(group, "steps", steps);
        json_set(step, "group", group);
    } else if (!strcmp(kind, "parallel")) {
        json_set(step, "parallel", json_array());   /* drag from it to each branch */
    } else if (!strcmp(kind, "switch")) {
        json_set(step, "switch", json_array());     /* drag from it to each case */
    } else {
        json_free(step);
        return NULL;
    }
    return step;
}

/* Runs */

static char *self_path;     /* this program, to open a window on a run */

static void follow(const char *run) {
    pid_t child = fork();
    if (child == 0) {
        setsid();
        char *argv[] = { self_path, "-run", (char *)run, "-service", options.service, NULL };
        execv(self_path, argv);
        _exit(127);
    }
    if (child < 0) status("Cannot open a window on run %s.", run);
    else status("Following run %.8s in its own window.", run);
}

static void started(const Json *reply, void *data) {
    (void)data;
    if (failed(reply)) return;
    const char *run = json_get_string(reply, "run");
    if (run) follow(run);
}

static void start_run(const char *text) {
    Json *r = request("start");
    json_set(r, "request", json_string(text));
    if (v.environment) json_set(r, "environment", json_string(v.environment));
    if (options.workspace) json_set(r, "workspace", json_string(options.workspace));
    service_send(r, started, NULL);
    status("Starting asys-run; the run opens in its own window.");
}

/* Commands */

static void reload_reply(const Json *reply, void *data) { apply_state(reply, data); }

static void command(const char *name) {
    const char *selected = MapSelection(v.map);
    if (!strcmp(name, "fit")) { MapZoom(v.map, 0); return; }
    if (!strcmp(name, "full size")) { MapSetZoom(v.map, 1.0); return; }
    if (!strcmp(name, "go to")) { mini_open(MINI_PALETTE, "Go to:", ""); return; }
    if (!strcmp(name, "new") || !strcmp(name, "open")) {
        if (v.run_mode) { status("This window follows a run; start asys-flow-view on a file to edit."); return; }
        if (v.dirty) { status("Save or undo first: this file has unsaved changes."); return; }
        mini_open(!strcmp(name, "new") ? MINI_NEW : MINI_OPEN, !strcmp(name, "new") ? "New workflow file:" : "Open:", "");
        return;
    }
    if (!strcmp(name, "follow run")) { mini_open(MINI_FOLLOW, "Follow run (ID or prefix):", ""); return; }
    if (!strcmp(name, "start run")) {
        if (v.run_mode) { status("This window follows a run; open the workflow file to start another."); return; }
        if (v.dirty) { status("Save first: asys-run runs the file on disk."); return; }
        if (!v.environment) { status("No environment: give -environment or set ASYS_ENVIRONMENT_DIR."); return; }
        mini_open(MINI_RUN, "Run with request:", "");
        return;
    }
    if (!strcmp(name, "zoom in")) { MapZoom(v.map, 1.2); return; }
    if (!strcmp(name, "zoom out")) { MapZoom(v.map, 1 / 1.2); return; }
    if (!strcmp(name, "toggle panel")) {
        v.panel_hidden = !v.panel_hidden;
        if (v.panel_hidden) XtUnmanageChild(v.side); else XtManageChild(v.side);
        return;
    }
    if (!strcmp(name, "toggle yaml")) {
        v.yaml_shown = !v.yaml_shown;
        if (v.yaml_shown) XtManageChild(v.notes);
        else XtUnmanageChild(v.notes);
        return;
    }
    if (!strcmp(name, "quit")) {
        if (v.dirty && !v.quit_armed) { v.quit_armed = 1; status("Unsaved changes: quit again to discard them, or save."); return; }
        exit(0);
    }
    if (v.run_mode) { status("A run is read-only."); return; }
    if (!strcmp(name, "save")) { send_edit(request("save"), "Saved."); return; }
    if (!strcmp(name, "undo")) { if (v.can_undo) send_edit(request("undo"), "Undone."); else status("Nothing to undo."); return; }
    if (!strcmp(name, "redo")) { if (v.can_redo) send_edit(request("redo"), "Redone."); else status("Nothing to redo."); return; }
    if (!strcmp(name, "add step after")) {
        mini_open(MINI_ADD, "New step: NAME KIND [ARG]", "");
        status("Kinds: run WORKER, call FILE, wait MESSAGE, delay DURATION, end LABEL, group WORKER, parallel, switch.");
        return;
    }
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
    const char *name = strrchr(c->to, '/'), *kind = MapKind(v.map, c->from), *key = c->key;
    if (!strcmp(key, "next") && kind && !strcmp(kind, "parallel")) key = "branch";
    if (!strcmp(key, "next") && kind && !strcmp(kind, "switch")) key = "case";
    Json *r = request("connect");
    json_set(r, "step", json_string(c->from));
    json_set(r, "key", json_string(key));
    json_set(r, "to", json_string(name ? name + 1 : c->to));
    send_edit(r, !strcmp(key, "branch") ? "Branch added." : !strcmp(key, "case")
              ? "Case added, true until you write its condition in the panel." : !strcmp(key, "next") ? "Connected."
              : "Error path set.");
}

static void issue_chosen(Widget w, XtPointer client, XtPointer call) {
    (void)w; (void)client;
    XawListReturnStruct *chosen = call;
    if (chosen->list_index >= 0 && chosen->list_index < v.problem_count && v.problem_steps[chosen->list_index]
        && !MapSelection(v.map))
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
    if (graph) { count_graph(graph); MapSetGraph(v.map, graph); }
    MapSetStates(v.map, json_get(reply, "states"));
    const Json *run = json_get(reply, "run");
    const char *state = json_get_string(run, "status"), *error = json_get_string(run, "error");
    status("This run is %s%s%s", state ? state : "unknown", error && *error ? ": " : "", error ? error : "");
    /* The run as a whole: how far it has come. */
    int done = 0, running = 0, failed_steps = 0;
    const Json *states = json_get(reply, "states");
    for (size_t i = 0; states && i < states->count; i++) {
        const char *s = json_get_string(states->items[i], "state");
        if (!s) continue;
        done += !strcmp(s, "done");
        running += !strcmp(s, "running");
        failed_steps += !strcmp(s, "failed");
    }
    int waiting = v.step_count - done - running - failed_steps;
    snprintf(v.run_summary, sizeof v.run_summary,
             "This run is %s.%s%s\n\n%d done\n%d running\n%d failed\n%d not reached",
             state ? state : "unknown", error && *error ? "\n" : "", error ? error : "", done, running, failed_steps, waiting < 0 ? 0 : waiting);
    const char *name = json_get_string(run, "name");
    if (name && !v.name) v.name = strdup(name);
    show_title();
    inspect();   /* the step, or the run as a whole */
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

static void YamlApply(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)e; (void)params; (void)count;
    String text;
    XtVaGetValues(w, XtNstring, &text, NULL);
    Json *r = request("replace");
    json_set(r, "text", json_string(text));
    send_edit(r, "Applied the YAML; undo restores the text before.");
    focus(NULL);
}

static void YamlFocus(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)e; (void)params; (void)count;
    focus(w);
    status("Editing the YAML: Ctrl+Return applies it, Escape leaves it.");
}

/* The wheel scrolls the Viewport around the widget it turns over; Athena's
 * Viewport has no wheel binding of its own. */
static void WheelScroll(Widget w, XEvent *e, String *params, Cardinal *count) {
    (void)e;
    Widget port = w;
    while (port && !XtIsSubclass(port, viewportWidgetClass)) port = XtParent(port);
    if (!port || !*count) return;
    WidgetList children;
    Cardinal number;
    XtVaGetValues(port, XtNchildren, &children, XtNnumChildren, &number, NULL);
    if (!number) return;
    Position y;
    XtVaGetValues(children[number - 1], XtNy, &y, NULL);   /* the scrolled child sits above the port by its offset */
    int top = -y + (!strcmp(params[0], "up") ? -48 : 48);
    XawViewportSetCoordinates(port, 0, (Position)(top < 0 ? 0 : top));
}

static XtActionsRec actions[] = {
    { "command", Command }, { "palette", Palette }, { "mini-accept", MiniAccept }, { "mini-cancel", MiniCancel },
    { "mini-move", MiniMove }, { "field-commit", FieldCommit }, { "field-leave", FieldLeave },
    { "focus-inspector", FocusInspector }, { "field-next", FieldNext }, { "wheel-scroll", WheelScroll },
    { "yaml-apply", YamlApply }, { "yaml-focus", YamlFocus },
};

static char wheel_keys[] =
    "<Btn4Down>: wheel-scroll(up)\n"
    "<Btn5Down>: wheel-scroll(down)\n";

/* Text panes scroll by three lines a notch. */
static char text_wheel_keys[] =
    "<Btn4Down>: scroll-one-line-down() scroll-one-line-down() scroll-one-line-down()\n"
    "<Btn5Down>: scroll-one-line-up() scroll-one-line-up() scroll-one-line-up()\n";

/* The app-defaults file, compiled in: used when no AsysFlowView is installed. */
static String fallback[] = {
#include "fallback.h"
    NULL,
};


static XrmOptionDescRec option_table[] = {
    { "-environment", "*environmentDirectory", XrmoptionSepArg, NULL },
    { "-run", "*run", XrmoptionSepArg, NULL },
    { "-root", "*root", XrmoptionSepArg, NULL },
    { "-service", "*service", XrmoptionSepArg, NULL },
    { "-workspace", "*workspace", XrmoptionSepArg, NULL },
    { "-help", "*help", XrmoptionNoArg, (XPointer)"True" },
};

#define OPTION(field) XtOffsetOf(__typeof__(options), field)
static XtResource option_resources[] = {
    { "environmentDirectory", "EnvironmentDirectory", XtRString, sizeof(String), OPTION(environment), XtRString, NULL },
    { "run", "Run", XtRString, sizeof(String), OPTION(run), XtRString, NULL },
    { "root", "Root", XtRString, sizeof(String), OPTION(root), XtRString, NULL },
    { "service", "Service", XtRString, sizeof(String), OPTION(service), XtRString, (XtPointer)"asys workflow serve" },
    { "workspace", "Workspace", XtRString, sizeof(String), OPTION(workspace), XtRString, NULL },
    { "titleFont", "Font", XtRFontStruct, sizeof(XFontStruct *), OPTION(title_font), XtRString, (XtPointer)XtDefaultFont },
    { "stepFont", "Font", XtRFontStruct, sizeof(XFontStruct *), OPTION(step_font), XtRString, (XtPointer)XtDefaultFont },
    { "help", "Help", XtRBoolean, sizeof(Boolean), OPTION(help), XtRImmediate, (XtPointer)False },
};
#undef OPTION

static char map_keys[] =
    "<Key>slash: palette()\n"
    "Ctrl<Key>s: command(save)\n"
    "Ctrl<Key>r: command(\"start run\")\n"
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
    "<Key>Tab: command(\"toggle panel\")\n"
    "<Key>1: command(\"full size\")\n"
    "<Key>Return: focus-inspector()\n";

static char entry_keys[] =
    "<Key>Return: mini-accept()\n"
    "<Key>Escape: mini-cancel()\n"
    "<Key>Up: mini-move(up)\n"
    "<Key>Down: mini-move(down)\n"
    "Ctrl<Key>g: mini-cancel()\n";

/* In the YAML pane: Ctrl+Return applies the text as one edit; Escape leaves. */
static char yaml_keys[] =
    "Ctrl<Key>Return: yaml-apply()\n"
    "<Btn1Down>: yaml-focus() select-start()\n"
    "<Key>Escape: field-leave()\n";

static char field_keys[] =
    "<Key>Return: field-commit() field-leave()\n"
    "<Key>Tab: field-commit() field-next()\n"
    "<Key>Escape: field-leave()\n"
    "<Btn4Down>: wheel-scroll(up)\n"
    "<Btn5Down>: wheel-scroll(down)\n";

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

static void usage(FILE *out, int status) {
    fprintf(out, "usage: asys-flow-view [-toolkitoption ...] [-environment dir] file.yaml\n"
                 "       asys-flow-view [-toolkitoption ...] -run run [-root dir]\n"
                 "other options: -service command, -help; see asys-flow-view(1)\n");
    exit(status);
}

int main(int argc, char **argv) {
    XtSetLanguageProc(NULL, NULL, NULL);
    v.top = XtVaOpenApplication(&v.app, "AsysFlowView", option_table, XtNumber(option_table), &argc, argv, fallback,
                                sessionShellWidgetClass, NULL);
    XtGetApplicationResources(v.top, &options, option_resources, XtNumber(option_resources), NULL, 0);
    if (options.help) usage(stdout, 0);
    self_path = realpath("/proc/self/exe", NULL);
    if (!self_path) self_path = argv[0];
    if (argc > 2 || (argc == 2 && argv[1][0] == '-')) usage(stderr, 2);
    v.file = argc == 2 ? strdup(argv[1]) : NULL;
    /* The environment asys gives its jobs, ASYS_ENVIRONMENT_DIR, unless -environment names another. */
    const char *from_shell = getenv("ASYS_ENVIRONMENT_DIR");
    v.environment = options.environment ? strdup(options.environment) : from_shell && *from_shell ? strdup(from_shell) : NULL;
    v.run = options.run ? strdup(options.run) : NULL;
    v.root = options.root ? strdup(options.root) : NULL;
    if (!v.file == !v.run) usage(stderr, 2);
    v.run_mode = v.run != NULL;

    /* The icon is the asys symbol; the icon name is what is open. */
    Display *display = XtDisplay(v.top);
    Pixmap icon = XCreateBitmapFromData(display, RootWindowOfScreen(XtScreen(v.top)), (char *)asys_bits, asys_width, asys_height);
    XtVaSetValues(v.top, XtNiconPixmap, icon, XtNiconName, v.file ? base_name(v.file) : "asys run", NULL);
    /* editres(1) can inspect and change the widget tree. */
    XtAddEventHandler(v.top, (EventMask)0, True, (XtEventHandler)_XEditResCheckMessages, NULL);

    XtAppAddActions(v.app, actions, XtNumber(actions));
    v.paned = XtVaCreateManagedWidget("paned", panedWidgetClass, v.top, XtNorientation, XtorientVertical, NULL);
    v.bar = XtVaCreateManagedWidget("bar", boxWidgetClass, v.paned, XtNorientation, XtorientHorizontal,
                                    XtNshowGrip, False, XtNskipAdjust, True, NULL);
    static const char *const file_entries[][2] = { { "New...", "new" }, { "Open...", "open" }, { "", "" },
                                                   { "Save                Ctrl+S", "save" }, { "", "" },
                                                   { "Quit                     q", "quit" }, { NULL, NULL } };
    static const char *const edit_entries[][2] = { { "Undo        Ctrl+Z", "undo" }, { "Redo        Ctrl+Y", "redo" }, { "", "" },
                                                   { "Add step after       a", "add step after" },
                                                   { "Rename step          r", "rename step" },
                                                   { "Continue at...       c", "connect next" },
                                                   { "On error...          e", "connect on_error" },
                                                   { "Remove step        Del", "remove step" }, { NULL, NULL } };
    static const char *const view_entries[][2] = { { "Fit to window          0", "fit" },
                                                   { "Full size              1", "full size" },
                                                   { "Zoom in                +", "zoom in" },
                                                   { "Zoom out               -", "zoom out" }, { "", "" },
                                                   { "Go to...               /", "go to" },
                                                   { "Panel                Tab", "toggle panel" },
                                                   { "YAML                   y", "toggle yaml" }, { NULL, NULL } };
    menu(v.bar, "file", "File", file_entries);
    if (!v.run_mode) menu(v.bar, "edit", "Edit", edit_entries);
    menu(v.bar, "view", "View", view_entries);
    static const char *const run_entries[][2] = { { "Start run...      Ctrl+R", "start run" },
                                                  { "Follow run...", "follow run" }, { NULL, NULL } };
    menu(v.bar, "run", "Run", run_entries);

    /* The map above, at the window's full width; the panel a strip beneath it,
     * in two columns: what is selected and its fields, then its problems or
     * the YAML. */
    v.split = XtVaCreateManagedWidget("split", panedWidgetClass, v.paned, XtNorientation, XtorientVertical,
                                      XtNshowGrip, False, NULL);
    v.map = XtVaCreateManagedWidget("map", mapWidgetClass, v.split, XtNwidth, 1280, XtNheight, 600, XtNmin, 160, NULL);
    XtOverrideTranslations(v.map, XtParseTranslationTable(map_keys));
    XtAddCallback(v.map, XtNselectCallback, map_selected, NULL);
    XtAddCallback(v.map, XtNactivateCallback, map_activated, NULL);
    XtAddCallback(v.map, XtNconnectCallback, map_connected, NULL);

    v.side = XtVaCreateManagedWidget("side", panedWidgetClass, v.split, XtNorientation, XtorientHorizontal,
                                     XtNpreferredPaneSize, 250, XtNmin, 120, XtNskipAdjust, True, XtNinternalBorderWidth, 1, NULL);
    v.about = XtVaCreateManagedWidget("about", panedWidgetClass, v.side, XtNorientation, XtorientVertical,
                                      XtNwidth, 1280, XtNmin, 300, XtNinternalBorderWidth, 0, NULL);
    v.notes = XtVaCreateWidget("notes", panedWidgetClass, v.side, XtNorientation, XtorientVertical,
                               XtNwidth, 560, XtNmin, 200, XtNinternalBorderWidth, 0, NULL);   /* the YAML, when shown */
    v.mono_heading = options.step_font;
    v.sans_heading = options.title_font;
    v.heading = XtVaCreateManagedWidget("heading", labelWidgetClass, v.about, XtNlabel, "", XtNjustify, XtJustifyLeft,
                                        XtNfont, v.sans_heading, XtNshowGrip, False, XtNskipAdjust, True, NULL);
    v.subheading = XtVaCreateManagedWidget("subheading", labelWidgetClass, v.about, XtNlabel, "", XtNjustify, XtJustifyLeft,
                                           XtNshowGrip, False, XtNskipAdjust, True, NULL);
    v.issues_title = XtVaCreateWidget("issuesTitle", labelWidgetClass, v.about, XtNlabel, "", XtNjustify, XtJustifyLeft,
                                      XtNshowGrip, False, XtNskipAdjust, True, NULL);
    v.issues_view = XtVaCreateWidget("issuesView", viewportWidgetClass, v.about, XtNallowVert, True, XtNheight, 40,
                                     XtNshowGrip, False, XtNskipAdjust, True, NULL);
    v.problem_lines[0] = strdup("");
    v.problem_lines[1] = NULL;
    v.listed = 1;
    v.issues = XtVaCreateManagedWidget("issues", listWidgetClass, v.issues_view, XtNlist, v.problem_lines,
                                       XtNdefaultColumns, 1, XtNforceColumns, True, XtNverticalList, True, NULL);
    XtAddCallback(v.issues, XtNcallback, issue_chosen, NULL);
    if (v.run_mode) {
        v.details = XtVaCreateManagedWidget("details", asciiTextWidgetClass, v.about, XtNscrollVertical, XawtextScrollWhenNeeded,
                                            XtNwrap, XawtextWrapLine, XtNeditType, XawtextRead, XtNstring, "",
                                            XtNdisplayCaret, False, XtNpreferredPaneSize, 400, XtNmin, 60, XtNleftMargin, 14, XtNtopMargin, 6, NULL);
    } else {
        v.fields_view = XtVaCreateManagedWidget("fieldsView", viewportWidgetClass, v.about, XtNallowVert, True, XtNheight, 160,
                                                XtNpreferredPaneSize, 400, XtNmin, 60,
                                                XtNforceBars, False, XtNuseRight, True, NULL);
        v.fields = XtVaCreateManagedWidget("fields", formWidgetClass, v.fields_view, XtNwidth, 600, XtNheight, 40, NULL);
        v.details = XtVaCreateWidget("details", asciiTextWidgetClass, v.about, XtNeditType, XawtextRead, NULL);
    }
    v.yaml = XtVaCreateManagedWidget("yaml", asciiTextWidgetClass, v.notes, XtNscrollVertical, XawtextScrollWhenNeeded,
                              XtNpreferredPaneSize, 400, XtNmin, 60,
                              XtNeditType, v.run_mode ? XawtextRead : XawtextEdit, XtNstring, "", XtNdisplayCaret, False, NULL);
    if (!v.run_mode) XtOverrideTranslations(v.yaml, XtParseTranslationTable(yaml_keys));

    v.mini = XtVaCreateManagedWidget("mini", formWidgetClass, v.paned, XtNshowGrip, False, XtNskipAdjust, True, NULL);
    v.prompt = XtVaCreateManagedWidget("prompt", labelWidgetClass, v.mini, XtNlabel, "/ finds steps and commands",
                                       XtNjustify, XtJustifyLeft, XtNresizable, True, XtNleft, XtChainLeft, XtNright, XtChainLeft, NULL);
    v.entry = XtVaCreateWidget("entry", asciiTextWidgetClass, v.mini, XtNeditType, XawtextEdit, XtNfromHoriz, v.prompt,
                                      XtNdisplayCaret, False,
                                      XtNwidth, 600, XtNleft, XtChainLeft, XtNright, XtChainRight, NULL);
    XtOverrideTranslations(v.entry, XtParseTranslationTable(entry_keys));
    XtAddCallback(XawTextGetSource(v.entry), XtNcallback, text_changed, NULL);
    /* The palette's matches float above the prompt line, over the map. */
    v.palette = XtVaCreatePopupShell("palette", overrideShellWidgetClass, v.top, XtNborderWidth, 1, NULL);
    v.matches = XtVaCreateManagedWidget("matches", listWidgetClass, v.palette, XtNverticalList, True,
                                        XtNdefaultColumns, 1, XtNforceColumns, True, NULL);
    XtAddCallback(v.matches, XtNcallback, match_chosen, NULL);

    XtTranslations wheel = XtParseTranslationTable(wheel_keys), text_wheel = XtParseTranslationTable(text_wheel_keys);
    if (v.fields) XtOverrideTranslations(v.fields, wheel);
    XtOverrideTranslations(v.issues, wheel);
    XtOverrideTranslations(v.yaml, text_wheel);
    XtOverrideTranslations(v.details, text_wheel);
    XtRealizeWidget(v.top);
    Atom delete = XInternAtom(display, "WM_DELETE_WINDOW", False);
    XSetWMProtocols(display, XtWindow(v.top), &delete, 1);
    XtOverrideTranslations(v.top, XtParseTranslationTable("<Message>WM_PROTOCOLS: command(quit)"));
    focus(NULL);

    const char *service = getenv("ASYS_FLOW_SERVICE");
    if (!service || !*service) service = options.service;
    char *command_line[16], *words = strdup(service), *save = NULL;
    int n = 0;
    for (char *word = strtok_r(words, " ", &save); word && n < 15; word = strtok_r(NULL, " ", &save)) command_line[n++] = word;
    command_line[n] = NULL;
    if (!n || service_start(v.app, command_line, lost) < 0) { perror("asys-flow-view: service"); return 1; }
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
        if (v.environment) status("Worker types are checked against %s.", v.environment);
        else status("No environment given: worker types are not checked.");
    }
    show_title();
    XtAppMainLoop(v.app);
    return 0;
}
