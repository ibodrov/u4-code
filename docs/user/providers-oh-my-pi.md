# oh-my-pi

U4 Code supports oh-my-pi through its native RPC interface. Install it on the machine running
U4's server and sign in with `omp` and `/login` before enabling it in Settings → Providers.

```sh
bun install -g @oh-my-pi/pi-coding-agent
```

The integration targets OMP 18.14.1. If `omp` is outside the server's PATH, set its binary path
(for example `/home/user/.bun/bin/omp`). Refresh the provider to discover its models and commands.
The **oh-my-pi default** model inherits OMP's configuration. Explicit models expose OMP's supported
thinking levels. Inventory discovery can wait on configured services; a failed refresh retains the
previous inventory, and session startup retries discovery.

U4 starts new conversations in its own instance-specific session directory. Existing terminal
sessions are not imported. U4 conversations can resume after restart and use native conversation
forks and rollback alongside U4's filesystem checkpoints. Do not delete their native files while
keeping the corresponding U4 threads.

The provider uses the selected OMP profile's credentials, configuration, extensions and project
context. Additional U4 provider instances should specify distinct `--profile <name>` launch arguments
when they need separate accounts. Launch arguments cannot change U4's approval mode, transport,
or session selection.

Supervised uses OMP's `always-ask` mode; Auto-accept edits uses `write`; Full access uses `yolo`.
OMP's explicit tool policies can still ask for approval in Full access. Native approval choices
and extension questions appear in U4. A permission-mode change restarts the native process.
These modes control approvals, not filesystem or process containment.

U4 tools are exposed as `u4_<tool>` host tools through the thread's authenticated connection.
Native child progress and cancellation remain attached to the run that started each child.
Background results can start a continuation after the parent has finished.

Voice, side questions, goal controls, interaction-mode switching and application text generation
are not exposed by this integration.
