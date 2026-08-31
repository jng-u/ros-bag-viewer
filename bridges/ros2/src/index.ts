import {
  PrivateEdgeRuntime,
  type EdgeRuntimeConfig,
  type EdgeRuntimeLimits,
  type PrivateListenerConfig,
  type RelayEdgeIdentity,
  type TopicDescriptor,
} from "../../../packages/edge-runtime/src/index.js";

export interface Ros2PrivateEdgeConfig {
  readonly listener: PrivateListenerConfig;
  readonly allowedRelayIds: readonly string[];
  readonly allowedTopics: readonly TopicDescriptor[];
  readonly allowlistDigest: string;
  readonly verifyRelayCredential: (identity: RelayEdgeIdentity) => boolean;
  readonly limits?: EdgeRuntimeLimits;
  readonly domainId: number;
  readonly localhostOnly: true;
}

export function createRos2PrivateEdgeAdapter(config: Ros2PrivateEdgeConfig): PrivateEdgeRuntime {
  if (!Number.isSafeInteger(config.domainId) || config.domainId < 0 || config.domainId > 232) {
    throw new Error("ROS2 domainId must be an integer from 0 through 232");
  }
  if (config.localhostOnly !== true) throw new Error("ROS2 reference adapter requires localhost-only discovery");
  const runtimeConfig: EdgeRuntimeConfig = {
    generation: "ros2",
    listener: config.listener,
    allowedRelayIds: config.allowedRelayIds,
    allowedTopics: config.allowedTopics,
    allowlistDigest: config.allowlistDigest,
    verifyRelayCredential: config.verifyRelayCredential,
    ...(config.limits ? { limits: config.limits } : {}),
  };
  return new PrivateEdgeRuntime(runtimeConfig);
}
