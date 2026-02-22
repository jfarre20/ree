"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StreamCard } from "@/components/stream-card";
import { trpc } from "@/lib/trpc/client";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { Toaster } from "@/components/ui/toaster";

export default function DashboardPage() {
  const { toast } = useToast();
  const router = useRouter();
  const { data: streamList, refetch, isLoading } = trpc.streams.list.useQuery(undefined, {
    refetchInterval: 3000, // poll every 3s for live status
  });

  const createMutation = trpc.streams.create.useMutation({
    onSuccess: ({ id }) => {
      router.push(`/dashboard/streams/${id}`);
    },
    onError: (e) => toast({ title: "Could not create stream", description: e.message, variant: "destructive" }),
  });

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Streams</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Each stream gets its own SRT port and compositor process.
            </p>
          </div>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New Stream
          </Button>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-40 rounded-lg border border-border bg-card animate-pulse" />
            ))}
          </div>
        ) : !streamList?.length ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-center border border-dashed border-border rounded-lg">
            <div className="text-4xl">📡</div>
            <div>
              <p className="font-semibold">No streams yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create your first stream to get an SRT ingest URL.
              </p>
            </div>
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
              <Plus className="mr-1.5 h-4 w-4" />
              Create Stream
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {streamList.map((stream) => (
              <StreamCard
                key={stream.id}
                stream={stream}
                onRefresh={() => refetch()}
              />
            ))}
          </div>
        )}
      </div>
      <Toaster />
    </>
  );
}
