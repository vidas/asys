# Gateway host channel

The host and the running gateway exchange events using the
[asys-runtime channel protocol](../../asys-runtime/README.md#channels).
The gateway invokes the same account operations and native Pi authentication
flows used by its credential store. No additional component or job executor
participates in login.

The component source declares `"host_channel": "gateway"` in `runtime.json`.
Asys-inference prepares `MACHINE_ROOT/host/PROVIDER/channels/gateway/{in,out}`
and mounts `MACHINE_ROOT/host/PROVIDER` at `/run/asys-host` in that provider.
The host-side `host/` parent is private (`0700`) and is never mounted. Its
shared descendants support different host and container user IDs. Other
providers receive their own directories.

Directions are from the component's perspective: the host writes `in`, and
the gateway writes `out`. Events use the runtime envelope:

```json
{
  "version": 1,
  "sequence": 1,
  "type": "request",
  "time": "2026-09-13T12:00:00.000000+00:00",
  "data": {
    "id": "client-generated-request-id",
    "instance": "gateway-process-instance-id",
    "command": "login",
    "body": {
      "provider": "openai",
      "account": "work",
      "authentication": "api_key",
      "interactive": true
    }
  }
}
```

The gateway emits `ready` at startup with a new `instance`. Every outgoing
event includes that instance, so a client can obtain it from the latest event
even after older events have been pruned. Requests addressed to a previous
instance fail. The host chooses a unique request `id`; all responses to that
request carry it.

| Host event | Data beyond `id` |
| --- | --- |
| `request` | `instance`, `command`, `body` |
| `answer` | `prompt`: prompt ID, `value`: entered string |
| `cancel` | None; abort this request |
| `keepalive` | None; indicate the client is still present |

| Gateway event | Data beyond `id` and `instance` |
| --- | --- |
| `accepted` | None |
| `notice` | `message`: authorization instructions, URL, device code, or progress |
| `prompt` | `prompt`: unique prompt ID, `message`, `secret`: whether input must be hidden |
| `prompt.cancelled` | `prompt`: prompt ID no longer needing an answer |
| `result` | `result`: command result |
| `error` | `message`: failure description |
| `alive` | None; acknowledge client keepalive |

Commands are `providers`, `models`, `usage`, and `status` with an empty body; `logout`
with `account`; `rename` with `account` and `new_account`; and `login` with
the body shown above. Login authentication is `auto`, `oauth`, or `api_key`.
An optional `api_key_input: true` indicates that the host is supplying a key;
ambient-only authentication must reject that request instead of ignoring it.
The login result contains `account` and the selected `authentication`.
`models` returns this gateway's catalogue. `status` returns `recent_failures`
with the latest inference failure per model since startup. Each record includes
its timestamp, model, outcome and a bounded failure diagnostic. It reads retained
local observations without querying upstream providers. The host's
`asys-inference status [--json]` consumes this operation.

Pi's interaction callbacks publish notices and prompts. Answers must match
both the request and prompt IDs. OAuth selections are displayed as numbered
options. A provider can cancel its optional manual-code prompt when a browser
callback completes; the host stops waiting for keyboard input and restores
terminal settings immediately. This does not add forwarding for browser
callbacks to a container's loopback listener.

The host sends a keepalive each second. After 15 seconds without one the
gateway cancels the abandoned request. The host fails if the gateway stops
responding for 20 seconds. Login may otherwise remain pending while its client
is present. Read commands can proceed during login; account mutations remain
serialized by the gateway's account service.

Answers are transient. The gateway appends a harmless `consumed` event before
pruning an answer, preserving the stream's sequence high-water mark while
removing the answer file. This happens before the answer is supplied to Pi.
Answers arriving for an expired prompt are pruned too. The gateway's private
credential volume remains the persistent credential store.

On restart, the gateway discards pending input from the previous process and
publishes its new instance. An interrupted OAuth exchange must be started
again. A mutation may have committed before a lost response; inspect accounts
or models before repeating it. Requests are never automatically replayed
across gateway instances.

The CLI holds its machine lock and a shared dcomp deployment lock throughout
the request. There is one acknowledgement cursor per direction. Additional
observers should use their own explicit read position without acknowledging
or pruning the shared stream. The Python host helper is installed privately
with asys-inference and uses the same runtime library as asys-bpmn.
