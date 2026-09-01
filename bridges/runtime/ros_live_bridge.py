#!/usr/bin/env python3
"""Generation-specific, subscribe-only ROS-to-browser relay.

ROS1 forwards rospy.AnyMsg serialized buffers. ROS2 serializes typed messages
with rclpy.serialization.serialize_message. No publish/service/action/parameter
operation is implemented.
"""

import asyncio
import base64
from collections import deque
import hmac
import json
import os
import re
import threading
import time
import uuid

import websockets

GENERATION = os.environ.get("ROS_GENERATION", "")
PORT = int(os.environ.get("PORT", "8765"))
BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
SESSION_TOKEN = os.environ.get("SESSION_TOKEN", "")
SESSION_TTL_SECONDS = int(os.environ.get("SESSION_TTL_SECONDS", "3600"))
ALLOWLIST_FILE = os.environ.get("TOPIC_ALLOWLIST_FILE", "/config/topics.json")
ALLOWED_ORIGINS = set(filter(None, os.environ.get("ALLOWED_BROWSER_ORIGINS", "http://127.0.0.1:8080,http://localhost:8080").split(",")))
MAX_MESSAGE_BYTES = 4 * 1024 * 1024
MAX_QUEUE_BYTES = 16 * 1024 * 1024
MAX_QUEUE_MESSAGES = 256
MAX_CONTROL_BYTES = 256 * 1024
MAX_SCHEMA_BYTES = 64 * 1024
AUTH_TIMEOUT_SECONDS = int(os.environ.get("AUTH_TIMEOUT_SECONDS", "5"))
MAX_ACTIVE_SESSIONS = int(os.environ.get("MAX_ACTIVE_SESSIONS", "32"))
MAX_CONTROL_REQUESTS_PER_SECOND = int(os.environ.get("MAX_CONTROL_REQUESTS_PER_SECOND", "20"))

if GENERATION not in {"ros1", "ros2"}:
    raise RuntimeError("ROS_GENERATION must be ros1 or ros2")
if len(SESSION_TOKEN) < 16 or SESSION_TOKEN == "change-me-local":
    raise RuntimeError("SESSION_TOKEN must be replaced with at least 16 characters")
if SESSION_TTL_SECONDS < 60 or SESSION_TTL_SECONDS > 24 * 60 * 60:
    raise RuntimeError("SESSION_TTL_SECONDS must be between 60 and 86400")
if AUTH_TIMEOUT_SECONDS < 1 or AUTH_TIMEOUT_SECONDS > 30 or MAX_ACTIVE_SESSIONS < 1 or MAX_ACTIVE_SESSIONS > 256 or MAX_CONTROL_REQUESTS_PER_SECOND < 1 or MAX_CONTROL_REQUESTS_PER_SECOND > 100:
    raise RuntimeError("authentication/session limits are invalid")
if BIND_HOST not in {"127.0.0.1", "::1"}:
    raise RuntimeError("BIND_HOST must remain loopback; put a TLS reverse proxy on the ROS host for remote access")

with open(ALLOWLIST_FILE, "r", encoding="utf-8") as stream:
    configured_topics = json.load(stream)
if not isinstance(configured_topics, list) or not configured_topics or len(configured_topics) > 32:
    raise RuntimeError("topic allowlist must contain 1-32 entries")

TOPIC_PATTERN = re.compile(r"^/[A-Za-z0-9_.~/-]+$")
topics_by_id = {}
for item in configured_topics:
    if not isinstance(item, dict):
        raise RuntimeError("topic allowlist entries must be objects")
    topic_id = item.get("id")
    name = item.get("name")
    type_name = item.get("typeName")
    if not all(isinstance(value, str) and value for value in (topic_id, name, type_name)) or not TOPIC_PATTERN.fullmatch(name):
        raise RuntimeError("topic allowlist entry is invalid")
    if topic_id in topics_by_id:
        raise RuntimeError("topic allowlist ids must be unique")
    limit = int(item.get("maxMessageBytes", MAX_MESSAGE_BYTES))
    rate = float(item.get("maxRateHz", 120))
    if limit <= 0 or limit > MAX_MESSAGE_BYTES or rate <= 0 or rate > 1000:
        raise RuntimeError("topic allowlist limit is invalid")
    topics_by_id[topic_id] = {**item, "maxMessageBytes": limit, "maxRateHz": rate}


