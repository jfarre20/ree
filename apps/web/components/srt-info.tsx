"use client";

import { useState } from "react";
import { Copy, Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { srtUrl } from "@/lib/utils";

interface SrtInfoProps {
  port: number;
  latency?: number;
  passphrase?: string | null;
  streamId: string;
  isStopped: boolean;
  onRegenerate?: () => void;
}

export function SrtInfo({ port, latency = 150, passphrase, streamId, isStopped, onRegenerate }: SrtInfoProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  const hostname = process.env.NEXT_PUBLIC_SRT_HOSTNAME
    || (typeof window !== "undefined" ? window.location.hostname : "your-server-ip");
  const url = srtUrl(hostname, port, latency);

  const copyUrl = async () => {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const copyKey = async () => {
    if (passphrase) {
      await navigator.clipboard.writeText(passphrase);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  return (
    <div className="rounded-md border border-border bg-muted/40 p-4 space-y-3">
      {/* Server URL */}
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
          Server
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-background px-3 py-2 text-sm font-mono text-foreground">
            {url}
          </code>
          <Button variant="ghost" size="icon" onClick={copyUrl} className="shrink-0">
            {copiedUrl ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Stream Key (passphrase) */}
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
          Stream Key
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-background px-3 py-2 text-sm font-mono text-foreground">
            {passphrase ?? "—"}
          </code>
          <Button variant="ghost" size="icon" onClick={copyKey} className="shrink-0" disabled={!passphrase}>
            {copiedKey ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
          </Button>
          {onRegenerate && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onRegenerate}
              className="shrink-0"
              disabled={!isStopped}
              title={isStopped ? "Regenerate stream key" : "Stop the stream first"}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Protocol: <span className="text-foreground">SRT</span> &nbsp;|&nbsp;
        Port: <span className="text-foreground">{port}/UDP</span> &nbsp;|&nbsp;
        Latency: <span className="text-foreground">{latency}ms</span> &nbsp;|&nbsp;
        Encryption: <span className="text-foreground">{passphrase ? "enabled" : "none"}</span>
      </p>
    </div>
  );
}
