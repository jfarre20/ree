"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Square, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, SrtBadge } from "@/components/status-badge";
import { Toaster } from "@/components/ui/toaster";
import { trpc } from "@/lib/trpc/client";
import { useToast } from "@/hooks/use-toast";

export default function LiveMonitorPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const { data: stream, refetch: refetchStream } = trpc.streams.get.useQuery(
    { id },
    { refetchInterval: 2000 }
  );

  const { data: logs, refetch: refetchLogs } = trpc.streams.getLogs.useQuery(
    { id },
    { refetchInterval: 1500 }
  );

  const stopMutation = trpc.streams.stop.useMutation({
    onSuccess: () => toast({ title: "Stream stopping" }),
    onError: (e) => toast({ title: "Failed to stop", description: e.message, variant: "destructive" }),
  });

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  const isRunning = stream?.status === "running" || stream?.status === "starting";

  const uptime = stream?.startedAt
    ? Math.round((Date.now() - new Date(stream.startedAt).getTime()) / 1000)
    : 0;

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href={`/dashboard/streams/${id}`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-bold">{stream?.name ?? "Stream"}</h1>
              {stream && <StatusBadge status={stream.status} />}
              {isRunning && stream && <SrtBadge connected={stream.srtConnected} />}
            </div>
          </div>
          {isRunning && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => stopMutation.mutate({ id })}
              disabled={stopMutation.isPending}
            >
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Stop
            </Button>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Status" value={stream?.status ?? "—"} />
          <StatCard label="SRT" value={stream?.srtConnected ? "Connected" : "Waiting"} highlight={stream?.srtConnected} />
          <StatCard
            label="Uptime"
            value={
              isRunning && stream?.startedAt
                ? formatUptime(uptime)
                : "—"
            }
          />
          <StatCard
            label="Output"
            value={stream ? `${stream.outWidth}×${stream.outHeight} · ${stream.outFps}fps` : "—"}
          />
        </div>

        {/* Logs */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Compositor Log</CardTitle>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="rounded"
                  />
                  Auto-scroll
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => { refetchStream(); refetchLogs(); }}
                  className="h-7 w-7"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-[400px] overflow-y-auto rounded-md bg-black/60 p-3 font-mono text-xs text-green-300 space-y-0.5">
              {!logs?.length ? (
                <p className="text-muted-foreground italic">
                  {isRunning ? "Waiting for log output…" : "Stream is not running."}
                </p>
              ) : (
                logs.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all leading-5">
                    {line}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </CardContent>
        </Card>
      </div>
      <Toaster />
    </>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-lg font-semibold mt-1 ${highlight ? "text-green-400" : ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
