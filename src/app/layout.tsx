import type { Metadata } from "next";
import "./globals.css";
import { AppErrorBoundary } from "@/components/app-error-boundary";

export const metadata: Metadata = {
  title: "Markie — Markdown Viewer",
  description: "A beautiful markdown viewer and editor",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        {/* Wraps everything: a render error anywhere below used to unmount the
            whole tree and leave a blank window with nothing written down. */}
        <AppErrorBoundary>{children}</AppErrorBoundary>
      </body>
    </html>
  );
}
