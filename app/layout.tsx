import "./globals.css";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Voice Agent - Real-time Streaming",
  description: "AI-powered voice agent with real-time streaming capabilities",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-950 antialiased">{children}</body>
    </html>
  );
}
