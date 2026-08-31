import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { emitV1SemanticEvent } from "../../../tests/support/v1-conformance-event.js";
import { rangeSummaryExtension } from "../../../examples/range-summary-extension/src/index.js";
import {
  TrustedExtensionHost,
  defineTrustedExtension,
  defineTrustedLifecycle,
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
    definition: defineTrustedExtension(
      "harness",
      (context) => {
        result.context = context;
        return defineTrustedLifecycle(
          () => result.calls.push("configure"),
          (epoch) => result.calls.push(`attach:${epoch}`),
          (message) => result.calls.push(`update:${message.value.value}`),
          () => result.calls.push("render"),
          () => result.calls.push("suspend"),
          (error) => result.calls.push(`error:${error.message}`),
          () => result.calls.push("dispose"),
        );
      },
      ...capabilities,
    ),
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
    emitV1SemanticEvent({ schemaVersion: 1, domain: "display-extension", result: "pass", code: "extension-register", facts: {
      extensionId: negotiation.extensionId, grantedCapabilities: negotiation.grantedCapabilities.length,
    } });
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
    expect(() => host.register(definition)).toThrow(/trusted host realm/);
    expect(create).not.toHaveBeenCalled();
    expect(host.registeredExtensionIds()).toEqual([]);
  });

  it("rejects operation widening, duplicate capabilities, and denied privileged capability names", () => {
    const host = new TrustedExtensionHost({ allowedCapabilities: ["source-messages"] });
    const extra = { ...harness().definition, loadModule: () => undefined };
    expect(() => host.register(extra)).toThrow(/trusted host realm/);
    expect(() => host.register(harness(["source-messages", "source-messages"]).definition)).toThrow(/unique/);
    expect(() => host.register(harness(["diagnostics"]).definition)).toThrow(/capability denied/);
    expect(() => host.register(harness(["ros-write" as TrustedExtensionCapability]).definition)).toThrow(
      /unsupported extension capability/,
    );
    expect(host.registeredExtensionIds()).toEqual([]);
    const hiddenOwnKeys = vi.fn(Reflect.ownKeys);
    const hidden = new Proxy(harness().definition, { ownKeys: hiddenOwnKeys });
    expect(() => host.register(hidden as TrustedExtensionDefinition)).toThrow(/trusted host realm/);
    expect(hiddenOwnKeys).not.toHaveBeenCalled();
    expect(() => host.register(Object.assign(Object.create({ publish() {} }), harness().definition))).toThrow(/trusted host realm/);
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
    emitV1SemanticEvent({ schemaVersion: 1, domain: "display-extension", result: "pass", code: "extension-instantiate", facts: {
      finalState: instance.state, lifecycleStates: instance.telemetry().lifecycle.length,
    } });
  });

  it("suspends an attached source and records the lifecycle transition", () => {
    const value = harness();
    const host = new TrustedExtensionHost();
    host.register(value.definition);
    const instance = host.instantiate("harness", "suspend-transition");
    instance.configure({ enabled: true });
    instance.attachSource(1);
    instance.suspend();
    expect(value.calls).toEqual(["configure", "attach:1", "suspend"]);
    expect(instance.telemetry()).toMatchObject({ state: "suspended", sourceEpoch: 1 });
    expect(instance.telemetry().lifecycle).toEqual(["registered", "instantiated", "configured", "attached", "suspended"]);
    emitV1SemanticEvent({ schemaVersion: 1, domain: "display-extension", result: "pass", code: "extension-suspend", facts: {
      sourceEpoch: instance.telemetry().sourceEpoch ?? -1, state: instance.state,
    } });
  });

  it("rejects stale or rolled-back epochs before callbacks and invalidates old handles on advance", () => {
    const handles: TrustedResourceHandle[] = [];
    let updates = 0;
    const host = new TrustedExtensionHost();
    host.register(defineTrustedExtension(
      "epoch-probe",
      (context) => {
        return lifecycle({
          attachSource: () => handles.push(context.allocateResource("geometry-buffer", 8)),
          update: () => {
            updates += 1;
          },
        });
      },
      "bounded-resources", "source-messages",
    ));
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
    emitV1SemanticEvent({ schemaVersion: 1, domain: "display-extension", result: "pass", code: "extension-attach", facts: {
      disposedHandles: handles.filter(({ disposed }) => disposed).length, sourceEpoch: 3,
    } });
  });

  it("delivers bounded source-detached snapshots rather than retaining caller-owned message values", () => {
    let received: { readonly nested: { value: number } } | undefined;
    const host = new TrustedExtensionHost({ limits: { maxMessageSnapshotBytes: 256 } });
    host.register(defineTrustedExtension(
      "snapshot-probe",
      () => {
        return lifecycle({ update: (message) => (received = message.value as { readonly nested: { value: number } }) });
      },
      "source-messages",
    ));
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
    const backing = new ArrayBuffer(256);
    expect(() =>
      instance.update({ sourceEpoch: 2, topic: "/x", schemaName: "X", value: new Uint8Array(backing, 0, 1) }),
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
    host.register(defineTrustedExtension(
      "bounded-probe",
      (context) => {
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
      "bounded-resources", "diagnostics", "source-messages",
    ));
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
    host.register(defineTrustedExtension(
      "failing-factory",
      (context) => {
        leaked = context.allocateResource("text-buffer", 4);
        throw new Error("factory failed");
      },
      "bounded-resources",
    ));

    expect(() => host.instantiate("failing-factory", "factory-instance")).toThrow(/factory failed/);
    expect(leaked?.disposed).toBe(true);
  });

  it("surfaces both an operation failure and a failing error callback", () => {
    const host = new TrustedExtensionHost();
    host.register(defineTrustedExtension(
      "double-failure",
      () => {
        return lifecycle({
          configure: () => {
            throw new Error("configure failed");
          },
          handleError: () => {
            throw new Error("error callback failed");
          },
        });
      },
    ));
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
    emitV1SemanticEvent({ schemaVersion: 1, domain: "display-extension", result: "pass", code: "extension-error", facts: {
      aggregateErrors: (failure as AggregateError).errors.length, state: instance.state,
    } });
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
    failing.register(defineTrustedExtension(
      "configure-failure",
      () => lifecycle({ configure: () => { throw new Error("bad config"); } }),
    ));
    const failed = failing.instantiate("configure-failure", "failed-config");
    expect(() => failed.configure({})).toThrow(/bad config/);
    expect(() => failed.attachSource(1)).toThrow(/successfully configured/);
    emitV1SemanticEvent({ schemaVersion: 1, domain: "display-extension", result: "pass", code: "extension-configure", facts: {
      configured: false, state: failed.state,
    } });
  });

  it("rejects lifecycle re-entry and deeply nested snapshots without state resurrection", () => {
    const holder: { instance?: ReturnType<TrustedExtensionHost["instantiate"]> } = {};
    const host = new TrustedExtensionHost();
    host.register(defineTrustedExtension("reentry", () => lifecycle({ update: () => holder.instance?.dispose() }), "source-messages"));
    const instance = host.instantiate("reentry", "reentry-instance"); holder.instance = instance;
    instance.configure({}); instance.attachSource(1);
    expect(() => instance.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: {} })).toThrow(/re-entry/);
    expect(instance.state).toBe("error");

    const nestedHolder: { instance?: ReturnType<TrustedExtensionHost["instantiate"]> } = {};
    const nestedHost = new TrustedExtensionHost();
    nestedHost.register(defineTrustedExtension(
      "nested-configure",
      () => lifecycle({ configure: () => nestedHolder.instance?.configure({}) }),
    ));
    const nested = nestedHost.instantiate("nested-configure", "nested-instance"); nestedHolder.instance = nested;
    expect(() => nested.configure({})).toThrow(/re-entry/);
    expect(nested.state).toBe("error");
    expect(() => nested.attachSource(1)).toThrow(/successfully configured/);

    const epochHolder: { instance?: ReturnType<TrustedExtensionHost["instantiate"]> } = {};
    const epochHost = new TrustedExtensionHost();
    epochHost.register(defineTrustedExtension(
      "nested-attach",
      () => lifecycle({ attachSource: () => epochHolder.instance?.attachSource(1) }),
    ));
    const epoch = epochHost.instantiate("nested-attach", "nested-epoch"); epochHolder.instance = epoch;
    epoch.configure({});
    expect(() => epoch.attachSource(2)).toThrow(/re-entry/);
    expect(epoch.telemetry()).not.toHaveProperty("sourceEpoch");

    const safe = harness(); const bounded = new TrustedExtensionHost(); bounded.register(safe.definition);
    const target = bounded.instantiate("harness", "deep-instance"); target.configure({}); target.attachSource(1);
    let deep: unknown = "leaf"; for (let index = 0; index < 20_000; index += 1) deep = { nested: deep };
    expect(() => target.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: deep })).toThrow(/depth limit/);
    expect(target.state).toBe("attached");
  });

  it("captures exact descriptor-safe contracts and canonicalizes the complete message once", () => {
    const definitionGetter = vi.fn(() => "getter-id");
    const unsafeDefinition = { ...harness().definition } as Record<string, unknown>;
    Object.defineProperty(unsafeDefinition, "id", { enumerable: true, get: definitionGetter });
    const definitionHost = new TrustedExtensionHost();
    expect(() => definitionHost.register(unsafeDefinition as unknown as TrustedExtensionDefinition)).toThrow(/trusted host realm/);
    expect(definitionGetter).not.toHaveBeenCalled();
    expect(definitionHost.registeredExtensionIds()).toEqual([]);

    const capabilityGetter = vi.fn(() => "source-messages");
    const capabilities: unknown[] = [];
    Object.defineProperty(capabilities, "0", { enumerable: true, configurable: true, get: capabilityGetter });
    capabilities.length = 1;
    expect(() => definitionHost.register({ ...harness().definition, id: "unsafe-capability", requiredCapabilities: capabilities as TrustedExtensionCapability[] }))
      .toThrow(/trusted host realm/);
    expect(capabilityGetter).not.toHaveBeenCalled();

    let lifecycleObject: TrustedExtensionLifecycle | undefined;
    let originalUpdates = 0;
    const lifecycleHost = new TrustedExtensionHost();
    lifecycleHost.register(defineTrustedExtension(
      "captured-lifecycle",
      () => {
        lifecycleObject = lifecycle({ update: () => { originalUpdates += 1; } });
        return lifecycleObject;
      },
      "source-messages",
    ));
    const captured = lifecycleHost.instantiate("captured-lifecycle", "captured-instance");
    expect(Object.isFrozen(lifecycleObject)).toBe(true);
    expect(() => {
      lifecycleObject!.update = () => { throw new Error("mutated lifecycle"); };
    }).toThrow(TypeError);
    captured.configure({}); captured.attachSource(1);
    captured.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: {} });
    expect(originalUpdates).toBe(1);

    const envelopeGetter = vi.fn(() => 1);
    const envelope = { topic: "/x", schemaName: "X", value: {} } as Record<string, unknown>;
    Object.defineProperty(envelope, "sourceEpoch", { enumerable: true, get: envelopeGetter });
    expect(() => captured.update(envelope as unknown as Parameters<typeof captured.update>[0])).toThrow(/data field/);
    expect(envelopeGetter).not.toHaveBeenCalled();

    const arrayGetter = vi.fn(() => "large".repeat(100_000));
    const unsafeArray: unknown[] = [];
    Object.defineProperty(unsafeArray, "0", { enumerable: true, configurable: true, get: arrayGetter });
    unsafeArray.length = 1;
    expect(() => captured.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: unsafeArray })).toThrow(/data field/);
    expect(arrayGetter).not.toHaveBeenCalled();

    if (typeof SharedArrayBuffer !== "undefined") {
      expect(() => captured.update({
        sourceEpoch: 1, topic: "/x", schemaName: "X", value: new Uint8Array(new SharedArrayBuffer(8)),
      })).toThrow(/SharedArrayBuffer/);
    }

    const boundedHost = new TrustedExtensionHost({ limits: { maxMessageSnapshotBytes: 128 } });
    boundedHost.register(harness().definition);
    const bounded = boundedHost.instantiate("harness", "envelope-budget"); bounded.configure({}); bounded.attachSource(1);
    expect(() => bounded.update({ sourceEpoch: 1, topic: `/${"x".repeat(256)}`, schemaName: "X", value: null })).toThrow(/byte budget/);

    const hugeArray: unknown[] = [];
    hugeArray.length = 100_001;
    const ownKeys = vi.fn(Reflect.ownKeys);
    const hostileArray = new Proxy(hugeArray, { ownKeys });
    expect(() => bounded.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: hostileArray })).toThrow(/item limit|byte budget/);
    expect(ownKeys).not.toHaveBeenCalled();
    expect(() => bounded.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: 1n })).toThrow(/BigInt/);

    const capabilityArray: TrustedExtensionCapability[] = [];
    capabilityArray.length = 100_001;
    const capabilityOwnKeys = vi.fn(Reflect.ownKeys);
    const hostileCapabilities = new Proxy(capabilityArray, { ownKeys: capabilityOwnKeys }) as readonly TrustedExtensionCapability[];
    expect(() => definitionHost.register({
      ...harness().definition,
      id: "hostile-capabilities",
      requiredCapabilities: hostileCapabilities,
    })).toThrow(/trusted host realm/);
    expect(capabilityOwnKeys).not.toHaveBeenCalled();
    emitV1SemanticEvent({ schemaVersion: 1, domain: "display-extension", result: "pass", code: "extension-update", facts: {
      originalUpdates, proxyEnumerated: ownKeys.mock.calls.length > 0,
    } });
  });

  it("charges UTF-8 exactly and stops before attacker-controlled tails", () => {
    let nextId = 0;
    const configure = (value: unknown, maxMessageSnapshotBytes: number) => {
      const calls = vi.fn();
      const host = new TrustedExtensionHost({ limits: { maxMessageSnapshotBytes } });
      const id = `utf8-${nextId++}`;
      host.register(defineTrustedExtension(id, () => lifecycle({ configure: calls })));
      const instance = host.instantiate(id, `${id}-instance`);
      return { calls, instance, run: () => instance.configure(value) };
    };

    for (const [value, bytes] of [["a", 1], ["é", 2], ["😀", 4], ["\ud800", 3], ["\udc00", 3]] as const) {
      const accepted = configure(value, bytes);
      expect(accepted.run).not.toThrow();
      expect(accepted.calls).toHaveBeenCalledOnce();
      if (bytes > 1) {
        const rejected = configure(value, bytes - 1);
        expect(rejected.run).toThrow(/byte budget/);
        expect(rejected.calls).not.toHaveBeenCalled();
        expect(rejected.instance.state).toBe("instantiated");
      }
    }

    const charCodeAt = vi.spyOn(String.prototype, "charCodeAt");
    try {
      const hugeValue = configure("x".repeat(1_000_000), 1);
      expect(hugeValue.run).toThrow(/byte budget/);
      expect(hugeValue.calls).not.toHaveBeenCalled();
      expect(hugeValue.instance.state).toBe("instantiated");
      expect(charCodeAt).not.toHaveBeenCalled();

    const hugeKey = configure({ ["x".repeat(1_000_000)]: null }, 24);
      expect(hugeKey.run).toThrow(/byte budget/);
      expect(hugeKey.calls).not.toHaveBeenCalled();
      expect(charCodeAt).not.toHaveBeenCalled();

      const ownKeys = vi.fn(Reflect.ownKeys);
      const hostileObject = new Proxy({}, { ownKeys });
      const hostile = configure(hostileObject, 1);
      expect(hostile.run).toThrow(/byte budget/);
      expect(ownKeys).not.toHaveBeenCalled();

      const boundedScan = configure("😀😀aaaa", 8);
      expect(boundedScan.run).toThrow(/byte budget/);
      expect(boundedScan.calls).not.toHaveBeenCalled();
      expect(charCodeAt).toHaveBeenCalledTimes(5);
    } finally {
      charCodeAt.mockRestore();
    }
  });
});

