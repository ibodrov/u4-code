import { describe, expect, it } from "vite-plus/test";
import { OmpFrameDecoder } from "./framing.ts";
import { resolveOmpLaunchArgs, buildOmpRpcLaunch } from "./launch.ts";

describe("oh-my-pi framing", () => {
  it("preserves fragmented Unicode, CRLF and Unicode line separators", () => {
    const decoder = new OmpFrameDecoder();
    const frame = { type: "message_update", text: "😀\u2028\u2029" };
    const data = JSON.stringify(frame) + "\r\n";
    const records = Array.from(data).flatMap((char) => decoder.push(char));
    expect(records).toEqual([frame]);
    decoder.end();
  });
  it("reassembles bounded v2 byte chunks", () => {
    const value = { type: "message_end", text: "😀".repeat(300000) };
    const bytes = Buffer.from(JSON.stringify(value));
    const decoder = new OmpFrameDecoder();
    const count = Math.ceil(bytes.length / 262144);
    const frames = Array.from({ length: count }, (_, index) => ({
      type: "rpc_chunk",
      chunkId: "chunk",
      index,
      count,
      byteLength: bytes.length,
      data: bytes.subarray(index * 262144, (index + 1) * 262144).toString("base64"),
    }));
    expect(frames.flatMap((frame) => decoder.push(JSON.stringify(frame) + "\n"))).toEqual([value]);
    decoder.end();
    for (const invalid of [
      { ...frames[0], index: 1 },
      { ...frames[0], byteLength: 67108865 },
      { ...frames[0], data: "not-base64" },
    ])
      expect(() => new OmpFrameDecoder().push(JSON.stringify(invalid) + "\n")).toThrow();
    const interrupted = new OmpFrameDecoder();
    interrupted.push(JSON.stringify(frames[0]) + "\n");
    expect(() => interrupted.push('{"type":"agent_end"}\n')).toThrow();
    expect(() => new OmpFrameDecoder().push("x".repeat(1048577))).toThrow();
    expect(() => {
      const truncated = new OmpFrameDecoder();
      truncated.push("{");
      truncated.end();
    }).toThrow();
  });
  it.each([
    "--yolo",
    "--auto-approve",
    "--approval-mode yolo",
    "--mode=rpc",
    "--session=old.jsonl",
    "--continue",
    "--config tools.approvalMode=yolo",
    "hello",
    "--profile --yolo",
  ])("rejects mode, history and positional overrides: %s", (args) => {
    expect(resolveOmpLaunchArgs(args).ok).toBe(false);
  });
  it.each([
    ["approval-required", "always-ask"],
    ["auto-accept-edits", "write"],
    ["full-access", "yolo"],
  ] as const)("maps %s to native %s", (runtimeMode, native) => {
    expect(
      buildOmpRpcLaunch({
        launchArgs: [],
        environment: {},
        runtimeMode,
        sessionDir: "/tmp/sessions",
      }).args,
    ).toContain(native);
  });
});
