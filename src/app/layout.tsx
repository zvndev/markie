import type { Metadata } from "next";
import "./globals.css";

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
      <body className="antialiased">{children}</body>
    </html>
  );
}
