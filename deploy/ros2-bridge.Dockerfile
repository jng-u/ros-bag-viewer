FROM ros:jazzy-ros-core@sha256:fb9a5620bb92e133047c62555e307a2a481bde384c70595ceae464bc84e51df1
RUN apt-get update && apt-get install -y --no-install-recommends python3-websockets ros-jazzy-common-interfaces ros-jazzy-rosidl-runtime-py ros-jazzy-tf2-msgs ros-jazzy-visualization-msgs && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin rosviewer
COPY bridges/runtime/ros_live_bridge.py /opt/ros-web-viewer/ros_live_bridge.py
COPY bridges/runtime/publish_ros2_fixture.py /opt/ros-web-viewer/publish_ros2_fixture.py
ENV ROS_GENERATION=ros2 PORT=8766 TOPIC_ALLOWLIST_FILE=/config/topics.json
EXPOSE 8766
USER rosviewer
CMD ["python3", "/opt/ros-web-viewer/ros_live_bridge.py"]
