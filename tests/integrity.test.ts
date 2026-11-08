import { describe, expect, test } from "bun:test";
import { monitorUpload } from "../worker/integrity";

const bytes = new TextEncoder();

function chunks(values: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= values.length) { controller.close(); return; }
      controller.enqueue(bytes.encode(values[index++]));
    },
  });
}

describe("streamed upload verification", () => {
  test("computes SHA-256 while the store reads the upload", async () => {
    const integrity = monitorUpload(chunks(["a", "b", "c"]), 3);
    expect(await new Response(integrity.stream).text()).toBe("abc");
    expect(await integrity.result()).toEqual({
      size: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });

  test("rejects streams exceeding the announced size", async () => {
    const integrity = monitorUpload(chunks(["ab", "c"]), 2);
    await expect(new Response(integrity.stream).text()).rejects.toThrow("Upload exceeds declared file size");
  });
});
