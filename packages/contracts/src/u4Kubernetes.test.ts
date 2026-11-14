import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { U4ClusterProfile } from "./u4Kubernetes.ts";

const isProfile = Schema.is(U4ClusterProfile);
const digest = `@sha256:${"a".repeat(64)}`;
const profileWith = (runtimeImage: string) => ({
  id: "local",
  label: "Local",
  context: "default",
  namespace: "u4-workspaces",
  runtimeImage,
  builderImage: `registry.example.com/u4/u4-builder${digest}`,
  storageClass: "local-retain",
  storageGiB: 32,
  maxWorkspaces: 1,
});

it("accepts digest-pinned images from any explicit registry and refuses mutable references", () => {
  for (const image of [
    `registry.example.com/u4/u4-runtime${digest}`,
    `ghcr.io/example-org/tools/u4_runtime.v2${digest}`,
    `registry.internal:5000/u4-runtime${digest}`,
    `localhost/u4-runtime${digest}`,
    `localhost:5000/u4/u4-runtime${digest}`,
    `ghcr.io/team/runtime:v1${digest}`,
    `registry.example.com/u4/u4-runtime:1.0.0${digest}`,
    `[2001:db8::1]:5000/team/runtime${digest}`,
    `[2001:db8::1]/team/runtime:v1${digest}`,
  ])
    expect(isProfile(profileWith(image)), image).toBe(true);
  for (const image of [
    "registry.example.com/u4/u4-runtime:1.0.0",
    "[2001:db8::1]:5000/team/runtime:v1",
    `ghcr.io/team/runtime:-v1${digest}`,
    `[2001:db8::1]:/team/runtime${digest}`,
    `u4/u4-runtime${digest}`,
    `https://registry.example.com/u4/u4-runtime${digest}`,
    `registry.example.com/U4/u4-runtime${digest}`,
    `registry.example.com/u4/u4-runtime${digest} `,
    `registry.example.com/u4/u4-runtime@sha256:${"A".repeat(64)}`,
    `registry.example.com${digest}`,
  ])
    expect(isProfile(profileWith(image)), image).toBe(false);
});
