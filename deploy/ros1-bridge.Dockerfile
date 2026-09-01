FROM ros:noetic-ros-core-focal@sha256:fd6279f04e51fa61201a791da9a156129941887b95b614ae0cec7865ef49de4f
RUN apt-get update && apt-get install -y --no-install-recommends python3-websockets ros-noetic-common-msgs ros-noetic-tf2-msgs && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin rosviewer
COPY bridges/runtime/ros_live_bridge.py /opt/ros-web-viewer/ros_live_bridge.py
COPY bridges/runtime/publish_ros1_fixture.py /opt/ros-web-viewer/publish_ros1_fixture.py
ENV ROS_GENERATION=ros1 PORT=8765 TOPIC_ALLOWLIST_FILE=/config/topics.json
EXPOSE 8765
USER rosviewer
CMD ["python3", "/opt/ros-web-viewer/ros_live_bridge.py"]
