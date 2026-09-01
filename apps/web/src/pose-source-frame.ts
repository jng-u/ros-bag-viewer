/** Headerless geometry_msgs/Pose is interpreted in the explicitly selected fixed frame. */
export function poseSourceFrame(messageFrame: string, fixedFrame: string): string {
  const normalizedMessage = messageFrame.replace(/^\/+|\/+$/gu, "");
  const normalizedFixed = fixedFrame.replace(/^\/+|\/+$/gu, "");
  if (normalizedMessage) return normalizedMessage;
  if (!normalizedFixed) throw new Error("Headerless Pose requires a non-empty fixed frame");
  return normalizedFixed;
}
