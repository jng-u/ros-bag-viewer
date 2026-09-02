export interface ResolvedRosSchema {
  readonly definition: string;
  readonly encoding: "ros2msg";
}

const ROS2_IMU_DEFINITION = `std_msgs/Header header
geometry_msgs/Quaternion orientation
float64[9] orientation_covariance
geometry_msgs/Vector3 angular_velocity
float64[9] angular_velocity_covariance
geometry_msgs/Vector3 linear_acceleration
float64[9] linear_acceleration_covariance
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: geometry_msgs/Quaternion
float64 x
float64 y
float64 z
float64 w
================================================================================
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
`;

function normalizedTypeName(typeName: string): string {
  return typeName.replace("/msg/", "/");
}

/** Built-in definitions used only when a ROS2 transport cannot embed its standard schema. */
export function standardRosSchema(typeName: string, messageEncoding: string): ResolvedRosSchema | undefined {
  if (messageEncoding.toLocaleLowerCase() !== "cdr") return undefined;
  if (normalizedTypeName(typeName) === "sensor_msgs/Imu") return { definition: ROS2_IMU_DEFINITION, encoding: "ros2msg" };
  return undefined;
}
