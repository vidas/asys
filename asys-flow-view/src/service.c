#include "service.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

typedef struct Waiting {
    long id;
    ServiceReply reply;
    void *data;
    struct Waiting *next;
} Waiting;

static int to_service = -1, from_service = -1;
static pid_t child;
static long next_id = 1;
static Waiting *waiting;
static char *line;
static size_t line_length, line_capacity;
static void (*on_lost)(const char *);

static void lose(const char *why) {
    if (to_service >= 0) close(to_service);
    to_service = -1;
    if (on_lost) on_lost(why);
}

static void dispatch(const char *text) {
    const char *error;
    Json *response = json_parse(text, &error);
    if (!response) { fprintf(stderr, "asys-flow-view: unreadable reply (%s): %.200s\n", error, text); return; }
    long id = (long)json_get_number(response, "id", -1);
    for (Waiting **link = &waiting; *link; link = &(*link)->next) {
        if ((*link)->id != id) continue;
        Waiting *found = *link;
        *link = found->next;
        found->reply(response, found->data);
        free(found);
        break;
    }
    json_free(response);
}

static void readable(XtPointer closure, int *source, XtInputId *input) {
    (void)closure;
    char chunk[65536];
    ssize_t count = read(*source, chunk, sizeof chunk);
    if (count < 0 && (errno == EAGAIN || errno == EINTR)) return;
    if (count <= 0) {
        XtRemoveInput(*input);
        close(*source);
        from_service = -1;
        lose("asys workflow serve stopped");
        return;
    }
    for (ssize_t i = 0; i < count; i++) {
        if (line_length + 1 >= line_capacity) {
            line_capacity = line_capacity ? line_capacity * 2 : 65536;
            line = realloc(line, line_capacity);
            if (!line) { perror("asys-flow-view"); exit(1); }
        }
        if (chunk[i] == '\n') {
            line[line_length] = 0;
            line_length = 0;
            dispatch(line);
        } else {
            line[line_length++] = chunk[i];
        }
    }
}

int service_start(XtAppContext app, char *const command[], void (*lost)(const char *why)) {
    int down[2], up[2];
    on_lost = lost;
    if (pipe(down) || pipe(up)) return -1;
    child = fork();
    if (child < 0) return -1;
    if (child == 0) {
        dup2(down[0], 0);
        dup2(up[1], 1);
        close(down[0]); close(down[1]); close(up[0]); close(up[1]);
        execvp(command[0], command);
        fprintf(stderr, "asys-flow-view: cannot run %s: %s\n", command[0], strerror(errno));
        _exit(127);
    }
    close(down[0]);
    close(up[1]);
    to_service = down[1];
    from_service = up[0];
    fcntl(to_service, F_SETFD, FD_CLOEXEC);
    fcntl(from_service, F_SETFD, FD_CLOEXEC);
    fcntl(from_service, F_SETFL, O_NONBLOCK);
    signal(SIGPIPE, SIG_IGN);
    XtAppAddInput(app, from_service, (XtPointer)XtInputReadMask, readable, NULL);
    return 0;
}

void service_send(Json *request, ServiceReply reply, void *data) {
    long id = next_id++;
    json_set(request, "id", json_number((double)id));
    char *text = json_write(request);
    json_free(request);
    if (to_service < 0) { free(text); return; }
    if (reply) {
        Waiting *entry = calloc(1, sizeof *entry);
        if (!entry) { perror("asys-flow-view"); exit(1); }
        *entry = (Waiting){ id, reply, data, NULL };
        Waiting **tail = &waiting;          /* replies come in order; keep the list in order */
        while (*tail) tail = &(*tail)->next;
        *tail = entry;
    }
    size_t length = strlen(text), written = 0;
    text[length] = '\n';                    /* json_write leaves room: replace the terminator */
    while (written < length + 1) {
        ssize_t count = write(to_service, text + written, length + 1 - written);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { lose("cannot write to asys workflow serve"); break; }
        written += (size_t)count;
    }
    free(text);
}

int service_pending(void) { return waiting != NULL; }
