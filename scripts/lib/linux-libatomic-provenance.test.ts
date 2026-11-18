import { expect, it } from "@effect/vitest";
import { libatomicProvenance } from "./linux-libatomic-provenance.ts";

it("preserves existing source epochs and rejects ambiguous dpkg metadata", () => {
  expect(
    libatomicProvenance(
      "ID=ubuntu\n",
      "libatomic1:amd64: /lib/libatomic.so.1\n",
      "1\tgcc-12\t1:12.2-1\n",
    ),
  ).toContain("https://launchpad.net/ubuntu/+source/gcc-12/1%3A12.2-1");
  for (const args of [
    ["ID=debian\n", "libatomic1: /a\nlibatomic1:i386: /b", "1\tgcc\t1"],
    ["ID=debian\n", "libatomic1: /a", "1 gcc"],
  ])
    expect(() => libatomicProvenance(...(args as [string, string, string]))).toThrow();
});
