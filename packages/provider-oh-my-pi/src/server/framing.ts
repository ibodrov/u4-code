import * as Predicate from "effect/Predicate";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;

export class OmpFrameDecoder {
  private buffer = "";
  private pending:
    | {
        id: string;
        count: number;
        length: number;
        size: number;
        chunks: Buffer[];
      }
    | undefined;

  push(chunk: string): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      this.buffer += chunk.slice(start, end);
      if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) throw new Error("OMP frame too large");
      if (newline < 0) break;
      const line = this.buffer.trim();
      this.buffer = "";
      start = newline + 1;
      if (!line) continue;
      const record = this.decode(JSON.parse(line));
      if (record) records.push(record);
    }
    return records;
  }

  end(): void {
    if (this.buffer.length || this.pending) throw new Error("Truncated OMP frame");
  }

  private decode(value: unknown): Record<string, unknown> | undefined {
    if (!Predicate.isObject(value) || Array.isArray(value)) throw new Error("Invalid OMP frame");
    if (value.type !== "rpc_chunk") {
      if (this.pending) throw new Error("Interrupted OMP chunk sequence");
      return value;
    }
    const { chunkId, index, count, byteLength, data } = value;
    if (
      typeof chunkId !== "string" ||
      !chunkId ||
      chunkId.length > 128 ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      count > 256 ||
      index >= count ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < MAX_FRAME_BYTES ||
      byteLength > MAX_REASSEMBLED_BYTES ||
      typeof data !== "string" ||
      data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4
    )
      throw new Error("Invalid OMP chunk metadata");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || bytes.toString("base64") !== data)
      throw new Error("Invalid OMP chunk data");
    if (!this.pending) {
      if (index !== 0) throw new Error("Invalid OMP first chunk");
      this.pending = { id: chunkId, count, length: byteLength, size: 0, chunks: [] };
    }
    const pending = this.pending;
    if (
      pending.id !== chunkId ||
      pending.count !== count ||
      pending.length !== byteLength ||
      pending.chunks.length !== index
    )
      throw new Error("Invalid OMP chunk sequence");
    pending.size += bytes.length;
    if (pending.size > pending.length) throw new Error("OMP chunks exceed declared length");
    pending.chunks.push(bytes);
    if (pending.chunks.length < count) return;
    this.pending = undefined;
    if (pending.size !== pending.length) throw new Error("OMP chunk length mismatch");
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks)),
    );
    if (!Predicate.isObject(decoded) || Array.isArray(decoded) || decoded.type === "rpc_chunk")
      throw new Error("Invalid reassembled OMP frame");
    return decoded;
  }
}
