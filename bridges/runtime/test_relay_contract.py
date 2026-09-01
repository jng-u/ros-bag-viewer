import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


class RelayContractTest(unittest.TestCase):
    def load_bridge(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as allowlist:
            json.dump([{"id": "topic", "name": "/topic", "typeName": "demo_msgs/msg/Value"}], allowlist)
            allowlist_path = allowlist.name
        self.addCleanup(lambda: Path(allowlist_path).unlink(missing_ok=True))
        os.environ.update({
            "ROS_GENERATION": "ros2",
            "SESSION_TOKEN": "0123456789abcdef0123456789abcdef",
            "TOPIC_ALLOWLIST_FILE": allowlist_path,
        })
        module_path = Path(__file__).with_name("ros_live_bridge.py")
        spec = importlib.util.spec_from_file_location("ros_live_bridge_contract_test", module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_discovery_pages_never_exceed_control_budget_and_preserve_schemas(self):
        bridge = self.load_bridge()
        schema = "string value\n" + "#" * 60_000
        discovered = [
            {
                "id": f"topic-{index}",
                "name": f"/topic/{index}",
                "typeName": f"demo_msgs/msg/Value{index}",
                "encoding": "cdr",
                "schemaEncoding": "ros2msg",
                "schemaDefinition": schema,
            }
            for index in range(12)
        ]
        cursor = 0
        collected = []
        pages = 0
        while True:
            page = bridge.discovery_page(discovered, cursor, f"request-{pages}")
            self.assertLessEqual(len(json.dumps(page, separators=(",", ":")).encode("utf-8")), bridge.MAX_CONTROL_BYTES)
            collected.extend(page["topics"])
            pages += 1
            if "nextCursor" not in page:
                break
            self.assertGreater(page["nextCursor"], cursor)
            cursor = page["nextCursor"]
        self.assertGreater(pages, 1)
        self.assertEqual([item["id"] for item in collected], [item["id"] for item in discovered])
        self.assertTrue(all(item["schemaDefinition"] == schema for item in collected))

    def test_ros1_schema_admission_keeps_exactly_64_kib_and_omits_oversize_definitions(self):
        bridge = self.load_bridge()
        exact = "x" * bridge.MAX_SCHEMA_BYTES
        self.assertEqual(bridge.bounded_ros1_schema(exact), exact)
        self.assertIsNone(bridge.bounded_ros1_schema(exact + "x"))
        self.assertIsNone(bridge.bounded_ros1_schema("한" * ((bridge.MAX_SCHEMA_BYTES // 3) + 1)))


class RelayTelemetryTest(unittest.IsolatedAsyncioTestCase):
    async def test_telemetry_send_failure_closes_the_affected_session(self):
        bridge = RelayContractTest().load_bridge()

        class FailingWebSocket:
            close_call = None

            async def send(self, _value):
                raise RuntimeError("socket failed")

            async def close(self, code, reason):
                self.close_call = (code, reason)

        websocket = FailingWebSocket()
        session = bridge.ClientSession(websocket)
        session.dropped_messages = 1
        session.last_drop_reason = "queue-byte-limit"
        await session.send_drop_telemetry()
        self.assertEqual(websocket.close_call[0], 1011)
        self.assertIn("telemetry delivery failed", websocket.close_call[1])
        await session.close()


if __name__ == "__main__":
    unittest.main()
