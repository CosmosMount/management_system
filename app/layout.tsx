import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
import { APP_NAME, APP_TAGLINE } from "@/lib/branding";
import { FrontendVersionMonitor } from "@/components/frontend-version-monitor";
import { FRONTEND_VERSION } from "@/lib/frontend-version";
import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_TAGLINE,
  other: { "frontend-version": FRONTEND_VERSION },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        {children}
        <FrontendVersionMonitor />
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
