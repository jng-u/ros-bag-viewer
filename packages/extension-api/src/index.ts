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
  configure(config: TConfig): void;
  attachSource(sourceEpoch: number): void;
  update(message: TrustedExtensionMessage<TMessage>): void;
  render(): void;
  suspend(): void;
  handleError(error: Error): void;
  dispose(): void;
}

export interface TrustedExtensionDefinition<TConfig = unknown, TMessage = unknown> {
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

function ownKeys(value: object): readonly string[] {
  return Object.keys(value).sort();
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const actual = ownKeys(value);
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} contains missing or unsupported operations: ${actual.join(", ")}`);
  }
}

function assertEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("source epoch must be a non-negative safe integer");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const textEncoder = new TextEncoder();

function snapshotBytes(value: unknown, seen = new Set<object>()): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "string") return textEncoder.encode(value).byteLength;
  if (typeof value !== "object") throw new Error("extension message snapshot contains an unsupported value");
  if (seen.has(value)) throw new Error("extension message snapshot must not contain cycles or repeated object references");
  seen.add(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((total, item) => total + snapshotBytes(item, seen), 0);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("extension message snapshot must contain only plain data");
  }
  return Object.entries(value).reduce(
    (total, [key, item]) => total + textEncoder.encode(key).byteLength + snapshotBytes(item, seen),
    0,
  );
}

function freezeSnapshot<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freezeSnapshot(item, seen);
  return Object.freeze(value);
}

function boundedSnapshot<T>(value: T, maxBytes: number): T {
  if (snapshotBytes(value) > maxBytes) throw new Error("extension message snapshot byte budget exceeded");
  try {
    return freezeSnapshot(structuredClone(value));
  } catch (error) {
    throw new Error(`extension message snapshot is not cloneable: ${errorMessage(error)}`, { cause: error });
  }
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
      const implementation = create(context);
      if (implementation === null || typeof implementation !== "object") throw new Error("extension create must return a lifecycle");
      assertExactKeys(implementation, LIFECYCLE_KEYS, "extension lifecycle");
      if (LIFECYCLE_KEYS.some((key) => typeof Reflect.get(implementation, key) !== "function")) {
        throw new Error("extension lifecycle operations must be functions");
      }
      this.#implementation = implementation;
    } catch (error) {
      this.#disposeResources();
      throw error;
    }
  }

  get state(): TrustedExtensionState {
    return this.#state;
  }

  configure(config: TConfig): void {
    this.#expectState(["instantiated", "configured"], "configure");
    this.#invoke(() => this.#implementation.configure(config));
    this.#transition("configured");
  }

  attachSource(sourceEpoch: number): void {
    this.#expectState(["configured", "attached", "rendering", "suspended", "error"], "attachSource");
    assertEpoch(sourceEpoch);
    if (this.#sourceEpoch !== undefined && sourceEpoch <= this.#sourceEpoch) throw new Error("source epoch must advance");
    this.#disposeResources();
    this.#invoke(() => this.#implementation.attachSource(sourceEpoch));
    this.#sourceEpoch = sourceEpoch;
    this.#lastError = undefined;
    this.#transition("attached");
  }

  update(message: TrustedExtensionMessage<TMessage>): void {
    this.#expectState(["attached", "rendering"], "update");
    if (!this.negotiation.grantedCapabilities.includes("source-messages")) {
      throw new Error("source-messages capability was not granted");
    }
    assertEpoch(message.sourceEpoch);
    if (message.sourceEpoch !== this.#sourceEpoch) throw new Error("stale source epoch");
    const snapshot = Object.freeze({
      sourceEpoch: message.sourceEpoch,
      topic: message.topic,
      schemaName: message.schemaName,
      value: boundedSnapshot(message.value, this.limits.maxMessageSnapshotBytes),
    });
    this.#invoke(() => this.#implementation.update(snapshot));
    this.#transition("rendering");
  }

  render(): void {
    this.#expectState(["rendering"], "render");
    this.#invoke(() => this.#implementation.render());
  }

  suspend(): void {
    this.#expectState(["attached", "rendering", "suspended"], "suspend");
    this.#invoke(() => this.#implementation.suspend());
    if (this.#state !== "suspended") this.#transition("suspended");
  }

  handleError(error: Error): void {
    this.#expectState(["configured", "attached", "rendering", "suspended", "error"], "handleError");
    this.#lastError = error.message;
    try {
      this.#implementation.handleError(error);
    } finally {
      this.#disposeResources();
      if (this.#state !== "error") this.#transition("error");
    }
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    try {
      this.#implementation.dispose();
    } finally {
      this.#disposeResources();
      this.#sourceEpoch = undefined;
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
    }
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
    const allowed = options?.allowedCapabilities ?? [...CAPABILITIES];
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
    if (definition === null || typeof definition !== "object") throw new Error("extension definition is required");
    assertExactKeys(definition, DEFINITION_KEYS, "extension definition");
    if (definition.apiVersion !== TRUSTED_EXTENSION_API_VERSION) {
      throw new Error(`unsupported extension API version: ${String(definition.apiVersion)}`);
    }
    if (!IDENTIFIER.test(definition.id)) throw new Error("extension id must be a normalized private identifier");
    if (this.#definitions.has(definition.id)) throw new Error(`extension is already registered: ${definition.id}`);
    if (this.#definitions.size >= this.#limits.maxExtensions) throw new Error("extension registration limit exceeded");
    if (!Array.isArray(definition.requiredCapabilities)) throw new Error("requiredCapabilities must be an array");
    const unique = new Set(definition.requiredCapabilities);
    if (unique.size !== definition.requiredCapabilities.length) throw new Error("extension capabilities must be unique");
    for (const capability of unique) {
      if (!CAPABILITIES.has(capability)) throw new Error(`unsupported extension capability: ${String(capability)}`);
      if (!this.#allowedCapabilities.has(capability)) throw new Error(`extension capability denied: ${capability}`);
    }
    if (typeof definition.create !== "function") throw new Error("extension create must be a function");
    const snapshot = Object.freeze({
      apiVersion: TRUSTED_EXTENSION_API_VERSION,
      id: definition.id,
      requiredCapabilities: Object.freeze([...unique].sort()),
      create: definition.create,
    });
    this.#definitions.set(definition.id, snapshot as TrustedExtensionDefinition<unknown, unknown>);
    return Object.freeze({
      apiVersion: TRUSTED_EXTENSION_API_VERSION,
      extensionId: definition.id,
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
