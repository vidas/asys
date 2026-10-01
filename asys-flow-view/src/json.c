#include "json.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t size) {
    void *memory = calloc(1, size);
    if (!memory) { perror("asys-flow-view"); exit(1); }
    return memory;
}

static Json *make(JsonType type) {
    Json *value = xalloc(sizeof *value);
    value->type = type;
    return value;
}

Json *json_null(void) { return make(JSON_NULL); }
Json *json_bool(int b) { Json *v = make(JSON_BOOL); v->boolean = !!b; return v; }
Json *json_number(double n) { Json *v = make(JSON_NUMBER); v->number = n; return v; }
Json *json_string(const char *s) { Json *v = make(JSON_STRING); v->string = strdup(s ? s : ""); return v; }
Json *json_array(void) { return make(JSON_ARRAY); }
Json *json_object(void) { return make(JSON_OBJECT); }

static void grow(Json *value) {
    if (value->count < value->capacity) return;
    value->capacity = value->capacity ? value->capacity * 2 : 8;
    value->items = realloc(value->items, value->capacity * sizeof *value->items);
    if (value->type == JSON_OBJECT) value->keys = realloc(value->keys, value->capacity * sizeof *value->keys);
    if (!value->items || (value->type == JSON_OBJECT && !value->keys)) { perror("asys-flow-view"); exit(1); }
}

void json_push(Json *array, Json *value) {
    grow(array);
    array->items[array->count++] = value;
}

void json_set(Json *object, const char *key, Json *value) {
    for (size_t i = 0; i < object->count; i++)
        if (strcmp(object->keys[i], key) == 0) { json_free(object->items[i]); object->items[i] = value; return; }
    grow(object);
    object->keys[object->count] = strdup(key);
    object->items[object->count++] = value;
}

void json_free(Json *value) {
    if (!value) return;
    for (size_t i = 0; i < value->count; i++) {
        json_free(value->items[i]);
        if (value->keys) free(value->keys[i]);
    }
    free(value->items);
    free(value->keys);
    free(value->string);
    free(value);
}

const Json *json_get(const Json *object, const char *key) {
    if (!object || object->type != JSON_OBJECT) return NULL;
    for (size_t i = 0; i < object->count; i++)
        if (strcmp(object->keys[i], key) == 0) return object->items[i];
    return NULL;
}

const char *json_get_string(const Json *object, const char *key) {
    const Json *value = json_get(object, key);
    return value && value->type == JSON_STRING ? value->string : NULL;
}

double json_get_number(const Json *object, const char *key, double otherwise) {
    const Json *value = json_get(object, key);
    return value && value->type == JSON_NUMBER ? value->number : otherwise;
}

int json_get_bool(const Json *object, const char *key) {
    const Json *value = json_get(object, key);
    return value && value->type == JSON_BOOL && value->boolean;
}

const Json *json_at(const Json *array, size_t index) {
    return array && array->type == JSON_ARRAY && index < array->count ? array->items[index] : NULL;
}

/* Parsing */

typedef struct { const char *at; const char *error; } Parser;

static void skip(Parser *p) { while (isspace((unsigned char)*p->at)) p->at++; }

static Json *fail(Parser *p, const char *message) { if (!p->error) p->error = message; return NULL; }

static void put_utf8(char **out, unsigned code) {
    char *o = *out;
    if (code < 0x80) *o++ = (char)code;
    else if (code < 0x800) { *o++ = (char)(0xC0 | code >> 6); *o++ = (char)(0x80 | (code & 0x3F)); }
    else if (code < 0x10000) { *o++ = (char)(0xE0 | code >> 12); *o++ = (char)(0x80 | (code >> 6 & 0x3F)); *o++ = (char)(0x80 | (code & 0x3F)); }
    else { *o++ = (char)(0xF0 | code >> 18); *o++ = (char)(0x80 | (code >> 12 & 0x3F)); *o++ = (char)(0x80 | (code >> 6 & 0x3F)); *o++ = (char)(0x80 | (code & 0x3F)); }
    *out = o;
}

static int hex4(const char *s, unsigned *code) {
    *code = 0;
    for (int i = 0; i < 4; i++) {
        char c = s[i];
        *code <<= 4;
        if (c >= '0' && c <= '9') *code |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') *code |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') *code |= (unsigned)(c - 'A' + 10);
        else return 0;
    }
    return 1;
}

static char *parse_string_raw(Parser *p) {
    if (*p->at != '"') { fail(p, "expected a string"); return NULL; }
    const char *start = ++p->at;
    size_t length = 0;
    for (const char *s = start; *s != '"'; s++) {      /* decoded text is never longer */
        if (!*s) { fail(p, "unterminated string"); return NULL; }
        if (*s == '\\' && s[1]) s++;
        length++;
    }
    char *text = xalloc(length * 4 + 1), *out = text;
    while (*p->at != '"') {
        char c = *p->at++;
        if (c != '\\') { *out++ = c; continue; }
        c = *p->at++;
        switch (c) {
        case 'n': *out++ = '\n'; break;
        case 't': *out++ = '\t'; break;
        case 'r': *out++ = '\r'; break;
        case 'b': *out++ = '\b'; break;
        case 'f': *out++ = '\f'; break;
        case 'u': {
            unsigned code;
            if (!hex4(p->at, &code)) { free(text); fail(p, "bad \\u escape"); return NULL; }
            p->at += 4;
            if (code >= 0xD800 && code < 0xDC00 && p->at[0] == '\\' && p->at[1] == 'u') {
                unsigned low;
                if (hex4(p->at + 2, &low) && low >= 0xDC00 && low < 0xE000) {
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                    p->at += 6;
                }
            }
            put_utf8(&out, code);
            break;
        }
        default: *out++ = c;
        }
    }
    p->at++;
    *out = 0;
    return text;
}

