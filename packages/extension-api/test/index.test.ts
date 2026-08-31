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
    expect(() => host.register(Object.assign(Object.create({ publish() {} }), harness().definition))).toThrow(/plain object/);
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
    const host = new TrustedExtensionHost({ limits: { maxMessageSnapshotBytes: 256 } });
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

  it("rejects lifecycle re-entry and deeply nested snapshots without state resurrection", () => {
    const holder: { instance?: ReturnType<TrustedExtensionHost["instantiate"]> } = {};
    const host = new TrustedExtensionHost();
    host.register({ apiVersion: 1, id: "reentry", requiredCapabilities: ["source-messages"], create: () => lifecycle({ update: () => holder.instance?.dispose() }) });
    const instance = host.instantiate("reentry", "reentry-instance"); holder.instance = instance;
    instance.configure({}); instance.attachSource(1);
    expect(() => instance.update({ sourceEpoch: 1, topic: "/x", schemaName: "X", value: {} })).toThrow(/re-entry/);
    expect(instance.state).toBe("error");

    const nestedHolder: { instance?: ReturnType<TrustedExtensionHost["instantiate"]> } = {};
    const nestedHost = new TrustedExtensionHost();
    nestedHost.register({
      apiVersion: 1,
      id: "nested-configure",
      requiredCapabilities: [],
      create: () => lifecycle({ configure: () => nestedHolder.instance?.configure({}) }),
    });
    const nested = nestedHost.instantiate("nested-configure", "nested-instance"); nestedHolder.instance = nested;
    expect(() => nested.configure({})).toThrow(/re-entry/);
    expect(nested.state).toBe("error");
    expect(() => nested.attachSource(1)).toThrow(/successfully configured/);

    const epochHolder: { instance?: ReturnType<TrustedExtensionHost["instantiate"]> } = {};
    const epochHost = new TrustedExtensionHost();
    epochHost.register({
      apiVersion: 1,
      id: "nested-attach",
      requiredCapabilities: [],
      create: () => lifecycle({ attachSource: () => epochHolder.instance?.attachSource(1) }),
    });
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
    expect(() => definitionHost.register(unsafeDefinition as unknown as TrustedExtensionDefinition)).toThrow(/data field/);
    expect(definitionGetter).not.toHaveBeenCalled();
    expect(definitionHost.registeredExtensionIds()).toEqual([]);

    const capabilityGetter = vi.fn(() => "source-messages");
    const capabilities: unknown[] = [];
    Object.defineProperty(capabilities, "0", { enumerable: true, configurable: true, get: capabilityGetter });
    capabilities.length = 1;
    expect(() => definitionHost.register({ ...harness().definition, id: "unsafe-capability", requiredCapabilities: capabilities as TrustedExtensionCapability[] }))
      .toThrow(/data field/);
    expect(capabilityGetter).not.toHaveBeenCalled();

    let lifecycleObject: TrustedExtensionLifecycle | undefined;
    let originalUpdates = 0;
    const lifecycleHost = new TrustedExtensionHost();
    lifecycleHost.register({
      apiVersion: 1,
      id: "captured-lifecycle",
      requiredCapabilities: ["source-messages"],
      create: () => {
        lifecycleObject = lifecycle({ update: () => { originalUpdates += 1; } });
        return lifecycleObject;
      },
    });
    const captured = lifecycleHost.instantiate("captured-lifecycle", "captured-instance");
    lifecycleObject!.update = () => { throw new Error("mutated lifecycle"); };
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
    expect(packageJson.private).toBe(true);
    expect(packageJson.dependencies).toEqual({ "@ros-web-viewer/extension-api": "workspace:*" });
    const examples = new URL("../../../examples/", import.meta.url);
    for (const directory of readdirSync(examples, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const manifest = JSON.parse(readFileSync(new URL(`${directory.name}/package.json`, examples), "utf8")) as {
        private?: boolean;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        bundledDependencies?: string[];
        bundleDependencies?: string[] | boolean;
      };
      expect(manifest.private, directory.name).toBe(true);
      expect(Object.keys(manifest.dependencies ?? {}), directory.name).toEqual(["@ros-web-viewer/extension-api"]);
      expect(Object.keys(manifest.devDependencies ?? {}), directory.name).toEqual([]);
      expect(Object.keys(manifest.optionalDependencies ?? {}), directory.name).toEqual([]);
      expect(Object.keys(manifest.peerDependencies ?? {}), directory.name).toEqual([]);
      expect(manifest.bundledDependencies ?? [], directory.name).toEqual([]);
      expect(manifest.bundleDependencies ?? [], directory.name).toEqual([]);
      const pending = [new URL(`${directory.name}/`, examples)];
      while (pending.length > 0) {
        const current = pending.pop()!;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = new URL(entry.name, current);
          if (entry.isDirectory()) { pending.push(new URL(`${entry.name}/`, current)); continue; }
          expect(entry.name, `${directory.name}/${entry.name}`).not.toMatch(/\.(?:node|wasm)$/u);
          if (/\.(?:jsonc?|ya?ml|toml)$/u.test(entry.name) && entry.name !== "package.json") {
            const config = readFileSync(path, "utf8");
            expect(config, `${directory.name}/${entry.name}`).not.toMatch(
              /@ros-web-viewer\/(?!extension-api(?:["'/]|$))|\b(?:eval|Function|Worker|WebSocket|SharedArrayBuffer)\b/u,
            );
            continue;
          }
          if (entry.name.endsWith(".d.ts")) continue;
          if (!/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) continue;
          const source = readFileSync(path, "utf8");
          const imports = [...source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/gu)]
            .map((match) => match[1]);
          expect(imports, `${directory.name}/${entry.name}`).toEqual(
            imports.map(() => "@ros-web-viewer/extension-api"),
          );
          expect(source, `${directory.name}/${entry.name}`).not.toMatch(
            /\b(?:eval|Function)\s*\(|\bimport\s*\(|\brequire(?:\.resolve)?\s*\(|\b(?:Worker|WebSocket|localStorage|sessionStorage|indexedDB|fetch|document|window|navigator|WebGL2RenderingContext|OffscreenCanvas|SharedArrayBuffer|process|Deno|Bun)\b|\b(?:publish|callService|sendAction|setParameter|rawCommand)\b/u,
          );
        }
      }
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
