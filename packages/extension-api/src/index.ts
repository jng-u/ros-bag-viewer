export const TRUSTED_EXTENSION_API_VERSION = 1 as const;

export const TRUSTED_EXTENSION_CAPABILITIES = Object.freeze([
  "bounded-resources",
  "diagnostics",
  "source-messages",
] as const);

export const TRUSTED_EXTENSION_OPERATIONS = Object.freeze([
  "attachSource",
  "configure",
  "dispose",
  "handleError",
  "render",
  "suspend",
  "update",
] as const);

export type TrustedExtensionCapability = "diagnostics" | "bounded-resources" | "source-messages";
export type TrustedResourceKind = "geometry-buffer" | "texture" | "text-buffer";
export type TrustedDiagnosticLevel = "info" | "warning" | "error";
export type TrustedExtensionState =
  | "registered"
  | "instantiated"
  | "configured"
  | "attached"
  | "rendering"
  | "suspended"
  | "error"
  | "disposed";

export interface TrustedExtensionLimits {
  readonly maxExtensions: number;
  readonly maxHandlesPerInstance: number;
  readonly maxResourceBytesPerInstance: number;
  readonly maxDiagnosticsPerInstance: number;
  readonly maxDiagnosticLength: number;
  readonly maxMessageSnapshotBytes: number;
}

export const DEFAULT_TRUSTED_EXTENSION_LIMITS: TrustedExtensionLimits = Object.freeze({
  maxExtensions: 32,
  maxHandlesPerInstance: 64,
  maxResourceBytesPerInstance: 64 * 1_024 * 1_024,
  maxDiagnosticsPerInstance: 128,
  maxDiagnosticLength: 1_024,
  maxMessageSnapshotBytes: 8 * 1_024 * 1_024,
});

export interface TrustedDiagnostic {
  readonly sequence: number;
  readonly level: TrustedDiagnosticLevel;
  readonly code: string;
  readonly message: string;
}

export interface TrustedResourceHandle {
  readonly id: string;
  readonly kind: TrustedResourceKind;
  readonly byteLength: number;
  readonly disposed: boolean;
  dispose(): void;
}

export interface TrustedExtensionMessage<T = unknown> {
  readonly sourceEpoch: number;
  readonly topic: string;
  readonly schemaName: string;
  readonly value: T;
}

export interface TrustedExtensionContext {
  readonly apiVersion: typeof TRUSTED_EXTENSION_API_VERSION;
  readonly capabilities: readonly TrustedExtensionCapability[];
  allocateResource(kind: TrustedResourceKind, byteLength: number): TrustedResourceHandle;
  emitDiagnostic(level: TrustedDiagnosticLevel, code: string, message: string): void;
}

export interface TrustedExtensionLifecycle<TConfig = unknown, TMessage = unknown> {
  readonly __trustedExtensionLifecycleBrand: "same-realm-v1";
  configure(config: TConfig): void;
  attachSource(sourceEpoch: number): void;
  update(message: TrustedExtensionMessage<TMessage>): void;
  render(): void;
  suspend(): void;
  handleError(error: Error): void;
  dispose(): void;
}

export interface TrustedExtensionDefinition<TConfig = unknown, TMessage = unknown> {
  readonly __trustedExtensionDefinitionBrand: "same-realm-v1";
  readonly apiVersion: typeof TRUSTED_EXTENSION_API_VERSION;
  readonly id: string;
  readonly requiredCapabilities: readonly TrustedExtensionCapability[];
  create(context: TrustedExtensionContext): TrustedExtensionLifecycle<TConfig, TMessage>;
}

export interface TrustedExtensionNegotiation {
  readonly apiVersion: typeof TRUSTED_EXTENSION_API_VERSION;
  readonly extensionId: string;
  readonly grantedCapabilities: readonly TrustedExtensionCapability[];
}