static Json *parse_value(Parser *p, int depth);

static Json *parse_value(Parser *p, int depth) {
    if (depth > 200) return fail(p, "nested too deeply");
    skip(p);
    char c = *p->at;
    if (c == '{') {
        Json *object = json_object();
        p->at++;
        skip(p);
        if (*p->at == '}') { p->at++; return object; }
        for (;;) {
            skip(p);
            char *key = parse_string_raw(p);
            if (!key) { json_free(object); return NULL; }
            skip(p);
            if (*p->at++ != ':') { free(key); json_free(object); return fail(p, "expected ':'"); }
            Json *value = parse_value(p, depth + 1);
            if (!value) { free(key); json_free(object); return NULL; }
            grow(object);
            object->keys[object->count] = key;
            object->items[object->count++] = value;
            skip(p);
            if (*p->at == ',') { p->at++; continue; }
            if (*p->at == '}') { p->at++; return object; }
            json_free(object);
            return fail(p, "expected ',' or '}'");
        }
    }
    if (c == '[') {
        Json *array = json_array();
        p->at++;
        skip(p);
        if (*p->at == ']') { p->at++; return array; }
        for (;;) {
            Json *value = parse_value(p, depth + 1);
            if (!value) { json_free(array); return NULL; }
            json_push(array, value);
            skip(p);
            if (*p->at == ',') { p->at++; continue; }
            if (*p->at == ']') { p->at++; return array; }
            json_free(array);
            return fail(p, "expected ',' or ']'");
        }
    }
    if (c == '"') {
        char *text = parse_string_raw(p);
        if (!text) return NULL;
        Json *value = make(JSON_STRING);
        value->string = text;
        return value;
    }
    if (strncmp(p->at, "true", 4) == 0) { p->at += 4; return json_bool(1); }
    if (strncmp(p->at, "false", 5) == 0) { p->at += 5; return json_bool(0); }
    if (strncmp(p->at, "null", 4) == 0) { p->at += 4; return json_null(); }
    if (c == '-' || isdigit((unsigned char)c)) {
        char *end;
        double number = strtod(p->at, &end);
        if (end == p->at) return fail(p, "bad number");
        p->at = end;
        return json_number(number);
    }
    return fail(p, "unexpected character");
}

Json *json_parse(const char *text, const char **error) {
    Parser p = { text, NULL };
    Json *value = parse_value(&p, 0);
    if (value) {
        skip(&p);
        if (*p.at) { json_free(value); value = fail(&p, "trailing characters"); }
    }
    if (error) *error = p.error;
    return value;
}

/* Writing */

typedef struct { char *text; size_t length, capacity; } Buffer;

static void append(Buffer *b, const char *s, size_t n) {
    if (b->length + n + 1 > b->capacity) {
        while (b->length + n + 1 > b->capacity) b->capacity = b->capacity ? b->capacity * 2 : 256;
        b->text = realloc(b->text, b->capacity);
        if (!b->text) { perror("asys-flow-view"); exit(1); }
    }
    memcpy(b->text + b->length, s, n);
    b->length += n;
    b->text[b->length] = 0;
}

static void append_string(Buffer *b, const char *s) {
    append(b, "\"", 1);
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        char escaped[8];
        if (c == '"' || c == '\\') { escaped[0] = '\\'; escaped[1] = (char)c; append(b, escaped, 2); }
        else if (c == '\n') append(b, "\\n", 2);
        else if (c == '\t') append(b, "\\t", 2);
        else if (c == '\r') append(b, "\\r", 2);
        else if (c < 0x20) { snprintf(escaped, sizeof escaped, "\\u%04x", c); append(b, escaped, 6); }
        else append(b, (const char *)&c, 1);
    }
    append(b, "\"", 1);
}

static void write_value(Buffer *b, const Json *v) {
    char number[64];
    switch (v->type) {
    case JSON_NULL: append(b, "null", 4); break;
    case JSON_BOOL: v->boolean ? append(b, "true", 4) : append(b, "false", 5); break;
    case JSON_NUMBER:
        if (v->number == (long long)v->number && v->number < 1e15 && v->number > -1e15)
            snprintf(number, sizeof number, "%lld", (long long)v->number);
        else
            snprintf(number, sizeof number, "%.17g", v->number);
        append(b, number, strlen(number));
        break;
    case JSON_STRING: append_string(b, v->string); break;
    case JSON_ARRAY:
        append(b, "[", 1);
        for (size_t i = 0; i < v->count; i++) { if (i) append(b, ",", 1); write_value(b, v->items[i]); }
        append(b, "]", 1);
        break;
    case JSON_OBJECT:
        append(b, "{", 1);
        for (size_t i = 0; i < v->count; i++) {
            if (i) append(b, ",", 1);
            append_string(b, v->keys[i]);
            append(b, ":", 1);
            write_value(b, v->items[i]);
        }
        append(b, "}", 1);
        break;
    }
}

char *json_write(const Json *value) {
    Buffer b = { 0 };
    write_value(&b, value);
    return b.text;
}
