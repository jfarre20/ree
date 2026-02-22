"use client";

import { useState } from "react";
import { Film, Trash2, HardDrive, Play, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileUploader } from "@/components/file-uploader";
import { Toaster } from "@/components/ui/toaster";
import { trpc } from "@/lib/trpc/client";
import { useToast } from "@/hooks/use-toast";
import { formatBytes } from "@/lib/utils";

export default function FilesPage() {
  const { toast } = useToast();
  const { data: files, refetch } = trpc.uploads.list.useQuery();
  const [previewId, setPreviewId] = useState<string | null>(null);

  const deleteMutation = trpc.uploads.delete.useMutation({
    onSuccess: () => { toast({ title: "File deleted" }); refetch(); setPreviewId(null); },
    onError: (e) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const totalSize = files?.reduce((sum, f) => sum + f.size, 0) ?? 0;

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Background Files</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload MP4 videos to use as background when your SRT feed is offline.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Upload Video</CardTitle>
            <CardDescription>MP4, MOV, or MKV · Max 30 MB per file</CardDescription>
          </CardHeader>
          <CardContent>
            <FileUploader
              onUploadComplete={() => {
                toast({ title: "Upload complete" });
                refetch();
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Your Files</CardTitle>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <HardDrive className="h-3.5 w-3.5" />
                {formatBytes(totalSize)} used
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {!files?.length ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
                <Film className="h-10 w-10" />
                <p className="text-sm">No files uploaded yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {files.map((file) => (
                  <div key={file.id} className="rounded-md border border-border overflow-hidden">
                    {/* File row */}
                    <div className="flex items-center gap-3 p-3 hover:bg-muted/30 transition-colors">
                      <Film className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{file.originalName}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatBytes(file.size)} · {new Date(file.uploadedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-muted-foreground hover:text-primary"
                        title={previewId === file.id ? "Close preview" : "Preview"}
                        onClick={() => setPreviewId(previewId === file.id ? null : file.id)}
                      >
                        {previewId === file.id
                          ? <X className="h-4 w-4" />
                          : <Play className="h-4 w-4" />
                        }
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          if (confirm(`Delete "${file.originalName}"?`)) {
                            deleteMutation.mutate({ id: file.id });
                          }
                        }}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    {/* Inline video player */}
                    {previewId === file.id && (
                      <div className="border-t border-border bg-black">
                        <video
                          key={file.id}
                          src={`/api/uploads/${file.id}`}
                          controls
                          autoPlay
                          loop
                          className="w-full max-h-72 object-contain"
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <Toaster />
    </>
  );
}
