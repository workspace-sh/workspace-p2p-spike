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
    // hypercore accepts a single block or a batch; the batch form is what
    // makes multi-block fixtures cheap to write.
    append(blocks: Uint8Array | Buffer | Array<Uint8Array | Buffer>): Promise<number>;
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

declare module 'protomux' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Channel {
    addMessage(opts: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      encoding?: any;
      onmessage?: (message: Uint8Array) => void;
    }): { send(message: Uint8Array): void };
    open(): void;
    close(): void;
  }
  class Protomux {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static from(stream: any): Protomux;
    createChannel(opts: { protocol: string }): Channel | null;
  }
  export default Protomux;
}

declare module 'compact-encoding' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: { raw: any; [k: string]: any };
  export default c;
}

// Imported statically (rather than via `createRequire`) so the module graph
// can be packed for Bare — see #229. `createRequire` had been hiding the
// absence of types on these two; declaring them is the cost of that fix.
declare module 'hypercore-crypto' {
  const hypercoreCrypto: {
    keyPair(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
    sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
    verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any;
  };
  export default hypercoreCrypto;
}

declare module 'sodium-universal' {
  const sodium: {
    crypto_hash_sha256_BYTES: number;
    crypto_hash_sha256(out: Uint8Array, input: Uint8Array): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any;
  };
  export default sodium;
}

// Deep import of hypercore's replication message codecs — the transport form
// (transport-form.ts) persists and replays wire.data messages verbatim.
declare module 'hypercore/lib/messages.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const wire: { data: any; [k: string]: any };
}
