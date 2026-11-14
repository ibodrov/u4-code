import { createU4KubernetesAtoms } from "@t3tools/client-runtime/state/u4Kubernetes";
import { connectionAtomRuntime } from "../connection/runtime";
export const u4Kubernetes = createU4KubernetesAtoms(connectionAtomRuntime);
