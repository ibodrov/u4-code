import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">
        Install a verified U4 Code build from your approved U4 release source on the other computer,
        then run:
      </p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        Use the <code className="font-mono">u4</code> CLI supplied with your U4 build. Add its
        folder to your PATH if the command is not found.
      </p>
    </div>
  );
}
