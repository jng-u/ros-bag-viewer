import type { DisplayLifecycle, DisplayState, NormalizedMessageEnvelope, SourceEpoch } from "@ros-web-viewer/core-model";

/** Canonical envelope lifecycle adapter around one browser semantic display. */
export class BrowserDisplayLifecycle<Context> implements DisplayLifecycle {
  state: DisplayState = "registered";
  #epoch?: SourceEpoch;
  #context?: Context;

  constructor(
    private readonly onUpdate: (envelope: NormalizedMessageEnvelope, context: Context) => Promise<void>,
    private readonly onAttach: (epoch: SourceEpoch) => void,
    private readonly onRender: () => void,
    private readonly onDispose: () => void,
  ) {}

  register(): void {
    if (this.state !== "registered") throw new Error(`display cannot register from ${this.state}`);
  }

  instantiate(): void {
    if (this.state !== "registered") throw new Error(`display cannot instantiate from ${this.state}`);
    this.state = "instantiated";
  }

  configure(): void {
    if (this.state !== "instantiated" && this.state !== "configured") throw new Error(`display cannot configure from ${this.state}`);
    this.state = "configured";
  }

  attachSource(epoch: SourceEpoch): void {
    if (this.state === "disposed") throw new Error("disposed display cannot attach a source");
    this.#epoch = epoch;
    this.onAttach(epoch);
    this.state = "attached";
  }

  prepare(context: Context): void {
    if (this.state === "error") this.state = "attached";
    if (this.state !== "attached") throw new Error(`display cannot prepare an update from ${this.state}`);
    this.#context = context;
  }

  async update(envelope: NormalizedMessageEnvelope): Promise<void> {
    if (this.state !== "attached" || this.#epoch !== envelope.epoch) throw new Error("display update belongs to an unattached source epoch");
    const context = this.#context;
    this.#context = undefined;
    if (context === undefined) throw new Error("display update context was not prepared");
    this.state = "rendering";
    try {
      await this.onUpdate(envelope, context);
      this.state = "attached";
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  render(): void {
    if (this.state !== "attached" && this.state !== "rendering") throw new Error(`display cannot render from ${this.state}`);
    this.onRender();
  }

  suspend(): void {
    if (this.state === "disposed") return;
    this.#context = undefined;
    this.state = "suspended";
  }

  handleError(error: Error): void {
    void error;
    if (this.state !== "disposed") this.state = "error";
  }

  dispose(): void {
    if (this.state === "disposed") return;
    this.#context = undefined;
    this.onDispose();
    this.state = "disposed";
  }
}
