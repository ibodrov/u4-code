# U4 Kubernetes runtime

This Linux amd64 MVP uses one bare Pod per named workspace, two non-root containers,
and one retained PVC. The managing U4 environment runs `kubectl` with an explicit
context and namespace. Kubernetes credentials stay there. The workload has no API
token, host mounts, Docker socket or authenticated publishing peer.

## Cluster preparation

Create a dedicated namespace and install `namespace.yaml` after reviewing its names.
It includes a namespace-scoped manager Role; bind it only to the identity used by
this manager. It does not create a credential or grant cluster-wide access.
Replacement also requires that identity to already be able to `get` the previous
Node so a lost node cannot be treated as fenced. A denied node read refuses restart.
The workload itself needs none of these permissions.

The default profile needs `longhorn-retain` (expandable, Retain), a Tailscale operator
in namespace `tailscale`, and an untainted Linux amd64 node with 2.5 CPU/8 GiB of
unrequested capacity. Limits total 4 CPU/12 GiB. No dedicated-node toleration is added.
Start with one workspace; the profile cap is at most two Pods. Each Pod requests a
32 GiB PVC. Expansion is an explicit administrator PVC change, never automatic.

The policy allows DNS to kube-dns and public HTTPS, blocks private/LAN/metadata
addresses, and permits port 4773 ingress from the operator namespace. Run actual
allow/deny probes on each cluster: policy objects alone do not prove enforcement.
An operator LoadBalancer Service is a tailnet endpoint, not public ingress or HTTPS.

## Build images from this fork

From the repository root, with installed pinned dependencies and `vp` on PATH:

```sh
vp run --filter t3 build
node apps/server/scripts/cli.ts build-exe --target linux-x64
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
node apps/server/scripts/u4-stage-kubernetes.ts /tmp/u4-k8s-image
```

The staging script reuses CLI runtime dependency selection, patches, and platform
native packages. The image installs Debian's libatomic; it does not use the archive
builder's host-specific dpkg lookup. The executable embeds the fork's server and
uses its matching web assets and resource monitor.

Resolve official Node 24.14.0 and JDK 25 base digests first. Build each target with
those exact digest references; set an exact Pi package version for the runtime:

```sh
docker build --platform linux/amd64 --target builder \
  --build-arg NODE_IMAGE='<node digest reference>' \
  --build-arg JAVA_IMAGE='<temurin digest reference>' \
  -t registry.ibodrov.ca/homelab/u4-builder:<version> /tmp/u4-k8s-image
docker build --platform linux/amd64 --target runtime \
  --build-arg NODE_IMAGE='<node digest reference>' \
  --build-arg JAVA_IMAGE='<temurin digest reference>' --build-arg PI_VERSION='<version>' \
  -t registry.ibodrov.ca/homelab/u4-runtime:<version> /tmp/u4-k8s-image
```

Authenticate to the HTTPS registry using its deployment skill, push versioned images,
and record the registry digests. Do not copy registry credentials into the Pod.
Fresh cluster pulls must work using node-provided pull credentials.

## Manager profile

Write `<U4 home>/kubernetes/profiles.json` on the managing environment, then restart
that manager so it advertises the capability. Image references must be immutable
`registry.ibodrov.ca/homelab/u4-*` digests:

```json
[
  {
    "id": "local-k3s",
    "label": "Local k3s",
    "context": "default",
    "namespace": "u4-k8s-mvp",
    "runtimeImage": "registry.ibodrov.ca/homelab/u4-runtime@sha256:<64 hex digits>",
    "builderImage": "registry.ibodrov.ca/homelab/u4-builder@sha256:<64 hex digits>",
    "storageClass": "longhorn-retain",
    "storageGiB": 32,
    "maxWorkspaces": 2
  }
]
```

Keep the manager's `kubernetes/workspaces.json` ledger. It owns Pod UIDs, generations,
PVC names, source hashes and environment IDs. Do not hand-edit its resource IDs or
point its profile at another cluster/namespace. The Service and PVC carry the manager
and workspace labels. A mismatched UID or label fails closed.

The image fixes worktrees under `/workspace/worktrees`, Maven artifacts/wrapper under
`/cache/maven` and npm cache under `/cache/npm`. Only the server sees `/state` and the
persisted `/provider` home. Builder commands inherit an allowlist, not the server's
provider variables. Install only the selected provider credential in that home.
Only a credential-free HTTPS origin is preserved for repository grouping (GitHub SSH URLs become HTTPS). Credential helpers, SSH agents, GitHub tokens and kubeconfig are not copied.

## Recovery and limits

Container restart keeps the Pod UID. Pod replacement is explicit and only allowed
once the previous Pod is gone and its node is healthy; never force-delete a lost Pod
to bypass fencing. The PVC generation marker terminates a stale server that can still
see the volume. The Service selector advances to the recorded generation. A failed
bootstrap can be completed with status refresh/reattachment; it never creates a
second Pod. Partial PVC/Service creation failure may require administrator repair of
those owned resources before retrying.

Bundles are capped at 256 MiB in this MVP. Imports preserve the exact source HEAD;
result exports include one selected result branch and orchestration checkpoint refs.
The database and provider state remain on the PVC and are not part of result bundles.
Staging has no remote and publication is deliberately absent. Keep returned artifacts
outside the source checkout. See the [user guide](../../../docs/user/remote-access.md#u4-kubernetes-workspaces)
for stop, reattach, retained-data and publication behavior.

The build helper isolates commands that use it. It cannot protect against commands
launched directly by a provider, node-wide pressure, or a privileged cluster operator.
It accepts one heavy command at a time, streams output, cancels the owned process
group and fails explicitly if the builder disappears. It never replays a command.