def discovery_page(discovered, cursor, request_id):
    """Return the largest deterministic discovery page inside the control budget."""
    if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0 or cursor > len(discovered):
        raise ValueError("discovery cursor is invalid")
    public_topics = []
    next_cursor = cursor
    while next_cursor < len(discovered):
        item = discovered[next_cursor]
        public_item = {key: value for key, value in item.items() if key in {"id", "name", "typeName", "encoding", "schemaEncoding", "schemaDefinition"}}
        candidate_topics = [*public_topics, public_item]
        candidate_cursor = next_cursor + 1
        candidate = {
            "version": 1,
            "kind": "discovery",
            "requestId": request_id,
            "topics": candidate_topics,
            **({"nextCursor": candidate_cursor} if candidate_cursor < len(discovered) else {}),
        }
        if len(json.dumps(candidate, separators=(",", ":")).encode("utf-8")) > MAX_CONTROL_BYTES:
            if not public_topics:
                raise ValueError("single discovery topic exceeds the control response budget")
            break
        public_topics = candidate_topics
        next_cursor = candidate_cursor
    return {
        "version": 1,
        "kind": "discovery",
        "requestId": request_id,
        "topics": public_topics,
        **({"nextCursor": next_cursor} if next_cursor < len(discovered) else {}),
    }


def bounded_ros1_schema(definition):
    """Return a schema only when its UTF-8 representation fits the relay contract."""
    if not isinstance(definition, str) or not definition:
        return None
    if len(definition.encode("utf-8")) > MAX_SCHEMA_BYTES:
        return None
    return definition


class Ros1Backend:
    def __init__(self):
        import roslib.message
        import rospy
        self.roslib_message = roslib.message
        self.rospy = rospy
        rospy.init_node("ros_web_viewer_bridge", anonymous=True, disable_signals=True)

    def discover(self):
        published = dict(self.rospy.get_published_topics())
        result = []
        for item in topics_by_id.values():
            if published.get(item["name"]) != item["typeName"]:
                continue
            message_class = self.roslib_message.get_message_class(item["typeName"])
            definition = bounded_ros1_schema(getattr(message_class, "_full_text", None) if message_class else None)
            result.append({
                **item,
                "encoding": "ros1",
                **({"schemaEncoding": "ros1msg", "schemaDefinition": definition} if definition else {}),
            })
        return result

    def subscribe(self, item, callback):
        subscriber = self.rospy.Subscriber(item["name"], self.rospy.AnyMsg, lambda message: callback(bytes(message._buff)), queue_size=1, buff_size=item["maxMessageBytes"] + 65536)
        return subscriber.unregister