const trustedBrandRegistryKey = Symbol.for("@ros-web-viewer/extension-api/trusted-brand-registry/v1");
interface TrustedBrandRegistry { readonly definitions: WeakSet<object>; readonly lifecycles: WeakSet<object> }
const brandGlobal = globalThis as typeof globalThis & { [trustedBrandRegistryKey]?: TrustedBrandRegistry };
const trustedBrandRegistry = brandGlobal[trustedBrandRegistryKey] ?? Object.freeze({
  definitions: new WeakSet<object>(),
  lifecycles: new WeakSet<object>(),
});
if (brandGlobal[trustedBrandRegistryKey] === undefined) {
  Object.defineProperty(brandGlobal, trustedBrandRegistryKey, { value: trustedBrandRegistry });
}
const trustedDefinitions = trustedBrandRegistry.definitions;
const trustedLifecycles = trustedBrandRegistry.lifecycles;

/**
 * Builds the exact lifecycle object accepted by the trusted same-realm extension host.
 * The positional API deliberately creates the object inside this module, so admission
 * never needs to enumerate a caller-controlled Proxy.
 */
export function defineTrustedLifecycle<TConfig = unknown, TMessage = unknown>(
  configure: TrustedExtensionLifecycle<TConfig, TMessage>["configure"],
  attachSource: TrustedExtensionLifecycle<TConfig, TMessage>["attachSource"],
  update: TrustedExtensionLifecycle<TConfig, TMessage>["update"],
  render: TrustedExtensionLifecycle<TConfig, TMessage>["render"],
  suspend: TrustedExtensionLifecycle<TConfig, TMessage>["suspend"],
  handleError: TrustedExtensionLifecycle<TConfig, TMessage>["handleError"],
  dispose: TrustedExtensionLifecycle<TConfig, TMessage>["dispose"],
): TrustedExtensionLifecycle<TConfig, TMessage> {
  for (const [name, operation] of Object.entries({ configure, attachSource, update, render, suspend, handleError, dispose })) {
    if (typeof operation !== "function") throw new Error(`extension lifecycle ${name} must be a function`);
  }
  const lifecycle = Object.freeze({ configure, attachSource, update, render, suspend, handleError, dispose });
  trustedLifecycles.add(lifecycle);
  return lifecycle as unknown as TrustedExtensionLifecycle<TConfig, TMessage>;
}

/**
 * Builds a trusted extension definition in this module's realm. Extensions are
 * build-time workspace code, not an untrusted plugin ABI; cross-realm objects and
 * arbitrary object-shaped definitions are intentionally unsupported.
 */
export function defineTrustedExtension<TConfig = unknown, TMessage = unknown>(
  id: string,
  create: (context: TrustedExtensionContext) => TrustedExtensionLifecycle<TConfig, TMessage>,
  ...requiredCapabilities: TrustedExtensionCapability[]
): TrustedExtensionDefinition<TConfig, TMessage> {
  if (typeof id !== "string" || !IDENTIFIER.test(id)) throw new Error("extension id must be a normalized private identifier");
  if (typeof create !== "function") throw new Error("extension create must be a function");
  if (requiredCapabilities.length > TRUSTED_EXTENSION_CAPABILITIES.length) throw new Error("requiredCapabilities exceeds the item limit");
  const definition = Object.freeze({
    apiVersion: TRUSTED_EXTENSION_API_VERSION,
    id,
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    create,
  });
  trustedDefinitions.add(definition);
  return definition as unknown as TrustedExtensionDefinition<TConfig, TMessage>;
}

export interface TrustedExtensionTelemetry {
  readonly state: TrustedExtensionState;
  readonly sourceEpoch?: number;
  readonly activeHandles: number;
  readonly resourceBytes: number;
  readonly diagnostics: readonly TrustedDiagnostic[];
  readonly droppedDiagnostics: number;
  readonly lifecycle: readonly TrustedExtensionState[];
  readonly lastError?: string;
}

