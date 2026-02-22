import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SignInButton } from "./sign-in-button";
import { Wifi, Film, Zap, Shield } from "lucide-react";

export default async function LandingPage() {
  const session = await getServerSession(authOptions);
  if (session?.user?.id) redirect("/dashboard");

  return (
    <main className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
            ree
          </span>
          <span className="text-xs text-muted-foreground font-mono mt-1">by reestreamer</span>
        </div>
        <SignInButton />
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-4 py-20 gap-8">
        <div className="space-y-4 max-w-2xl">
          <h1 className="text-5xl font-extrabold tracking-tight bg-gradient-to-br from-white via-purple-200 to-purple-400 bg-clip-text text-transparent">
            SRT → Twitch,<br />zero dead air.
          </h1>
          <p className="text-xl text-muted-foreground max-w-xl mx-auto">
            Stream over SRT from anywhere. Ree keeps your Twitch channel live
            with a background video whenever your feed drops — automatically.
          </p>
        </div>

        <SignInButton large />

        <p className="text-xs text-muted-foreground">
          Sign in with your Twitch account — no credit card required.
        </p>
      </section>

      {/* Features */}
      <section className="border-t border-border/50 px-6 py-16">
        <div className="max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            {
              icon: Wifi,
              title: "SRT Ingest",
              desc: "Low-latency SRT listener. Use OBS, Larix, or any SRT encoder.",
            },
            {
              icon: Film,
              title: "Background Fallback",
              desc: "Upload a looping background video. It plays automatically when your feed drops.",
            },
            {
              icon: Zap,
              title: "Always On",
              desc: "H.264 + AAC at 30 fps, no dropped frames. Auto-reconnect in < 1 second.",
            },
            {
              icon: Shield,
              title: "Self-Hosted",
              desc: "Runs on your own server. Your stream key stays on your machine.",
            },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-lg border border-border/50 bg-card p-5 space-y-3">
              <Icon className="h-8 w-8 text-primary" />
              <h3 className="font-semibold">{title}</h3>
              <p className="text-sm text-muted-foreground">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border/50 text-center py-6 text-xs text-muted-foreground">
        ree — self-hosted SRT compositor
      </footer>
    </main>
  );
}
