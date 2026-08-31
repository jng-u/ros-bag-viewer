import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

import { rangeSummaryExtension } from "../../../examples/range-summary-extension/src/index.js";
import {
  TRUSTED_EXTENSION_API_VERSION,
  TrustedExtensionHost,
  type TrustedExtensionCapability,
  type TrustedExtensionContext,
  type TrustedExtensionDefinition,
  type TrustedExtensionLifecycle,
  type TrustedResourceHandle,
} from "../src/index.js";

interface Harness {
  readonly calls: string[];
  readonly definition: TrustedExtensionDefinition<{ readonly enabled: boolean }, { readonly value: number }>;
  context?: TrustedExtensionContext;
}

function harness(capabilities: readonly TrustedExtensionCapability[] = ["source-messages"]): Harness {
  const result: Harness = {
    calls: [],
    definition: {
      apiVersion: TRUSTED_EXTENSION_API_VERSION,
      id: "harness",
      requiredCapabilities: capabilities,
      create(context) {
        result.context = context;
        return {
          configure: () => result.calls.push("configure"),
          attachSource: (epoch) => result.calls.push(`attach:${epoch}`),
          update: (message) => result.calls.push(`update:${message.value.value}`),
          render: () => result.calls.push("render"),
          suspend: () => result.calls.push("suspend"),
          handleError: (error) => result.calls.push(`error:${error.message}`),
          dispose: () => result.calls.push("dispose"),
        };
      },
    },
  };
  return result;
}

