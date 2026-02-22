import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { signOut } from "next-auth/react";
import { DashboardNav } from "./nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/");

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top nav */}
      <header className="border-b border-border sticky top-0 z-40 bg-background/80 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <Link href="/dashboard" className="flex items-center gap-2 shrink-0">
            <span className="text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
              ree
            </span>
          </Link>

          <DashboardNav />

          <div className="flex items-center gap-3 shrink-0">
            {session.user.image && (
              <Image
                src={session.user.image}
                alt={session.user.name ?? ""}
                width={32}
                height={32}
                className="rounded-full"
              />
            )}
            <span className="text-sm text-muted-foreground hidden sm:block">
              {session.user.name}
            </span>
            <form action="/api/auth/signout" method="POST">
              <button className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
        {children}
      </main>
    </div>
  );
}