describe("out-of-core range summary example", () => {
  const runningInstance = (instanceId: string) => {
    const host = new TrustedExtensionHost({ limits: { maxResourceBytesPerInstance: 64 } });
    host.register(rangeSummaryExtension);
    const instance = host.instantiate("range-summary", instanceId);
    instance.configure({ maxSamples: 4 });
    instance.attachSource(1);
    instance.update({
      sourceEpoch: 1,
      topic: "/scan",
      schemaName: "sensor_msgs/msg/LaserScan",
      value: { ranges: [1, Number.NaN, 2, 3, 4] },
    });
    instance.render();
    return instance;
  };

  it("renders through the v1 host with a bounded handle", () => {
    const instance = runningInstance("range-summary-render");
    expect(instance.telemetry()).toMatchObject({ state: "rendering", activeHandles: 1, resourceBytes: 24 });
    expect(instance.telemetry().diagnostics[0]?.message).toBe("topic=/scan; samples=3; epoch=1");
    emitV1SemanticEvent({ schemaVersion: 1, domain: "display-extension", result: "pass", code: "extension-render", facts: {
      activeHandles: instance.telemetry().activeHandles, resourceBytes: instance.telemetry().resourceBytes, state: instance.state,
    } });
  });

  it("disposes its bounded handle idempotently", () => {
    const instance = runningInstance("range-summary-dispose");
    instance.dispose();
    instance.dispose();
    expect(instance.telemetry()).toMatchObject({ state: "disposed", activeHandles: 0, resourceBytes: 0 });
    emitV1SemanticEvent({ schemaVersion: 1, domain: "display-extension", result: "pass", code: "extension-dispose", facts: {
      activeHandles: instance.telemetry().activeHandles, state: instance.state,
    } });
  });

  it("is private, statically linked, and imports no privileged internal package", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../../examples/range-summary-extension/package.json", import.meta.url), "utf8"),
    ) as { readonly private?: boolean; readonly dependencies?: Record<string, string> };
    expect(packageJson.private).toBe(true);
    expect(packageJson.dependencies).toEqual({ "@ros-web-viewer/extension-api": "workspace:*" });
    const audit = spawnSync(process.execPath, ["scripts/toolchain/audit-extension-examples.mjs"], {
      cwd: new URL("../../../", import.meta.url),
      encoding: "utf8",
    });
    expect(audit.stderr).toBe("");
    expect(audit.status).toBe(0);
    expect(audit.stdout).toMatch(/extension example audit: ok/);

    for (const source of [
      'import/*comment*/"node:fs";',
      'export/*comment*/{readFile}from"node:fs";',
      'import fs = require("node:fs");',
      'import/*comment*/("node:fs");',
      'require/*comment*/("node:fs");',
      'eval/*comment*/("1");',
      'new Function/*comment*/("return 1");',
      'import "../../packages/hosted-core/src/index.js";',
      'export * from "./untracked-local-file.js";',
      '(0, eval)("1");',
      'const evaluator = eval;',
      'globalThis["fetch"]("/");',
      'Reflect.get(globalThis, "Function");',
      '[]["filter"]["constructor"]("return 1")();',
      '(function(){}).constructor("return 1")();',
      '(class{}).constructor("return 1")();',
      '(function(){}).constructor`return 1`;',
      'const C=(function(){}).constructor; C("return 1")();',
      'const {constructor:C}=function(){}; C("return 1")();',
      'const {["con"+"structor"]:C}=function(){}; C("return 1")();',
      '(function(){})["con"+"structor"]("return 1")();',
      '(function(){})[`constructor`]`return 1`;',
      'Object.getOwnPropertyDescriptor(function(){}, "constructor").value("return 1")();',
      'const {getOwnPropertyDescriptors:g}=Object; g(function(){}).constructor.value("return 1")();',
      'Object.getOwnPropertyDescriptors(function(){}).constructor.value`return 1`;',
      '(function*(){}).constructor`return 1`;',
      '(async function(){}).constructor("return 1")();',
      'const R=Reflect; R.get(function(){}, "constructor");',
      'alert("x");',
      'setTimeout(() => {}, 0);',
      'queueMicrotask(() => {});',
      'new XMLHttpRequest();',
      'export const harmless = 1;',
    ]) {
      const probe = spawnSync(process.execPath, [
        "scripts/toolchain/audit-extension-examples.mjs",
        "--source-base64",
        Buffer.from(source).toString("base64"),
      ], { cwd: new URL("../../../", import.meta.url), encoding: "utf8" });
      expect(probe.status, source).not.toBe(0);
    }
    const allowed = spawnSync(process.execPath, [
      "scripts/toolchain/audit-extension-examples.mjs",
      "--source-base64",
      Buffer.from(`import { defineTrustedExtension, defineTrustedLifecycle } from "@ros-web-viewer/extension-api";
export const safe = defineTrustedExtension("safe", () => defineTrustedLifecycle(
  () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
));`).toString("base64"),
    ], { cwd: new URL("../../../", import.meta.url), encoding: "utf8" });
    expect(allowed.stderr).toBe("");
    expect(allowed.status).toBe(0);
  }, 15_000);
});

function lifecycle(
  overrides: Partial<TrustedExtensionLifecycle> = {},
): TrustedExtensionLifecycle {
  return defineTrustedLifecycle(
    overrides.configure ?? (() => {}),
    overrides.attachSource ?? (() => {}),
    overrides.update ?? (() => {}),
    overrides.render ?? (() => {}),
    overrides.suspend ?? (() => {}),
    overrides.handleError ?? (() => {}),
    overrides.dispose ?? (() => {}),
  );
}
