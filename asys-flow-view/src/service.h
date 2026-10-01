/* The editing and run model: `asys workflow serve`, one JSON line each way. */
#ifndef ASYS_SERVICE_H
#define ASYS_SERVICE_H

#include <X11/Intrinsic.h>
#include "json.h"

/* RESPONSE is the whole reply, ok or not; it is freed after the call. */
typedef void (*ServiceReply)(const Json *response, void *data);

int service_start(XtAppContext app, char *const command[], void (*lost)(const char *why));
/* Send REQUEST (consumed); REPLY gets the response with the same id. */
void service_send(Json *request, ServiceReply reply, void *data);
int service_pending(void);

#endif
