# Browser live relay WebSocket profile v1

The Docker viewer can connect to a remote relay with `wss://` (`ws://` is accepted only for loopback development). This is a **subscribe-only** browser profile. There is no browser operation for ROS publish, service, action, parameter mutation, or arbitrary bridge commands.

## Transport

- WebSocket subprotocol: `ros-viewer.subscribe.v1`
- UTF-8 JSON text frames only in this baseline profile
- Maximum control frame: 256 KiB
- Maximum decoded message payload: 4 MiB
- Session tokens are sent once in the first authenticated WebSocket frame and are never persisted or rendered by the viewer.

## Browser requests

Every request has `version: 1`, a unique `requestId`, and one of these operations:

```json
{"version":1,"operation":"authenticate","requestId":"browser-1","browserOrigin":"https://viewer.example","sessionToken":"…"}
{"version":1,"operation":"discover","requestId":"browser-2","cursor":0}
{"version":1,"operation":"subscribe","requestId":"browser-3","topicIds":["points"]}
{"version":1,"operation":"unsubscribe","requestId":"browser-4","topicIds":["points"]}
```

Wildcard topic IDs are rejected. A subscription contains 1–32 exact IDs from the authenticated discovery result.

## Relay responses and events

```json
{"version":1,"kind":"ready","requestId":"browser-1","sessionId":"bound-session","expiresAtMs":1788296400000}
{"version":1,"kind":"discovery","requestId":"browser-2","topics":[{"id":"points","name":"/points","typeName":"sensor_msgs/msg/PointCloud2","encoding":"cdr","schemaEncoding":"ros2msg","schemaDefinition":"…"}],"nextCursor":1}
{"version":1,"kind":"ack","requestId":"browser-3"}
{"version":1,"kind":"message","topicId":"points","sequence":"42","sourceTimeNanos":"123000000","receiptTimeNanos":"123100000","typeName":"sensor_msgs/msg/PointCloud2","encoding":"cdr","payloadBase64":"AAECAw==","relayDroppedMessages":3,"relayDropReason":"topic-rate-limit"}
```

Integer time and sequence fields are decimal strings to avoid JavaScript precision loss. The baseline JSON/base64 message event is intentionally simple and interoperable, but adds encoding overhead; a future binary profile must be independently versioned and bounded rather than silently changing this contract.

Discovery is cursor-paginated so every response stays within the 256 KiB control-frame budget. The browser starts at cursor `0` and requests each strictly increasing `nextCursor` until it is omitted. A topic may include `schemaEncoding` and `schemaDefinition`; each schema is capped at 64 KiB. Native standard ROS types may omit them because the viewer has bounded native decoders. An unknown/custom type without a definition remains opaque/raw-only; the viewer never invents schema capability. Message `typeName` and `encoding` are bound to discovery, and per-topic sequences must increase monotonically. `relayDroppedMessages` is a monotonic per-session counter; `relayDropReason` reports the latest bounded size, rate, or queue limit. Replayed, out-of-order, mismatched, oversized, or over-budget frames are dropped with visible degraded telemetry. The browser queue is bounded to 256 messages and 16 MiB.

## Relay responsibilities

The remote relay must validate TLS, the WebSocket transport `Origin`, the authenticated `browserOrigin` against that same transport origin, session token, exact topic allowlist, schema/type binding, rate/size/queue limits, and expiry/revocation before forwarding data. The bundled bridges cap token lifetime at 24 hours, return the absolute expiry in `ready`, close active sockets at expiry, and treat token rotation plus bridge restart as immediate revocation. The relay—not the browser—owns ROS1/ROS2 network reachability and generation-specific adapters.
