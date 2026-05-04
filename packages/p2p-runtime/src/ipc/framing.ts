// Line-delimited JSON framing.
//
// Both sides write `JSON.stringify(msg) + "\n"` and read by accumulating
// chunks until a "\n" is seen. Simple, language-agnostic, easy to debug
// (you can `cat` the stream to see traffic).
//
// We deliberately do not pick netstring / length-prefixed framing. Newline-
// delimited JSON works fine for our message sizes (<<1 MB) and lets us tail
// the wire visually during development. If a single message ever exceeds
// the OS stdio pipe buffer (typically 64KB on macOS) it'll still work —
// child_process / NSTask handle that for us.

export function encode(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}

export class LineDecoder {
  private buffer = '';

  /** Feed a chunk; emit zero or more complete messages. */
  feed(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch (err) {
        // Skip malformed lines but surface them. In practice this only happens
        // if the child crashed mid-write or the channel got mixed with non-JSON
        // (e.g. a stray console.log on stdout instead of stderr).
        // eslint-disable-next-line no-console
        console.error('[ipc/framing] dropped malformed line:', JSON.stringify(trimmed));
      }
    }
    return out;
  }
}
