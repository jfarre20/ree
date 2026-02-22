"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Twitch } from "lucide-react";

export function SignInButton({ large }: { large?: boolean }) {
  return (
    <Button
      size={large ? "lg" : "default"}
      className="bg-twitch hover:bg-twitch/90 text-white gap-2"
      onClick={() => signIn("twitch", { callbackUrl: "/dashboard" })}
    >
      <Twitch className={large ? "h-5 w-5" : "h-4 w-4"} />
      Sign in with Twitch
    </Button>
  );
}