const DEFINITION_KEYS = Object.freeze(["apiVersion", "create", "id", "requiredCapabilities"]);
const LIFECYCLE_KEYS: readonly string[] = TRUSTED_EXTENSION_OPERATIONS;
const CAPABILITIES = new Set<TrustedExtensionCapability>(TRUSTED_EXTENSION_CAPABILITIES);
const RESOURCE_KINDS = new Set<TrustedResourceKind>(["geometry-buffer", "texture", "text-buffer"]);
const DIAGNOSTIC_LEVELS = new Set<TrustedDiagnosticLevel>(["info", "warning", "error"]);
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function captureExactObject(value: unknown, allowed: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length) throw new Error(`${label} contains missing or unsupported operations`);
  if (keys.some((key) => typeof key !== "string")) throw new Error(`${label} must not contain symbol fields`);
  const actual = (keys as string[]).sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} contains missing or unsupported operations: ${actual.join(", ")}`);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error(`${label}.${key} must be an enumerable data field`);
    Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true });
  }
  return Object.freeze(snapshot);
}

function captureExactArray<T>(value: unknown, label: string, maxLength = 100_000): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must be an ordinary array`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!lengthDescriptor || "get" in lengthDescriptor || !Number.isSafeInteger(length) || length < 0 || length > maxLength) {
    throw new Error(`${label} exceeds the item limit`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) throw new Error(`${label} must be dense and unaugmented`);
  if (keys.some((key) => typeof key !== "string")) throw new Error(`${label} must not contain symbol fields`);
  if (keys.length !== length + 1 || !(keys as string[]).includes("length")) {
    throw new Error(`${label} must be dense and unaugmented`);
  }
  for (const key of keys as string[]) {
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      throw new Error(`${label} must be dense and unaugmented`);
    }
  }
  const snapshot: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error(`${label}[${index}] must be an enumerable data field`);
    snapshot.push(descriptor.value as T);
  }
  return Object.freeze(snapshot);
}

function assertEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("source epoch must be a non-negative safe integer");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SnapshotBudget {
  bytes: number;
  items: number;
  readonly maxBytes: number;
}

function chargeSnapshot(budget: SnapshotBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.maxBytes - budget.bytes) {
    throw new Error("extension message snapshot byte budget exceeded");
  }
  budget.bytes += bytes;
}

function chargeUtf8Snapshot(budget: SnapshotBudget, value: string, prefixBytes = 0): void {
  const available = budget.maxBytes - budget.bytes;
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0 || prefixBytes > available) {
    throw new Error("extension message snapshot byte budget exceeded");
  }
  const remaining = available - prefixBytes;
  if (value.length > remaining) throw new Error("extension message snapshot byte budget exceeded");
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let width: number;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { width = 4; index += 1; } else width = 3;
    } else width = 3;
    if (width > remaining - bytes) throw new Error("extension message snapshot byte budget exceeded");
    bytes += width;
  }
  budget.bytes += prefixBytes + bytes;
}

function canonicalSnapshot(value: unknown, budget: SnapshotBudget, depth = 0, seen = new Set<object>()): unknown {
  if (++budget.items > 100_000) throw new Error("extension message snapshot item limit exceeded");
  if (depth > 64) throw new Error("extension message snapshot depth limit exceeded");
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean") { chargeSnapshot(budget, 1); return value; }
  if (typeof value === "number") { chargeSnapshot(budget, 8); return value; }
  if (typeof value === "bigint") throw new Error("extension message snapshot must not contain BigInt values");
  if (typeof value === "string") { chargeUtf8Snapshot(budget, value); return value; }
  if (typeof value !== "object") throw new Error("extension message snapshot contains an unsupported value");
  if (seen.has(value)) throw new Error("extension message snapshot must not contain cycles or repeated references");
  seen.add(value);
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    throw new Error("extension message snapshot must not contain SharedArrayBuffer data");
  }
  if (value instanceof ArrayBuffer) {
    chargeSnapshot(budget, 16 + value.byteLength);
    return value.slice(0);
  }
  if (ArrayBuffer.isView(value)) {
    if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) {
      throw new Error("extension message snapshot must not contain SharedArrayBuffer views");
    }
    chargeSnapshot(budget, 16 + value.buffer.byteLength);
    return structuredClone(value);
  }
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor?.value;
    if (!lengthDescriptor || "get" in lengthDescriptor || !Number.isSafeInteger(length) || length < 0 || length > 100_000) {
      throw new Error("extension message array exceeds the item limit");
    }
    chargeSnapshot(budget, 16 + length * 8);
    const items = captureExactArray<unknown>(value, "extension message array", length);
    return items.map((item) => canonicalSnapshot(item, budget, depth + 1, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("extension message snapshot must contain only plain data");
  chargeSnapshot(budget, 16);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 100_000 - budget.items) throw new Error("extension message snapshot item limit exceeded");
  if (keys.length > Math.floor((budget.maxBytes - budget.bytes) / 8)) throw new Error("extension message snapshot byte budget exceeded");
  if (keys.some((key) => typeof key !== "string")) throw new Error("extension message snapshot must not contain symbols");
  const output: Record<string, unknown> = Object.create(prototype === null ? null : Object.prototype) as Record<string, unknown>;
  for (const key of (keys as string[]).sort()) {
    if (key === "__proto__") throw new Error("extension message snapshot must not contain __proto__ fields");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("extension message snapshot must contain plain enumerable data");
    chargeUtf8Snapshot(budget, key, 8);
    Object.defineProperty(output, key, {
      value: canonicalSnapshot(descriptor.value, budget, depth + 1, seen),
      enumerable: true,
    });
  }
  return output;
}

