import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StreamStatus = "stopped" | "starting" | "running" | "error";

const configs: Record<StreamStatus, { label: string; dot: string; variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" }> = {
  stopped:  { label: "Stopped",  dot: "bg-zinc-500",  variant: "secondary" },
  starting: { label: "Starting", dot: "bg-yellow-400 animate-pulse", variant: "warning" },
  running:  { label: "Live",     dot: "bg-green-400 animate-pulse", variant: "success" },
  error:    { label: "Error",    dot: "bg-red-500",   variant: "destructive" },
};

export function StatusBadge({ status }: { status: StreamStatus }) {
  const cfg = configs[status] ?? configs.stopped;
  return (
    <Badge variant={cfg.variant} className="gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", cfg.dot)} />
      {cfg.label}
    </Badge>
  );
}

export function SrtBadge({ connected }: { connected: boolean }) {
  return (
    <Badge variant={connected ? "success" : "secondary"} className="gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", connected ? "bg-green-400 animate-pulse" : "bg-zinc-500")} />
      SRT {connected ? "Connected" : "Waiting"}
    </Badge>
  );
}
