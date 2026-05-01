// Ambient declarations for Holepunch packages that ship no .d.ts files.
// Deliberately permissive — this is a research spike. If/when this package
// gets extracted into the main monorepo, we should write tighter types
// (or contribute upstream).

declare module 'corestore' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class Corestore {
    constructor(storage: string, opts?: Record<string, unknown>);
    primaryKey: Uint8Array;
    ready(): Promise<void>;
    close(): Promise<void>;
    get(opts: { name?: string; key?: Uint8Array; valueEncoding?: string }): Hypercore;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    replicate(isInitiatorOrStream: boolean | unknown): any;
  }
  export default Corestore;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Hypercore {
    key: Uint8Array;
    discoveryKey: Uint8Array;
    length: number;
    writable: boolean;
    ready(): Promise<void>;
    close(): Promise<void>;
    append(block: Uint8Array | Buffer): Promise<number>;
    get(index: number, opts?: { wait?: boolean }): Promise<Uint8Array>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void): this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    off(event: string, cb: (...args: any[]) => void): this;
  }
}

declare module 'hyperswarm' {
  class Hyperswarm {
    constructor(opts?: Record<string, unknown>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void): this;
    join(topic: Uint8Array, opts?: { server?: boolean; client?: boolean }): {
      flushed(): Promise<void>;
      destroy(): Promise<void>;
    };
    leave(topic: Uint8Array): Promise<void>;
    destroy(): Promise<void>;
    connections: Set<unknown>;
  }
  export default Hyperswarm;
}

declare module 'b4a' {
  const b4a: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(input: any, encoding?: string): Buffer;
    toString(buf: Uint8Array, encoding?: string): string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any;
  };
  export default b4a;
}
