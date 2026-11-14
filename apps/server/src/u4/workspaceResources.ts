import type { U4ClusterProfile, U4KubernetesWorkspace } from "@t3tools/contracts";

export const workspaceLabels = (workspace: U4KubernetesWorkspace) => ({
  "app.kubernetes.io/part-of": "u4-code",
  "u4.ibodrov.ca/manager": workspace.ownerId,
  "u4.ibodrov.ca/workspace": workspace.id,
});

export function workspaceResources(profile: U4ClusterProfile, workspace: U4KubernetesWorkspace) {
  const labels = workspaceLabels(workspace);
  const metadata = (name: string) => ({ name, namespace: profile.namespace, labels });
  const securityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
  };
  const common = { securityContext, imagePullPolicy: "Always" };
  const mounts = [
    { name: "data", mountPath: "/workspace", subPath: "workspace" },
    { name: "data", mountPath: "/cache", subPath: "cache" },
    { name: "socket", mountPath: "/run/u4-build" },
  ];
  return {
    pvc: {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: metadata(workspace.pvcName),
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: profile.storageClass,
        resources: { requests: { storage: `${workspace.storageGiB}Gi` } },
      },
    },
    service: {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        ...metadata(workspace.serviceName),
        annotations: {
          "tailscale.com/expose": "true",
          "tailscale.com/hostname": `u4-${workspace.id}`,
        },
      },
      spec: {
        type: "LoadBalancer",
        loadBalancerClass: "tailscale",
        selector: { ...labels, "u4.ibodrov.ca/generation": String(workspace.generation) },
        ports: [{ port: 4773, targetPort: 4773, name: "u4" }],
      },
    },
    pod: {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        ...metadata(workspace.podName),
        labels: { ...labels, "u4.ibodrov.ca/generation": String(workspace.generation) },
      },
      spec: {
        restartPolicy: "Always",
        automountServiceAccountToken: false,
        terminationGracePeriodSeconds: 60,
        nodeSelector: { "kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64" },
        securityContext: {
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: workspace.pvcName } },
          { name: "socket", emptyDir: {} },
          { name: "server-tmp", emptyDir: {} },
          { name: "builder-tmp", emptyDir: {} },
        ],
        initContainers: [
          {
            ...common,
            name: "prepare",
            image: profile.builderImage,
            command: [
              "node",
              "-e",
              "const f=require('fs'); for(const p of ['workspace','cache','state','provider']) f.mkdirSync('/data/'+p,{recursive:true}); f.writeFileSync('/data/state/generation',process.env.GENERATION);",
            ],
            env: [{ name: "GENERATION", value: String(workspace.generation) }],
            volumeMounts: [{ name: "data", mountPath: "/data" }],
            resources: {
              requests: { cpu: "100m", memory: "64Mi" },
              limits: { cpu: "500m", memory: "128Mi" },
            },
          },
        ],
        containers: [
          {
            ...common,
            name: "server",
            image: profile.runtimeImage,
            env: [{ name: "U4_WORKSPACE_GENERATION", value: String(workspace.generation) }],
            ports: [{ containerPort: 4773 }],
            volumeMounts: [
              ...mounts,
              { name: "server-tmp", mountPath: "/tmp" },
              { name: "data", mountPath: "/state", subPath: "state" },
              { name: "data", mountPath: "/provider", subPath: "provider" },
            ],
            resources: {
              requests: { cpu: "500m", memory: "2Gi" },
              limits: { cpu: "1", memory: "3Gi" },
            },
            readinessProbe: { tcpSocket: { port: 4773 }, initialDelaySeconds: 2, periodSeconds: 5 },
          },
          {
            ...common,
            name: "builder",
            image: profile.builderImage,
            volumeMounts: [...mounts, { name: "builder-tmp", mountPath: "/tmp" }],
            resources: {
              requests: { cpu: "2", memory: "6Gi" },
              limits: { cpu: "3", memory: "9Gi" },
            },
          },
        ],
      },
    },
  };
}
