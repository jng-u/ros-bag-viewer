#!/usr/bin/env python3
"""Deterministic ROS1 TF and LaserScan publisher for the browser bridge E2E."""

import math

import rospy
from geometry_msgs.msg import TransformStamped
from sensor_msgs.msg import LaserScan
from tf2_msgs.msg import TFMessage


def main():
    rospy.init_node("ros_web_viewer_e2e_fixture", anonymous=True)
    tf_publisher = rospy.Publisher("/tf", TFMessage, queue_size=4)
    scan_publisher = rospy.Publisher("/scan", LaserScan, queue_size=4)
    rate = rospy.Rate(10)
    while not rospy.is_shutdown():
        stamp = rospy.Time.now()
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
        tf_publisher.publish(TFMessage([transform]))
        scan_publisher.publish(scan)
        rate.sleep()


if __name__ == "__main__":
    main()
