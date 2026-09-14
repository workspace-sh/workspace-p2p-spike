// Declarations for the untyped modules this package uses, limited to what it
// calls, so the package typechecks on its own.

declare module 'b4a' {
  const b4a: {
    alloc(size: number): Uint8Array<ArrayBuffer>;
  };
  export default b4a;
}

declare module 'sodium-universal' {
  const sodium: {
    crypto_hash_sha512(out: Uint8Array, input: Uint8Array): void;
    randombytes_buf(out: Uint8Array): void;
  };
  export default sodium;
}
