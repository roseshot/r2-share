/**
 * Verify uploaded bytes as the object store consumes the stream.
 * Cloudflare Workers provide DigestStream for streaming SHA-256.
 */
const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");

export function monitorUpload(source: ReadableStream<Uint8Array>, expectedSize: number | null) {
  let size = 0;
  type StreamingCrypto = Crypto & {
    DigestStream?: new (algorithm: string) =>
      WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> };
  };
  const DigestStream = (crypto as StreamingCrypto).DigestStream;
  const digestStream = DigestStream ? new DigestStream("SHA-256") : null;
  const writer = digestStream?.getWriter();

  // Non-Workers test runtimes may not implement DigestStream.
  const chunks: Uint8Array[] = [];
  const stream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      size += chunk.byteLength;
      if (expectedSize !== null && size > expectedSize) throw new Error("Upload exceeds declared file size");
      if (writer) await writer.write(chunk);
      else chunks.push(chunk.slice());
      controller.enqueue(chunk);
    },
    async flush() {
      if (writer) await writer.close();
    },
  }));

  return {
    stream,
    async result(): Promise<{ size: number; sha256: string }> {
      let sha256: string;
      if (digestStream) {
        sha256 = hex(await digestStream.digest);
      } else {
        const all = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          all.set(chunk, offset);
          offset += chunk.byteLength;
        }
        sha256 = hex(await crypto.subtle.digest("SHA-256", all));
      }
      return { size, sha256 };
    },
  };
}