function freezeSnapshot<T>(value: T): T {
  const stack: object[] = [];
  const pending: object[] = typeof value === "object" && value !== null ? [value] : [];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (seen.has(item) || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) continue;
    seen.add(item); stack.push(item);
    for (const nested of Object.values(item)) if (typeof nested === "object" && nested !== null) pending.push(nested);
  }
  for (let index = stack.length - 1; index >= 0; index -= 1) Object.freeze(stack[index]);
  return value;
}

function boundedSnapshot<T>(value: T, maxBytes: number): T {
  return freezeSnapshot(canonicalSnapshot(value, { bytes: 0, items: 0, maxBytes }) as T);
}

class ResourceHandle implements TrustedResourceHandle {
  #disposed = false;

  constructor(
    readonly id: string,
    readonly kind: TrustedResourceKind,
    readonly byteLength: number,
    private readonly release: (handle: ResourceHandle) => void,
  ) {}

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.release(this);
  }
}

interface InstanceResources {
  readonly handles: Map<string, ResourceHandle>;
  bytes: number;
  nextHandle: number;
}

export class TrustedExtensionInstance<TConfig = unknown, TMessage = unknown> {
  #state: TrustedExtensionState = "instantiated";
  #sourceEpoch?: number;
  #lastError?: string;
  #contextActive = true;
  #configured = false;
  #inLifecycle = false;
  #droppedDiagnostics = 0;
  #nextDiagnostic = 0;
  readonly #diagnostics: TrustedDiagnostic[] = [];
  readonly #lifecycle: TrustedExtensionState[] = ["registered", "instantiated"];
  readonly #resources: InstanceResources = { handles: new Map(), bytes: 0, nextHandle: 0 };
  readonly #implementation: TrustedExtensionLifecycle<TConfig, TMessage>;

