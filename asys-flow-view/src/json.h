/* A small JSON value type: enough for the lines asys workflow serve exchanges. */
#ifndef ASYS_JSON_H
#define ASYS_JSON_H

#include <stddef.h>

typedef enum { JSON_NULL, JSON_BOOL, JSON_NUMBER, JSON_STRING, JSON_ARRAY, JSON_OBJECT } JsonType;

typedef struct Json Json;
struct Json {
    JsonType type;
    int boolean;
    double number;
    char *string;          /* JSON_STRING */
    Json **items;          /* JSON_ARRAY values, JSON_OBJECT values */
    char **keys;           /* JSON_OBJECT keys, parallel to items */
    size_t count, capacity;
};

Json *json_parse(const char *text, const char **error);
char *json_write(const Json *value);           /* malloc'd, compact */
void json_free(Json *value);

Json *json_null(void);
Json *json_bool(int value);
Json *json_number(double value);
Json *json_string(const char *value);
Json *json_array(void);
Json *json_object(void);
void json_push(Json *array, Json *value);       /* takes ownership */
void json_set(Json *object, const char *key, Json *value);  /* takes ownership */

/* Lookups return NULL when absent or of another type. */
const Json *json_get(const Json *object, const char *key);
const char *json_get_string(const Json *object, const char *key);
double json_get_number(const Json *object, const char *key, double otherwise);
int json_get_bool(const Json *object, const char *key);
const Json *json_at(const Json *array, size_t index);

#endif
