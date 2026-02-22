import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXTAUTH_URL || "http://localhost:3000"),
  title: "ree — SRT Stream Compositor",
  description: "Self-hosted SRT-to-Twitch compositor with automatic background fallback.",
  icons: {
    icon: "/favicon.png",
  },
  openGraph: {
    title: "ree — SRT Stream Compositor",
    description: "Self-hosted SRT-to-Twitch compositor with automatic background fallback.",
    images: [{ url: "/favicon.png", width: 512, height: 512, alt: "ree" }],
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "ree — SRT Stream Compositor",
    description: "Self-hosted SRT-to-Twitch compositor with automatic background fallback.",
    images: ["/favicon.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