describe("TrustedExtensionHost conformance", () => {
  it("negotiates an exact immutable v1 capability set and snapshots registration", () => {
    const requested: TrustedExtensionCapability[] = ["source-messages", "diagnostics"];
    const value = harness(requested);
    const host = new TrustedExtensionHost();
    const negotiation = host.register(value.definition);
    requested.push("bounded-resources");

    expect(negotiation).toEqual({
      apiVersion: 1,
      extensionId: "harness",
      grantedCapabilities: ["diagnostics", "source-messages"],
    });
    expect(Object.isFrozen(negotiation)).toBe(true);
    expect(Object.isFrozen(negotiation.grantedCapabilities)).toBe(true);
    expect(host.instantiate("harness", "first")).toBeDefined();
    expect(value.context?.capabilities).toEqual(["diagnostics", "source-messages"]);
  });

  it.each([0, 2, "1", null, undefined, Number.NaN])("rejects unsupported API version %p atomically", (apiVersion) => {
    const host = new TrustedExtensionHost();
    const create = vi.fn();
    const definition = {
      apiVersion,
      id: "wrong-version",
      requiredCapabilities: [],
      create,
    } as unknown as TrustedExtensionDefinition;
    expect(() => host.register(definition)).toThrow(/unsupported extension API version/);
    expect(create).not.toHaveBeenCalled();
    expect(host.registeredExtensionIds()).toEqual([]);
  });

  it("rejects operation widening, duplicate capabilities, and denied privileged capability names", () => {
    const host = new TrustedExtensionHost({ allowedCapabilities: ["source-messages"] });
    const extra = { ...harness().definition, loadModule: () => undefined };
    expect(() => host.register(extra)).toThrow(/unsupported operations/);
    expect(() => host.register(harness(["source-messages", "source-messages"]).definition)).toThrow(/unique/);
    expect(() => host.register(harness(["diagnostics"]).definition)).toThrow(/capability denied/);
    expect(() => host.register(harness(["ros-write" as TrustedExtensionCapability]).definition)).toThrow(
      /unsupported extension capability/,
    );
    expect(host.registeredExtensionIds()).toEqual([]);
    const hidden = harness().definition as TrustedExtensionDefinition & Record<string, unknown>;
    Object.defineProperty(hidden, "publish", { value: () => undefined });
    expect(() => host.register(hidden)).toThrow(/unsupported operations/);
    expect(() => host.register(Object.assign(Object.create({ publish() {} }), harness().definition))).toThrow(/plain objects/);
  });

  it("exposes only the frozen bounded host surface and validates lifecycle operations exactly", () => {
    const value = harness(["source-messages", "diagnostics", "bounded-resources"]);
    const host = new TrustedExtensionHost();
    host.register(value.definition);
    const instance = host.instantiate("harness", "safe-surface");

    expect(Object.keys(value.context ?? {}).sort()).toEqual([
      "allocateResource",
      "apiVersion",
      "capabilities",
      "emitDiagnostic",
    ]);
    expect(Object.isFrozen(value.context)).toBe(true);
    for (const denied of [
      "webgl",
      "worker",
      "storage",
      "credentials",
      "hostedGrant",
      "relay",
      "ros",
      "publish",
      "callService",
      "sendAction",
      "setParameter",
      "rawCommand",
      "loadModule",
      "eval",
    ]) {
      expect(Reflect.has(value.context as object, denied)).toBe(false);
    }

    expect(() => instance.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: { value: 1 } })).toThrow(
      /invalid while extension is instantiated/,
    );
    expect(() => instance.render()).toThrow(/invalid while extension is instantiated/);
    instance.configure({ enabled: true });
    instance.attachSource(1);
    instance.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: { value: 7 } });
    instance.render();
    instance.suspend();
    instance.dispose();
    instance.dispose();
    expect(value.calls).toEqual(["configure", "attach:1", "update:7", "render", "suspend", "dispose"]);
    expect(instance.telemetry().lifecycle).toEqual([
      "registered",
      "instantiated",
      "configured",
      "attached",
      "rendering",
      "suspended",
      "disposed",
    ]);
    expect(() => instance.configure({ enabled: false })).toThrow(/disposed/);
  });

  it("rejects stale or rolled-back epochs before callbacks and invalidates old handles on advance", () => {
    const handles: TrustedResourceHandle[] = [];
    let updates = 0;
    const host = new TrustedExtensionHost();
    host.register({
      apiVersion: 1,
      id: "epoch-probe",
      requiredCapabilities: ["bounded-resources", "source-messages"],
      create(context) {
        return lifecycle({
          attachSource: () => handles.push(context.allocateResource("geometry-buffer", 8)),
          update: () => {
            updates += 1;
          },
        });
      },
    });
    const instance = host.instantiate("epoch-probe", "epoch-instance");
    instance.configure({});
    instance.attachSource(2);
    expect(instance.telemetry()).toMatchObject({ activeHandles: 1, resourceBytes: 8, sourceEpoch: 2 });
    expect(() => instance.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: {} })).toThrow(/stale/);
    expect(updates).toBe(0);
    expect(() => instance.attachSource(2)).toThrow(/must advance/);
    expect(() => instance.attachSource(1)).toThrow(/must advance/);
    instance.attachSource(3);
    expect(handles[0]?.disposed).toBe(true);
    expect(instance.telemetry()).toMatchObject({ activeHandles: 1, resourceBytes: 8, sourceEpoch: 3 });
    instance.dispose();
    expect(handles[1]?.disposed).toBe(true);
    expect(instance.telemetry()).toMatchObject({ activeHandles: 0, resourceBytes: 0 });
  });

  it("delivers bounded source-detached snapshots rather than retaining caller-owned message values", () => {
    let received: { readonly nested: { value: number } } | undefined;
    const host = new TrustedExtensionHost({ limits: { maxMessageSnapshotBytes: 128 } });
    host.register({
      apiVersion: 1,
      id: "snapshot-probe",
      requiredCapabilities: ["source-messages"],
      create() {
        return lifecycle({ update: (message) => (received = message.value as { readonly nested: { value: number } }) });
      },
    });
    const instance = host.instantiate("snapshot-probe", "snapshot-instance");
    const callerOwned = { nested: { value: 1 } };
    instance.configure({});
    instance.attachSource(1);
    instance.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: callerOwned });
    callerOwned.nested.value = 2;
    expect(received).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.nested)).toBe(true);
    instance.attachSource(2);
    expect(received).toEqual({ nested: { value: 1 } });
    expect(() =>
      instance.update({ sourceEpoch: 2, topic: "/x", schemaName: "X", value: { oversized: "x".repeat(256) } }),
    ).toThrow(/snapshot byte budget exceeded/);
    expect(() =>
      instance.update({ sourceEpoch: 2, topic: "/x", schemaName: "X", value: Array.from({ length: 100 }, () => ({})) }),
    ).toThrow(/snapshot byte budget exceeded/);
  });

  it("bounds resource handles and diagnostics and cleans up after callback failures", () => {
    const handles: TrustedResourceHandle[] = [];
    const host = new TrustedExtensionHost({
      limits: {
        maxHandlesPerInstance: 2,
        maxResourceBytesPerInstance: 8,
        maxDiagnosticsPerInstance: 1,
        maxDiagnosticLength: 16,
      },
    });
    host.register({
      apiVersion: 1,
      id: "bounded-probe",
      requiredCapabilities: ["bounded-resources", "diagnostics", "source-messages"],
      create(context) {
        return lifecycle({
          update: () => {
            handles.push(context.allocateResource("text-buffer", 4));
            handles.push(context.allocateResource("texture", 4));
            context.emitDiagnostic("info", "BOUNDED", "within-budget");
            context.emitDiagnostic("warning", "DROPPED", "overflow");
            throw new Error("synthetic update failure");
          },
        });
      },
    });
    const instance = host.instantiate("bounded-probe", "bounded-instance");
    instance.configure({});
    instance.attachSource(1);
    expect(() => instance.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: {} })).toThrow(
      /synthetic update failure/,
    );
    expect(handles.every((handle) => handle.disposed)).toBe(true);
    expect(instance.telemetry()).toMatchObject({
      state: "error",
      activeHandles: 0,
      resourceBytes: 0,
      droppedDiagnostics: 1,
      lastError: "synthetic update failure",
    });
    expect(instance.telemetry().diagnostics).toHaveLength(1);
  });

  it("revokes handles allocated by a factory that fails during instantiation", () => {
    let leaked: TrustedResourceHandle | undefined;
    const host = new TrustedExtensionHost();
    host.register({
      apiVersion: 1,
      id: "failing-factory",
      requiredCapabilities: ["bounded-resources"],
      create(context) {
        leaked = context.allocateResource("text-buffer", 4);
        throw new Error("factory failed");
      },
    });

    expect(() => host.instantiate("failing-factory", "factory-instance")).toThrow(/factory failed/);
    expect(leaked?.disposed).toBe(true);
  });

  it("surfaces both an operation failure and a failing error callback", () => {
    const host = new TrustedExtensionHost();
    host.register({
      apiVersion: 1,
      id: "double-failure",
      requiredCapabilities: [],
      create() {
        return lifecycle({
          configure: () => {
            throw new Error("configure failed");
          },
          handleError: () => {
            throw new Error("error callback failed");
          },
        });
      },
    });
    const instance = host.instantiate("double-failure", "double-failure-instance");

    let failure: unknown;
    try {
      instance.configure({});
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "configure failed" }),
      expect.objectContaining({ message: "error callback failed" }),
    ]);
    expect(instance.telemetry()).toMatchObject({
      state: "error",
      lastError: "configure failed; handleError failed: error callback failed",
    });
  });

  it("revokes retained context access and requires a successful configuration", () => {
    const value = harness(["bounded-resources"]);
    const host = new TrustedExtensionHost();
    host.register(value.definition);
    const instance = host.instantiate("harness", "revoked-context");
    expect(() => value.context?.allocateResource("text-buffer", 1)).toThrow(/not active/);
    instance.dispose();
    expect(() => value.context?.allocateResource("text-buffer", 1)).toThrow(/not active/);

    const failing = new TrustedExtensionHost();
    failing.register({
      apiVersion: 1, id: "configure-failure", requiredCapabilities: [],
      create: () => lifecycle({ configure: () => { throw new Error("bad config"); } }),
    });
    const failed = failing.instantiate("configure-failure", "failed-config");
    expect(() => failed.configure({})).toThrow(/bad config/);
    expect(() => failed.attachSource(1)).toThrow(/successfully configured/);
  });
});

