"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/dashboard", label: "Streams", icon: LayoutDashboard },
  { href: "/dashboard/files", label: "Files", icon: FolderOpen },
];

export function DashboardNav() {
  const path = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {links.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
            path === href
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
          )}
        >
          <Icon className="h-4 w-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