class Ros2Backend:
    def __init__(self):
        import rclpy
        from rclpy.executors import SingleThreadedExecutor
        self.rclpy = rclpy
        self.serialization = __import__("rclpy.serialization", fromlist=["serialize_message"])
        self.get_message = __import__("rosidl_runtime_py.utilities", fromlist=["get_message"]).get_message
        self.get_interface_path = __import__("rosidl_runtime_py", fromlist=["get_interface_path"]).get_interface_path
        rclpy.init()
        self.node = rclpy.create_node("ros_web_viewer_bridge")
        self.executor = SingleThreadedExecutor()
        self.executor.add_node(self.node)
        threading.Thread(target=self.executor.spin, name="ros2-executor", daemon=True).start()

    def discover(self):
        published = {name: set(types) for name, types in self.node.get_topic_names_and_types()}
        result = []
        for item in topics_by_id.values():
            if item["typeName"] not in published.get(item["name"], set()):
                continue
            result.append({**item, "encoding": "cdr", "schemaEncoding": "ros2msg", "schemaDefinition": self.schema_definition(item["typeName"])})
        return result

    def schema_definition(self, root_type):
        primitive = {"bool", "byte", "char", "float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "string", "wstring"}
        pending = [root_type]
        seen = set()
        sections = []
        total_bytes = 0
        while pending:
            type_name = pending.pop(0)
            if type_name in seen:
                continue
            seen.add(type_name)
            with open(self.get_interface_path(type_name), "r", encoding="utf-8") as stream:
                definition = stream.read(MAX_SCHEMA_BYTES + 1)
            if len(definition.encode("utf-8")) > MAX_SCHEMA_BYTES:
                raise RuntimeError("ROS2 interface definition exceeds the per-type schema limit")
            section = "MSG: {}\n{}".format(type_name, definition.rstrip())
            total_bytes += len(section.encode("utf-8"))
            if len(seen) > 128 or total_bytes > MAX_SCHEMA_BYTES:
                raise RuntimeError("ROS2 interface dependency graph exceeds the schema limit")
            sections.append(section)
            package = type_name.split("/", 1)[0]
            for source_line in definition.splitlines():
                line = source_line.split("#", 1)[0].strip()
                if not line or "=" in line:
                    continue
                field_type = line.split()[0]
                field_type = re.sub(r"\[.*\]$", "", field_type)
                field_type = re.sub(r"<=\d+$", "", field_type)
                if field_type in primitive:
                    continue
                if field_type == "Header":
                    field_type = "std_msgs/msg/Header"
                elif "/" not in field_type:
                    field_type = "{}/msg/{}".format(package, field_type)
                elif "/msg/" not in field_type:
                    parts = field_type.split("/")
                    field_type = "{}/msg/{}".format(parts[0], parts[-1])
                if field_type not in seen:
                    pending.append(field_type)
        return "\n================================================================================\n".join(sections) + "\n"

    def subscribe(self, item, callback):
        from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
        message_type = self.get_message(item["typeName"])
        is_static_tf = item["name"] == "/tf_static" or item["name"].endswith("/tf_static")
        qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=100 if is_static_tf else 1,
            reliability=ReliabilityPolicy.RELIABLE if is_static_tf else ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.TRANSIENT_LOCAL if is_static_tf else DurabilityPolicy.VOLATILE,
        )
        subscription = self.node.create_subscription(message_type, item["name"], lambda message: callback(bytes(self.serialization.serialize_message(message))), qos)
        return lambda: self.node.destroy_subscription(subscription)


backend = None
active_sessions = set()
active_connections = set()


async def run_blocking(function):
    return await asyncio.get_running_loop().run_in_executor(None, function)


