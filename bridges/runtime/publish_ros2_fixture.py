#!/usr/bin/env python3
"""Deterministic ROS2 TF, LaserScan, and custom-schema publisher for E2E."""

import math

import rclpy
from geometry_msgs.msg import TransformStamped
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from shape_msgs.msg import Plane
from tf2_msgs.msg import TFMessage


class FixturePublisher(Node):
    def __init__(self):
        super().__init__("ros_web_viewer_e2e_fixture")
        self.tf_publisher = self.create_publisher(TFMessage, "/tf", 10)
        self.scan_publisher = self.create_publisher(LaserScan, "/scan", 10)
        self.plane_publisher = self.create_publisher(Plane, "/viewer/plane", 10)
        self.create_timer(0.1, self.publish_fixture)

    def publish_fixture(self):
        stamp = self.get_clock().now().to_msg()
        transform = TransformStamped()
        transform.header.stamp = stamp
        transform.header.frame_id = "map"
        transform.child_frame_id = "lidar"
        transform.transform.translation.x = 1.25
        transform.transform.translation.y = -0.5
        transform.transform.translation.z = 0.4
        transform.transform.rotation.w = 1.0
        scan = LaserScan()
        scan.header.stamp = stamp
        scan.header.frame_id = "lidar"
        scan.angle_min = -math.pi
        scan.angle_increment = 2 * math.pi / 180
        scan.angle_max = scan.angle_min + 179 * scan.angle_increment
        scan.range_min = 0.2
        scan.range_max = 20.0
        scan.ranges = [3.5 + math.sin(index * 0.12) * 0.4 for index in range(180)]
        plane = Plane()
        plane.coef = [1.0, 0.0, 0.0, -2.5]
        self.tf_publisher.publish(TFMessage(transforms=[transform]))
        self.scan_publisher.publish(scan)
        self.plane_publisher.publish(plane)


def main():
    rclpy.init()
    node = FixturePublisher()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