  constructor(
    readonly id: string,
    private readonly negotiation: TrustedExtensionNegotiation,
    create: (context: TrustedExtensionContext) => TrustedExtensionLifecycle<TConfig, TMessage>,
    private readonly limits: TrustedExtensionLimits,
  ) {
    const granted = new Set(negotiation.grantedCapabilities);
    const context: TrustedExtensionContext = Object.freeze({
      apiVersion: TRUSTED_EXTENSION_API_VERSION,
      capabilities: negotiation.grantedCapabilities,
      allocateResource: (kind: TrustedResourceKind, byteLength: number) => {
        if (!this.#contextActive) throw new Error("extension context is not active");
        if (!granted.has("bounded-resources")) throw new Error("bounded-resources capability was not granted");
        if (!RESOURCE_KINDS.has(kind)) throw new Error(`unsupported resource kind: ${String(kind)}`);
        assertPositiveLimit(byteLength, "resource byteLength");
        if (this.#resources.handles.size >= limits.maxHandlesPerInstance) throw new Error("resource handle limit exceeded");
        if (this.#resources.bytes + byteLength > limits.maxResourceBytesPerInstance) {
          throw new Error("resource byte budget exceeded");
        }
        const handle = new ResourceHandle(
          `${id}:resource:${this.#resources.nextHandle++}`,
          kind,
          byteLength,
          (released) => {
            if (!this.#resources.handles.delete(released.id)) return;
            this.#resources.bytes -= released.byteLength;
          },
        );
        this.#resources.handles.set(handle.id, handle);
        this.#resources.bytes += byteLength;
        return handle;
      },
      emitDiagnostic: (level: TrustedDiagnosticLevel, code: string, message: string) => {
        if (!this.#contextActive) throw new Error("extension context is not active");
        if (!granted.has("diagnostics")) throw new Error("diagnostics capability was not granted");
        if (!DIAGNOSTIC_LEVELS.has(level)) throw new Error(`unsupported diagnostic level: ${String(level)}`);
        if (!DIAGNOSTIC_CODE.test(code)) throw new Error("diagnostic code is invalid");
        if (!message || message.length > limits.maxDiagnosticLength) throw new Error("diagnostic message exceeds limit");
        if (this.#diagnostics.length >= limits.maxDiagnosticsPerInstance) {
          this.#droppedDiagnostics += 1;
          return;
        }
        this.#diagnostics.push(Object.freeze({ sequence: this.#nextDiagnostic++, level, code, message }));
      },
    });
    try {
      const created = create(context);
      if (typeof created !== "object" || created === null || !trustedLifecycles.has(created)) {
        throw new Error("extension lifecycle must be created by defineTrustedLifecycle in the trusted host realm");
      }
      const implementation = captureExactObject(created, LIFECYCLE_KEYS, "extension lifecycle");
      if (LIFECYCLE_KEYS.some((key) => typeof implementation[key] !== "function")) {
        throw new Error("extension lifecycle operations must be functions");
      }
      this.#implementation = implementation as unknown as TrustedExtensionLifecycle<TConfig, TMessage>;
    } catch (error) {
      this.#disposeResources();
      throw error;
    } finally {
      this.#contextActive = false;
    }
  }

  get state(): TrustedExtensionState {
    return this.#state;
  }

  configure(config: TConfig): void {
    this.#assertNotReentrant();
    this.#expectState(["instantiated", "configured", "error"], "configure");
    const snapshot = boundedSnapshot(config, this.limits.maxMessageSnapshotBytes);
    try { this.#invoke(() => this.#implementation.configure(snapshot)); }
    catch (error) { this.#configured = false; throw error; }
    this.#configured = true;
    this.#transition("configured");
  }

  attachSource(sourceEpoch: number): void {
    this.#assertNotReentrant();
    this.#expectState(["configured", "attached", "rendering", "suspended", "error"], "attachSource");
    if (!this.#configured) throw new Error("extension must be successfully configured before attaching a source");
    assertEpoch(sourceEpoch);
    if (this.#sourceEpoch !== undefined && sourceEpoch <= this.#sourceEpoch) throw new Error("source epoch must advance");
    this.#disposeResources();
    this.#invoke(() => this.#implementation.attachSource(sourceEpoch));
    this.#sourceEpoch = sourceEpoch;
    this.#lastError = undefined;
    this.#transition("attached");
  }

  update(message: TrustedExtensionMessage<TMessage>): void {
    this.#assertNotReentrant();
    this.#expectState(["attached", "rendering"], "update");
    if (!this.negotiation.grantedCapabilities.includes("source-messages")) {
      throw new Error("source-messages capability was not granted");
    }
    const envelope = captureExactObject(message, ["schemaName", "sourceEpoch", "topic", "value"], "extension message");
    const snapshot = boundedSnapshot(envelope, this.limits.maxMessageSnapshotBytes) as unknown as TrustedExtensionMessage<TMessage>;
    assertEpoch(snapshot.sourceEpoch);
    if (snapshot.sourceEpoch !== this.#sourceEpoch) throw new Error("stale source epoch");
    if (typeof snapshot.topic !== "string" || snapshot.topic.length === 0) throw new Error("extension message topic is invalid");
    if (typeof snapshot.schemaName !== "string" || snapshot.schemaName.length === 0) throw new Error("extension message schemaName is invalid");
    this.#invoke(() => this.#implementation.update(snapshot));
    this.#transition("rendering");
  }

  render(): void {
    this.#assertNotReentrant();
    this.#expectState(["rendering"], "render");
    this.#invoke(() => this.#implementation.render());
  }

  suspend(): void {
    this.#assertNotReentrant();
    this.#expectState(["attached", "rendering", "suspended"], "suspend");
    this.#invoke(() => this.#implementation.suspend());
    if (this.#state !== "suspended") this.#transition("suspended");
  }

  handleError(error: Error): void {
    this.#assertNotReentrant();
    this.#expectState(["configured", "attached", "rendering", "suspended", "error"], "handleError");
    this.#lastError = error.message;
    this.#inLifecycle = true;
    this.#contextActive = true;
    try {
      this.#implementation.handleError(error);
    } finally {
      this.#contextActive = false;
      this.#inLifecycle = false;
      this.#disposeResources();
      if (this.#state !== "error") this.#transition("error");
    }
  }

  dispose(): void {
    this.#assertNotReentrant();
    if (this.#state === "disposed") return;
    this.#inLifecycle = true;
    this.#contextActive = true;
    try {
      this.#implementation.dispose();
    } finally {
      this.#contextActive = false;
      this.#inLifecycle = false;
      this.#disposeResources();
      this.#sourceEpoch = undefined;
      this.#configured = false;
      this.#transition("disposed");
    }
  }

  telemetry(): TrustedExtensionTelemetry {
    return Object.freeze({
      state: this.#state,
      ...(this.#sourceEpoch === undefined ? {} : { sourceEpoch: this.#sourceEpoch }),
      activeHandles: this.#resources.handles.size,
      resourceBytes: this.#resources.bytes,
      diagnostics: Object.freeze([...this.#diagnostics]),
      droppedDiagnostics: this.#droppedDiagnostics,
      lifecycle: Object.freeze([...this.#lifecycle]),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    });
  }

  #disposeResources(): void {
    for (const handle of [...this.#resources.handles.values()]) handle.dispose();
  }

  #expectState(allowed: readonly TrustedExtensionState[], operation: string): void {
    if (!allowed.includes(this.#state)) throw new Error(`${operation} is invalid while extension is ${this.#state}`);
  }

  #invoke(operation: () => void): void {
    this.#assertNotReentrant();
    this.#inLifecycle = true;
    this.#contextActive = true;
    try {
      operation();
    } catch (error) {
      this.#lastError = errorMessage(error);
      this.#disposeResources();
      if (this.#state !== "error") this.#transition("error");
      const operationError = error instanceof Error ? error : new Error(String(error));
      try {
        this.#implementation.handleError(operationError);
      } catch (handlerError) {
        const normalizedHandlerError = handlerError instanceof Error ? handlerError : new Error(String(handlerError));
        this.#lastError = `${errorMessage(error)}; handleError failed: ${normalizedHandlerError.message}`;
        throw new AggregateError(
          [operationError, normalizedHandlerError],
          "extension operation and handleError both failed",
          { cause: handlerError },
        );
      } finally {
        this.#disposeResources();
      }
      throw error;
    } finally {
      this.#contextActive = false;
      this.#inLifecycle = false;
    }
  }

  #assertNotReentrant(): void {
    if (this.#inLifecycle) throw new Error("extension lifecycle re-entry is not permitted");
  }

  #transition(state: TrustedExtensionState): void {
    this.#state = state;
    this.#lifecycle.push(state);
  }
}

export class TrustedExtensionHost {
  readonly #definitions = new Map<string, TrustedExtensionDefinition<unknown, unknown>>();
  readonly #allowedCapabilities: ReadonlySet<TrustedExtensionCapability>;
  readonly #limits: TrustedExtensionLimits;

  constructor(options?: {
    readonly allowedCapabilities?: readonly TrustedExtensionCapability[];
    readonly limits?: Partial<TrustedExtensionLimits>;
  }) {
    const allowed = captureExactArray<TrustedExtensionCapability>(
      options?.allowedCapabilities ?? [...CAPABILITIES],
      "allowedCapabilities",
      TRUSTED_EXTENSION_CAPABILITIES.length,
    );
    if (new Set(allowed).size !== allowed.length || allowed.some((capability) => !CAPABILITIES.has(capability))) {
      throw new Error("host capabilities contain duplicates or unsupported values");
    }
    this.#allowedCapabilities = new Set(allowed);
    this.#limits = Object.freeze({ ...DEFAULT_TRUSTED_EXTENSION_LIMITS, ...options?.limits });
    for (const [key, value] of Object.entries(this.#limits)) assertPositiveLimit(value, key);
  }

  register<TConfig, TMessage>(
    definition: TrustedExtensionDefinition<TConfig, TMessage>,
  ): TrustedExtensionNegotiation {
    if (typeof definition !== "object" || definition === null || !trustedDefinitions.has(definition)) {
      throw new Error("extension definition must be created by defineTrustedExtension in the trusted host realm");
    }
    const candidate = captureExactObject(definition, DEFINITION_KEYS, "extension definition");
    if (candidate.apiVersion !== TRUSTED_EXTENSION_API_VERSION) {
      throw new Error(`unsupported extension API version: ${String(candidate.apiVersion)}`);
    }
    if (typeof candidate.id !== "string" || !IDENTIFIER.test(candidate.id)) throw new Error("extension id must be a normalized private identifier");
    if (this.#definitions.has(candidate.id)) throw new Error(`extension is already registered: ${candidate.id}`);
    if (this.#definitions.size >= this.#limits.maxExtensions) throw new Error("extension registration limit exceeded");
    const requiredCapabilities = captureExactArray<TrustedExtensionCapability>(
      candidate.requiredCapabilities,
      "requiredCapabilities",
      TRUSTED_EXTENSION_CAPABILITIES.length,
    );
    const unique = new Set(requiredCapabilities);
    if (unique.size !== requiredCapabilities.length) throw new Error("extension capabilities must be unique");
    for (const capability of unique) {
      if (!CAPABILITIES.has(capability)) throw new Error(`unsupported extension capability: ${String(capability)}`);
      if (!this.#allowedCapabilities.has(capability)) throw new Error(`extension capability denied: ${capability}`);
    }
    if (typeof candidate.create !== "function") throw new Error("extension create must be a function");
    const snapshot = Object.freeze({
      apiVersion: TRUSTED_EXTENSION_API_VERSION,
      id: candidate.id,
      requiredCapabilities: Object.freeze([...unique].sort()),
      create: candidate.create,
    });
    this.#definitions.set(candidate.id, snapshot as TrustedExtensionDefinition<unknown, unknown>);
    return Object.freeze({
      apiVersion: TRUSTED_EXTENSION_API_VERSION,
      extensionId: candidate.id,
      grantedCapabilities: Object.freeze([...unique].sort()),
    });
  }

  instantiate<TConfig, TMessage>(extensionId: string, instanceId: string): TrustedExtensionInstance<TConfig, TMessage> {
    const definition = this.#definitions.get(extensionId);
    if (definition === undefined) throw new Error(`extension is not registered: ${extensionId}`);
    if (!IDENTIFIER.test(instanceId)) throw new Error("extension instance id must be a normalized private identifier");
    const negotiation: TrustedExtensionNegotiation = Object.freeze({
      apiVersion: TRUSTED_EXTENSION_API_VERSION,
      extensionId,
      grantedCapabilities: Object.freeze([...definition.requiredCapabilities].sort()),
    });
    return new TrustedExtensionInstance<TConfig, TMessage>(
      instanceId,
      negotiation,
      definition.create as (context: TrustedExtensionContext) => TrustedExtensionLifecycle<TConfig, TMessage>,
      this.#limits,
    );
  }

  registeredExtensionIds(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()].sort());
  }
}
