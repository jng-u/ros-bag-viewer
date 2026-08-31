import {
  PrivateEdgeRuntime,
  type EdgeRuntimeConfig,
  type EdgeRuntimeLimits,
  type PrivateListenerConfig,
  type RelayEdgeIdentity,
  type TopicDescriptor,
} from "../../../packages/edge-runtime/src/index.js";

export interface Ros1EolIsolation {
  readonly lifecycle: "separate-process";
  readonly filesystem: "read-only";
  readonly processUser: "non-root";
  readonly browserIngress: false;
  readonly ros2DomainAccess: false;
}

export interface Ros1PrivateEdgeConfig {
  readonly listener: PrivateListenerConfig;
  readonly allowedRelayIds: readonly string[];
  readonly allowedTopics: readonly TopicDescriptor[];
  readonly allowlistDigest: string;
  readonly verifyRelayCredential: (identity: RelayEdgeIdentity) => boolean;
  readonly limits?: EdgeRuntimeLimits;
  readonly eolIsolation: Ros1EolIsolation;
}

export function createRos1PrivateEdgeAdapter(config: Ros1PrivateEdgeConfig): PrivateEdgeRuntime {
  const isolation = config.eolIsolation;
  if (
    isolation.lifecycle !== "separate-process"
    || isolation.filesystem !== "read-only"
    || isolation.processUser !== "non-root"
    || isolation.browserIngress !== false
    || isolation.ros2DomainAccess !== false
  ) {
    throw new Error("ROS1 EOL adapter requires the locked separate-process isolation profile");
  }
  const runtimeConfig: EdgeRuntimeConfig = {
    generation: "ros1",
    listener: config.listener,
    allowedRelayIds: config.allowedRelayIds,
    allowedTopics: config.allowedTopics,
    allowlistDigest: config.allowlistDigest,
    verifyRelayCredential: config.verifyRelayCredential,
    ...(config.limits ? { limits: config.limits } : {}),
  };
  return new PrivateEdgeRuntime(runtimeConfig);
}
