# Docker ROS1/ROS2 live bridge deployment

The repository ships separate, subscribe-only ROS1 Noetic and ROS2 Jazzy bridges. The browser protocol exposes discovery, explicit allowlisted subscription, and unsubscribe only—no publish, service, action, parameter, wildcard, or arbitrary command operation.

## Local endpoints

The Compose profiles use host networking for ROS discovery and bind the WebSocket listeners to loopback only:

| Generation | Browser endpoint | ROS connection |
|---|---|---|
| ROS1 | `ws://127.0.0.1:8765` | `ROS_MASTER_URI` (default `http://127.0.0.1:11311`) |
| ROS2 | `ws://127.0.0.1:8766` | DDS domain `ROS_DOMAIN_ID` (default `0`) |

The viewer remains at `http://127.0.0.1:8080`. Caddy does **not** proxy the bridge sockets; this prevents a nominally local bridge from becoming reachable through a remotely bound viewer route.

```bash
export ROS_LIVE_SESSION_TOKEN="$(openssl rand -hex 32)"
export ROS_LIVE_SESSION_TTL_SECONDS=3600
export ROS_LIVE_BROWSER_ORIGINS=http://127.0.0.1:8080,http://localhost:8080

# Choose either or both profiles.
docker compose --profile ros1 --profile ros2 up --build -d
```

Use **LIVE** in the browser and enter the generation-specific endpoint above plus the exact token. ROS1 topics are controlled by [`deploy/live-topics.ros1.json`](../deploy/live-topics.ros1.json); ROS2 topics by [`deploy/live-topics.ros2.json`](../deploy/live-topics.ros2.json). Each allowlist is capped at 32 exact topics.

## Deterministic fixture publishers

The images contain the same publishers used by browser E2E. Start a ROS1 master if one is not already running:

```bash
docker run -d --rm --name rvw-ros1-master --network host \
  --entrypoint bash ros-web-viewer-ros1-bridge:local -lc \
  'source /opt/ros/noetic/setup.bash; roscore'

docker run -d --rm --name rvw-ros1-fixture --network host \
  -e ROS_MASTER_URI=http://127.0.0.1:11311 \
  --entrypoint bash ros-web-viewer-ros1-bridge:local -lc \
  'source /opt/ros/noetic/setup.bash; python3 /opt/ros-web-viewer/publish_ros1_fixture.py'

docker run -d --rm --name rvw-ros2-fixture --network host \
  -e ROS_DOMAIN_ID=0 -e FASTDDS_BUILTIN_TRANSPORTS=UDPv4 \
  --entrypoint bash ros-web-viewer-ros2-bridge:local -lc \
  'source /opt/ros/jazzy/setup.bash; python3 /opt/ros-web-viewer/publish_ros2_fixture.py'
```

ROS1 publishes `/tf` and `/scan`. ROS2 also publishes `/viewer/plane` to prove schema-backed generic raw inspection and numeric plotting.

## Browser verification and latency targets

```bash
ROS_GENERATION=ros1 LIVE_ENDPOINT=ws://127.0.0.1:8765 \
LIVE_TOKEN="$ROS_LIVE_SESSION_TOKEN" corepack pnpm test:e2e:live-bridge

ROS_GENERATION=ros2 LIVE_ENDPOINT=ws://127.0.0.1:8766 \
LIVE_TOKEN="$ROS_LIVE_SESSION_TOKEN" corepack pnpm test:e2e:live-bridge
```

The runner requires a recovered `ready` state, TF and LaserScan simultaneously `READY`, zero layer errors, zero drops, at least one successful display update, relay latency at most 50 ms, and browser delivery latency at most 100 ms. The ROS2 lane additionally requires the custom raw tree and a numeric plot.

## Remote deployment boundary

- Plain `ws://` is accepted only on loopback. A remote ROS host must put its own authenticated TLS reverse proxy in front of `127.0.0.1:8765` or `127.0.0.1:8766`, expose `wss://`, and add the exact HTTPS viewer Origin to the allowlist.
- Never change `BIND_HOST`; the bundled bridge refuses non-loopback addresses. Use the separate TLS proxy as the intentional public boundary.
- Tokens are at least 16 characters, expire after 60 seconds–24 hours, and active sockets close at expiry. Rotate the token and recreate the bridge for immediate revocation.
- Both bridge containers run as UID 10001, read-only, with all capabilities dropped and `no-new-privileges` enabled.
