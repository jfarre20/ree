"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { srtUrl } from "@/lib/utils";

interface SrtInfoProps {
  port: number;
  latency?: number;
  passphrase?: string | null;
}

export function SrtInfo({ port, latency = 150, passphrase }: SrtInfoProps) {
  const [copied, setCopied] = useState(false);

  // Clients connect to this server's IP on the given port
  const hostname = typeof window !== "undefined" ? window.location.hostname : "your-server-ip";
  const url = srtUrl(hostname, port, latency, passphrase ?? undefined);

  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-md border border-border bg-muted/40 p-4 space-y-2">
      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
        SRT Ingest URL (set in your encoder)
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-background px-3 py-2 text-sm font-mono text-foreground">
          {url}
        </code>
        <Button variant="ghost" size="icon" onClick={copy} className="shrink-0">
          {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Protocol: <span className="text-foreground">SRT</span> &nbsp;|&nbsp;
        Port: <span className="text-foreground">{port}/UDP</span> &nbsp;|&nbsp;
        Latency: <span className="text-foreground">{latency}ms</span>
        {passphrase && <> &nbsp;|&nbsp; Passphrase: <span className="text-foreground">set</span></>}
      </p>
    </div>
  );
}