describe("out-of-core range summary example", () => {
  it("runs through the v1 host and releases its bounded handle", () => {
    const host = new TrustedExtensionHost({ limits: { maxResourceBytesPerInstance: 64 } });
    host.register(rangeSummaryExtension);
    const instance = host.instantiate("range-summary", "range-summary-instance");
    instance.configure({ maxSamples: 4 });
    instance.attachSource(1);
    instance.update({
      sourceEpoch: 1,
      topic: "/scan",
      schemaName: "sensor_msgs/msg/LaserScan",
      value: { ranges: [1, Number.NaN, 2, 3, 4] },
    });
    instance.render();
    expect(instance.telemetry()).toMatchObject({ state: "rendering", activeHandles: 1, resourceBytes: 24 });
    expect(instance.telemetry().diagnostics[0]?.message).toBe("topic=/scan; samples=3; epoch=1");
    instance.dispose();
    expect(instance.telemetry()).toMatchObject({ state: "disposed", activeHandles: 0, resourceBytes: 0 });
  });

  it("is private, statically linked, and imports no privileged internal package", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../../examples/range-summary-extension/package.json", import.meta.url), "utf8"),
    ) as { readonly private?: boolean; readonly dependencies?: Record<string, string> };
    const source = readFileSync(new URL("../../../examples/range-summary-extension/src/index.ts", import.meta.url), "utf8");
    expect(packageJson.private).toBe(true);
    expect(packageJson.dependencies).toEqual({ "@ros-web-viewer/extension-api": "workspace:*" });
    expect(source).not.toMatch(/@ros-web-viewer\/(?:displays-core|render-core|worker-runtime|source-|hosted-core|protocol)/);
    expect(source).not.toMatch(/\b(?:eval|Function)\s*\(|\bimport\s*\(/);
    const examples = new URL("../../../examples/", import.meta.url);
    for (const directory of readdirSync(examples, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const manifest = JSON.parse(readFileSync(new URL(`${directory.name}/package.json`, examples), "utf8")) as {
        private?: boolean;
        dependencies?: Record<string, string>;
      };
      expect(manifest.private, directory.name).toBe(true);
      expect(Object.keys(manifest.dependencies ?? {}), directory.name).toEqual(["@ros-web-viewer/extension-api"]);
    }
  });
});

function lifecycle(
  overrides: Partial<TrustedExtensionLifecycle> = {},
): TrustedExtensionLifecycle {
  return {
    configure() {},
    attachSource() {},
    update() {},
    render() {},
    suspend() {},
    handleError() {},
    dispose() {},
    ...overrides,
  };
}