class ClientSession:
    def __init__(self, websocket):
        self.websocket = websocket
        self.loop = asyncio.get_running_loop()
        self.queue = asyncio.Queue(maxsize=MAX_QUEUE_MESSAGES)
        self.queue_bytes = 0
        self.subscriptions = {}
        self.sequences = {}
        self.last_message_ns = {}
        self.dropped_messages = 0
        self.last_drop_reason = None
        self.available = {}
        self.discovery_snapshot = None
        self.authenticated = False
        self.expires_at = None
        self.session_id = uuid.uuid4().hex
        self.sender = asyncio.create_task(self.send_messages())
        self.expiry = None
        self.control_requests = deque()
        self.send_lock = asyncio.Lock()
        self.telemetry_timer = None
        self.closed = False

    def admit_control_request(self):
        current = time.monotonic()
        while self.control_requests and self.control_requests[0] <= current - 1:
            self.control_requests.popleft()
        if len(self.control_requests) >= MAX_CONTROL_REQUESTS_PER_SECOND:
            raise PermissionError("control request rate limit exceeded")
        self.control_requests.append(current)

    async def expire_session(self):
        await asyncio.sleep(max(0, self.expires_at - time.time()))
        await self.websocket.close(code=1008, reason="session token expired")

    def authenticate(self):
        if self.authenticated:
            raise PermissionError("session is already authenticated")
        self.authenticated = True
        self.expires_at = time.time() + SESSION_TTL_SECONDS
        self.expiry = asyncio.create_task(self.expire_session())

    async def send(self, value):
        serialized = json.dumps(value, separators=(",", ":"))
        if value.get("kind") != "message" and len(serialized.encode("utf-8")) > MAX_CONTROL_BYTES:
            raise ValueError("relay control response exceeds the 256 KiB protocol budget")
        async with self.send_lock:
            await self.websocket.send(serialized)

    def enqueue_from_ros(self, topic_id, item, payload):
        now_ns = time.time_ns()
        minimum_interval = int(1_000_000_000 / item["maxRateHz"])
        if len(payload) > item["maxMessageBytes"]:
            self.record_drop("message-size-limit")
            return
        if now_ns - self.last_message_ns.get(topic_id, 0) < minimum_interval:
            self.record_drop("topic-rate-limit")
            return
        self.last_message_ns[topic_id] = now_ns
        self.loop.call_soon_threadsafe(self.enqueue, topic_id, item, payload, now_ns)

    def record_drop(self, reason):
        self.dropped_messages += 1
        self.last_drop_reason = reason
        self.loop.call_soon_threadsafe(self.schedule_drop_telemetry)

    def schedule_drop_telemetry(self):
        if self.closed or self.telemetry_timer is not None:
            return
        self.telemetry_timer = self.loop.call_later(0.1, lambda: asyncio.create_task(self.send_drop_telemetry()))

    async def send_drop_telemetry(self):
        self.telemetry_timer = None
        if self.closed:
            return
        try:
            await self.send({
                "version": 1,
                "kind": "telemetry",
                "relayDroppedMessages": self.dropped_messages,
                **({"relayDropReason": self.last_drop_reason} if self.last_drop_reason else {}),
            })
        except Exception as error:
            self.closed = True
            await self.websocket.close(code=1011, reason=("telemetry delivery failed: " + str(error))[:120])

    def enqueue(self, topic_id, item, payload, source_time_ns):
        if topic_id not in self.subscriptions:
            return
        if self.queue.full():
            self.record_drop("queue-message-limit")
            return
        if self.queue_bytes + len(payload) > MAX_QUEUE_BYTES:
            self.record_drop("queue-byte-limit")
            return
        self.queue_bytes += len(payload)
        self.queue.put_nowait((topic_id, item, payload, source_time_ns))

    async def send_messages(self):
        while True:
            topic_id, item, payload, source_time_ns = await self.queue.get()
            try:
                sequence = self.sequences.get(topic_id, 0) + 1
                self.sequences[topic_id] = sequence
                await self.send({
                    "version": 1,
                    "kind": "message",
                    "topicId": topic_id,
                    "sequence": str(sequence),
                    "sourceTimeNanos": str(source_time_ns),
                    "receiptTimeNanos": str(time.time_ns()),
                    "typeName": item["typeName"],
                    "encoding": item["encoding"],
                    "payloadBase64": base64.b64encode(payload).decode("ascii"),
                    "relayDroppedMessages": self.dropped_messages,
                    **({"relayDropReason": self.last_drop_reason} if self.last_drop_reason else {}),
                })
            finally:
                self.queue_bytes -= len(payload)
                self.queue.task_done()

    async def replace_subscriptions(self, topic_ids):
        if backend is None:
            raise RuntimeError("ROS backend is not initialized")
        desired = set(topic_ids)
        if len(desired) != len(topic_ids) or len(desired) > 32 or not desired.issubset(self.available):
            raise ValueError("subscription must contain unique discovered topic ids")
        for topic_id in set(self.subscriptions) - desired:
            self.subscriptions.pop(topic_id)()
        for topic_id in desired - set(self.subscriptions):
            item = self.available[topic_id]
            self.subscriptions[topic_id] = backend.subscribe(item, lambda payload, tid=topic_id, value=item: self.enqueue_from_ros(tid, value, payload))

    async def close(self):
        self.closed = True
        if self.telemetry_timer:
            self.telemetry_timer.cancel()
            self.telemetry_timer = None
        for close in self.subscriptions.values():
            close()
        self.subscriptions.clear()
        self.sender.cancel()
        if self.expiry:
            self.expiry.cancel()
            await asyncio.gather(self.sender, self.expiry, return_exceptions=True)
        else:
            await asyncio.gather(self.sender, return_exceptions=True)


