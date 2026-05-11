// Abstract transport layer for the JSON-RPC IPC channel.
//
// SpawnedRuntime is protocol-only: it doesn't care whether the child process
// was spawned via child_process.spawn (Node/test path) or NSTask
// (macOS TurboModule path). Each platform provides a Transport that handles
// the spawning and stdio bridging.
//
// The contract:
//   - send()      → write a complete newline-terminated JSON line to child stdin
//   - onMessage() → callback fires once per complete JSON-RPC message from child
//   - onExit()    → callback fires once when the child process terminates
//   - close()     → signal the child to shut down and wait for it to exit
//   - closed      → true after onExit has fired

export interface Transport {
  /** Write a complete JSON-RPC line (already newline-terminated) to child stdin. */
  send(line: string): void;

  /**
   * Register a callback that fires for each parsed message received from the
   * child. Returns an unsubscribe function.
   */
  onMessage(cb: (msg: unknown) => void): () => void;

  /**
   * Register a callback that fires once when the child exits.
   * Returns an unsubscribe function.
   */
  onExit(cb: (code: number | null) => void): () => void;

  /** Shut down the child and wait for it to exit. Idempotent. */
  close(): Promise<void>;

  /** True after the child has exited. */
  readonly closed: boolean;
}
