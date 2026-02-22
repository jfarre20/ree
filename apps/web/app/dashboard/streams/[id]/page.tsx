"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Save, Trash2, Play, Square, Activity } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge, SrtBadge } from "@/components/status-badge";
import { SrtInfo } from "@/components/srt-info";
import { FileUploader } from "@/components/file-uploader";
import { Toaster } from "@/components/ui/toaster";
import { trpc } from "@/lib/trpc/client";
import { useToast } from "@/hooks/use-toast";
import { formatBytes } from "@/lib/utils";

export default function StreamSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const { data: stream, refetch } = trpc.streams.get.useQuery(
    { id },
    { refetchInterval: 3000 }
  );
  const { data: files } = trpc.uploads.list.useQuery();

  const [form, setForm] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (stream && !dirty) {
      setForm({
        name: stream.name,
        srtLatency: stream.srtLatency,
        srtPassphrase: stream.srtPassphrase ?? "",
        outWidth: stream.outWidth,
        outHeight: stream.outHeight,
        outFps: stream.outFps,
        videoBitrate: stream.videoBitrate,
        audioBitrate: stream.audioBitrate,
        sampleRate: stream.sampleRate,
        backgroundFileId: stream.backgroundFileId ?? "",
        bgAudioFadeDelay: stream.bgAudioFadeDelay,
        twitchStreamKey: stream.twitchStreamKey ?? "",
        twitchIngestServer: stream.twitchIngestServer,
      });
    }
  }, [stream, dirty]);

  const set = (key: string, val: unknown) => {
    setForm((f) => ({ ...f, [key]: val }));
    setDirty(true);
  };

  const updateMutation = trpc.streams.update.useMutation({
    onSuccess: () => {
      toast({ title: "Settings saved" });
      setDirty(false);
      refetch();
    },
    onError: (e) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const startMutation = trpc.streams.start.useMutation({
    onSuccess: () => { toast({ title: "Stream starting…" }); refetch(); },
    onError: (e) => toast({ title: "Failed to start", description: e.message, variant: "destructive" }),
  });

  const stopMutation = trpc.streams.stop.useMutation({
    onSuccess: () => { toast({ title: "Stream stopping" }); refetch(); },
    onError: (e) => toast({ title: "Failed to stop", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = trpc.streams.delete.useMutation({
    onSuccess: () => router.push("/dashboard"),
    onError: (e) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const uploadMutation = trpc.streams.update.useMutation({
    onSuccess: () => refetch(),
  });

  const handleSave = () => {
    updateMutation.mutate({
      id,
      data: {
        name: form.name as string,
        srtLatency: form.srtLatency as number,
        srtPassphrase: (form.srtPassphrase as string) || null,
        outWidth: form.outWidth as number,
        outHeight: form.outHeight as number,
        outFps: form.outFps as number,
        videoBitrate: form.videoBitrate as number,
        audioBitrate: form.audioBitrate as number,
        sampleRate: form.sampleRate as number,
        backgroundFileId: (form.backgroundFileId as string) || null,
        bgAudioFadeDelay: form.bgAudioFadeDelay as number,
        twitchStreamKey: form.twitchStreamKey as string,
        twitchIngestServer: form.twitchIngestServer as string,
      },
    });
  };

  if (!stream) {
    return <div className="animate-pulse text-muted-foreground">Loading…</div>;
  }

  const isRunning = stream.status === "running" || stream.status === "starting";

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="icon" asChild className="mt-0.5 shrink-0">
            <Link href="/dashboard"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold truncate">{stream.name}</h1>
              <StatusBadge status={stream.status} />
              {isRunning && <SrtBadge connected={stream.srtConnected} />}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isRunning ? (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => stopMutation.mutate({ id })}
                  disabled={stopMutation.isPending}
                >
                  <Square className="mr-1.5 h-3.5 w-3.5" /> Stop
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/dashboard/streams/${id}/live`}>
                    <Activity className="mr-1.5 h-3.5 w-3.5" /> Monitor
                  </Link>
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={() => startMutation.mutate({ id })}
                disabled={startMutation.isPending || !stream.twitchStreamKey}
              >
                <Play className="mr-1.5 h-3.5 w-3.5" /> Start
              </Button>
            )}
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || updateMutation.isPending || isRunning}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </div>

        {isRunning && (
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 px-4 py-2 text-sm text-yellow-400">
            Stop the stream before changing settings.
          </div>
        )}

        {/* SRT Info */}
        <SrtInfo
          port={stream.srtPort}
          latency={form.srtLatency as number ?? stream.srtLatency}
          passphrase={(form.srtPassphrase as string) || undefined}
        />

        {/* Settings Tabs */}
        <Tabs defaultValue="general">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="output">Output</TabsTrigger>
            <TabsTrigger value="background">Background</TabsTrigger>
            <TabsTrigger value="twitch">Twitch</TabsTrigger>
          </TabsList>

          {/* General */}
          <TabsContent value="general" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Stream Name</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input
                    value={form.name as string ?? ""}
                    onChange={(e) => set("name", e.target.value)}
                    disabled={isRunning}
                    placeholder="My IRL Stream"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>SRT Settings</CardTitle>
                <CardDescription>Configure the SRT listener that accepts your encoder feed.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <Label>Latency</Label>
                    <span className="text-sm text-muted-foreground">{form.srtLatency as number}ms</span>
                  </div>
                  <Slider
                    min={20} max={2000} step={10}
                    value={[form.srtLatency as number ?? 150]}
                    onValueChange={([v]) => set("srtLatency", v)}
                    disabled={isRunning}
                  />
                  <p className="text-xs text-muted-foreground">
                    150ms is good for most networks. Increase for unstable connections.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Passphrase (optional)</Label>
                  <Input
                    type="password"
                    value={form.srtPassphrase as string ?? ""}
                    onChange={(e) => set("srtPassphrase", e.target.value)}
                    disabled={isRunning}
                    placeholder="Leave blank for no encryption"
                    autoComplete="new-password"
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Output */}
          <TabsContent value="output" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Video Output</CardTitle>
                <CardDescription>H.264 encoder settings for the Twitch stream.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>Resolution</Label>
                  <Select
                    value={`${form.outWidth}x${form.outHeight}`}
                    onValueChange={(v) => {
                      const [w, h] = v.split("x").map(Number);
                      set("outWidth", w);
                      set("outHeight", h);
                    }}
                    disabled={isRunning}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1920x1080">1920×1080 (1080p)</SelectItem>
                      <SelectItem value="1280x720">1280×720 (720p)</SelectItem>
                      <SelectItem value="854x480">854×480 (480p)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Frame Rate</Label>
                  <Select
                    value={String(form.outFps)}
                    onValueChange={(v) => set("outFps", Number(v))}
                    disabled={isRunning}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="60">60 fps</SelectItem>
                      <SelectItem value="30">30 fps</SelectItem>
                      <SelectItem value="24">24 fps</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between">
                    <Label>Video Bitrate</Label>
                    <span className="text-sm text-muted-foreground">
                      {Math.round((form.videoBitrate as number) / 1000)} kbps
                    </span>
                  </div>
                  <Slider
                    min={500000} max={12000000} step={500000}
                    value={[form.videoBitrate as number ?? 4000000]}
                    onValueChange={([v]) => set("videoBitrate", v)}
                    disabled={isRunning}
                  />
                  <p className="text-xs text-muted-foreground">
                    4000–6000 kbps for 720p. 6000–8000 kbps for 1080p. Twitch max: 8000 kbps.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Audio Output</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <Label>Audio Bitrate</Label>
                    <span className="text-sm text-muted-foreground">
                      {Math.round((form.audioBitrate as number) / 1000)} kbps
                    </span>
                  </div>
                  <Slider
                    min={64000} max={320000} step={32000}
                    value={[form.audioBitrate as number ?? 128000]}
                    onValueChange={([v]) => set("audioBitrate", v)}
                    disabled={isRunning}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Sample Rate</Label>
                  <Select
                    value={String(form.sampleRate)}
                    onValueChange={(v) => set("sampleRate", Number(v))}
                    disabled={isRunning}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="48000">48000 Hz (recommended)</SelectItem>
                      <SelectItem value="44100">44100 Hz</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between">
                    <Label>Background Audio Delay</Label>
                    <span className="text-sm text-muted-foreground">
                      {form.bgAudioFadeDelay as number}s
                    </span>
                  </div>
                  <Slider
                    min={0} max={30} step={1}
                    value={[form.bgAudioFadeDelay as number ?? 5]}
                    onValueChange={([v]) => set("bgAudioFadeDelay", v)}
                    disabled={isRunning}
                  />
                  <p className="text-xs text-muted-foreground">
                    Silence duration after SRT drops before background audio resumes.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Background */}
          <TabsContent value="background" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Background Video</CardTitle>
                <CardDescription>
                  Plays on loop when your SRT feed is disconnected. Upload an MP4 or use the default.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FileUploader
                  onUploadComplete={(fileId) => {
                    set("backgroundFileId", fileId);
                    toast({ title: "File uploaded", description: "Select it below to use it." });
                    // also save immediately
                    uploadMutation.mutate({ id, data: { backgroundFileId: fileId } });
                  }}
                />

                {files && files.length > 0 && (
                  <div className="space-y-2">
                    <Label>Select background file</Label>
                    <Select
                      value={(form.backgroundFileId as string) ?? ""}
                      onValueChange={(v) => set("backgroundFileId", v || null)}
                      disabled={isRunning}
                    >
                      <SelectTrigger><SelectValue placeholder="Default (built-in)" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">Default (built-in)</SelectItem>
                        {files.map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.originalName} ({formatBytes(f.size)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Twitch */}
          <TabsContent value="twitch" className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Twitch Output</CardTitle>
                <CardDescription>
                  Where the compositor sends the live stream. Get your stream key from{" "}
                  <a href="https://dashboard.twitch.tv/settings/stream" target="_blank" rel="noreferrer"
                    className="text-primary hover:underline">
                    Twitch Dashboard → Settings → Stream
                  </a>.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Stream Key</Label>
                  <Input
                    type="password"
                    value={form.twitchStreamKey as string ?? ""}
                    onChange={(e) => set("twitchStreamKey", e.target.value)}
                    placeholder="live_xxxxxxxxxxxxxxxxxxxx"
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">
                    Stored on your server only. Never sent to Twitch's API.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Ingest Server</Label>
                  <Select
                    value={form.twitchIngestServer as string ?? "live.twitch.tv"}
                    onValueChange={(v) => set("twitchIngestServer", v)}
                    disabled={isRunning}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="live.twitch.tv">live.twitch.tv (auto)</SelectItem>
                      <SelectItem value="live-ams.twitch.tv">live-ams.twitch.tv (Amsterdam)</SelectItem>
                      <SelectItem value="live-fra.twitch.tv">live-fra.twitch.tv (Frankfurt)</SelectItem>
                      <SelectItem value="live-lhr.twitch.tv">live-lhr.twitch.tv (London)</SelectItem>
                      <SelectItem value="live-jfk.twitch.tv">live-jfk.twitch.tv (New York)</SelectItem>
                      <SelectItem value="live-lax.twitch.tv">live-lax.twitch.tv (Los Angeles)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Separator />

            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm font-medium text-destructive">Delete stream</p>
                <p className="text-xs text-muted-foreground mt-0.5">Permanently removes this stream configuration.</p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (confirm("Delete this stream? This cannot be undone.")) {
                    deleteMutation.mutate({ id });
                  }
                }}
                disabled={isRunning || deleteMutation.isPending}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        {/* Save bar */}
        {dirty && !isRunning && (
          <div className="fixed bottom-6 right-6 z-50">
            <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 shadow-xl">
              <p className="text-sm text-muted-foreground">Unsaved changes</p>
              <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
      <Toaster />
    </>
  );
}