async def handler(websocket, *_):
    if websocket.subprotocol != "ros-viewer.subscribe.v1":
        await websocket.close(code=1002, reason="required subprotocol missing")
        return
    transport_origin = websocket.request_headers.get("Origin")
    if transport_origin not in ALLOWED_ORIGINS:
        await websocket.close(code=1008, reason="browser origin is not allowed")
        return
    if len(active_connections) >= MAX_ACTIVE_SESSIONS:
        await websocket.close(code=1013, reason="session capacity reached")
        return
    connection_id = id(websocket)
    active_connections.add(connection_id)
    session = None
    try:
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=AUTH_TIMEOUT_SECONDS)
            if not isinstance(raw, str) or len(raw) > 256 * 1024:
                raise PermissionError("invalid authentication frame")
            request = json.loads(raw)
            request_id = request.get("requestId")
            origin = request.get("browserOrigin")
            supplied = request.get("sessionToken", "")
            if request.get("version") != 1 or not isinstance(request_id, str) or request.get("operation") != "authenticate":
                raise PermissionError("authenticate first")
            if origin != transport_origin or origin not in ALLOWED_ORIGINS or not hmac.compare_digest(str(supplied), SESSION_TOKEN):
                raise PermissionError("authentication failed")
        except Exception as error:
            await websocket.close(code=1008, reason=str(error)[:120])
            return
        if len(active_sessions) >= MAX_ACTIVE_SESSIONS:
            await websocket.close(code=1013, reason="session capacity reached")
            return
        session = ClientSession(websocket)
        active_sessions.add(session.session_id)
        session.authenticate()
        await session.send({"version": 1, "kind": "ready", "requestId": request_id, "sessionId": session.session_id, "expiresAtMs": int(session.expires_at * 1000)})
        async for raw in websocket:
            if not isinstance(raw, str) or len(raw) > 256 * 1024:
                await websocket.close(code=1009, reason="control frame too large")
                return
            request = {}
            try:
                request = json.loads(raw)
                request_id = request.get("requestId")
                if request.get("version") != 1 or not isinstance(request_id, str):
                    raise ValueError("invalid request")
                operation = request.get("operation")
                session.admit_control_request()
                if operation == "discover":
                    cursor = request.get("cursor", 0)
                    if cursor == 0:
                        discovered = await run_blocking(backend.discover)
                        session.discovery_snapshot = discovered
                        session.available = {item["id"]: item for item in discovered}
                    elif session.discovery_snapshot is None:
                        raise ValueError("discovery must begin at cursor zero")
                    else:
                        discovered = session.discovery_snapshot
                    await session.send(discovery_page(discovered, cursor, request_id))
                elif operation == "subscribe":
                    await session.replace_subscriptions(request.get("topicIds", []))
                    await session.send({"version": 1, "kind": "ack", "requestId": request_id})
                elif operation == "unsubscribe":
                    remaining = set(session.subscriptions) - set(request.get("topicIds", []))
                    await session.replace_subscriptions(list(remaining))
                    await session.send({"version": 1, "kind": "ack", "requestId": request_id})
                else:
                    raise PermissionError("operation is not available in read-only bridge")
            except Exception as error:
                await session.send({"version": 1, "kind": "error", "requestId": request.get("requestId") if isinstance(request, dict) else None, "message": str(error)})
    finally:
        active_connections.discard(connection_id)
        if session:
            active_sessions.discard(session.session_id)
            await session.close()


async def main():
    global backend
    backend = Ros1Backend() if GENERATION == "ros1" else Ros2Backend()
    async with websockets.serve(handler, BIND_HOST, PORT, subprotocols=["ros-viewer.subscribe.v1"], max_size=256 * 1024, max_queue=16, compression=None):
        print(f"{GENERATION} read-only relay listening on {BIND_HOST}:{PORT}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
