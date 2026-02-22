"use client";

import Link from "next/link";
import { Play, Square, Settings, Activity } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, SrtBadge } from "@/components/status-badge";
import { trpc } from "@/lib/trpc/client";
import { useToast } from "@/hooks/use-toast";
import type { Stream } from "@/lib/db/schema";

interface StreamCardProps {
  stream: Stream & { liveStatus: unknown };
  onRefresh: () => void;
}

export function StreamCard({ stream, onRefresh }: StreamCardProps) {
  const { toast } = useToast();

  const startMutation = trpc.streams.start.useMutation({
    onSuccess: () => {
      toast({ title: "Stream starting…", description: "Compositor is launching." });
      setTimeout(onRefresh, 1500);
    },
    onError: (e) => toast({ title: "Failed to start", description: e.message, variant: "destructive" }),
  });

  const stopMutation = trpc.streams.stop.useMutation({
    onSuccess: () => {
      toast({ title: "Stream stopping" });
      setTimeout(onRefresh, 1500);
    },
    onError: (e) => toast({ title: "Failed to stop", description: e.message, variant: "destructive" }),
  });

  const isRunning = stream.status === "running" || stream.status === "starting";

  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 flex-1 min-w-0">
            <h3 className="font-semibold truncate">{stream.name}</h3>
            <p className="text-xs text-muted-foreground">
              Port {stream.srtPort} · {stream.outWidth}×{stream.outHeight} · {stream.outFps}fps
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <StatusBadge status={stream.status} />
            {isRunning && <SrtBadge connected={stream.srtConnected} />}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => stopMutation.mutate({ id: stream.id })}
                disabled={stopMutation.isPending}
                className="flex-1"
              >
                <Square className="mr-1.5 h-3.5 w-3.5" />
                Stop
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link href={`/dashboard/streams/${stream.id}/live`}>
                  <Activity className="mr-1.5 h-3.5 w-3.5" />
                  Monitor
                </Link>
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => startMutation.mutate({ id: stream.id })}
              disabled={startMutation.isPending || !stream.twitchStreamKey}
              className="flex-1"
            >
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Start
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/dashboard/streams/${stream.id}`}>
              <Settings className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        {stream.status === "error" && stream.lastError && (
          <p className="mt-2 text-xs text-destructive truncate">{stream.lastError}</p>
        )}
        {!stream.twitchStreamKey && (
          <p className="mt-2 text-xs text-yellow-500">No stream key — configure in settings</p>
        )}
      </CardContent>
    </Card>
  );
}
