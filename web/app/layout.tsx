import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SFDT",
  description:
    "Public Trailblazer hub and in-browser Flow Studio. Org data never leaves the browser.",
};

/**
 * Inter is self-hosted — the @font-face rules are in `globals.css`, which is
 * imported above, and the woff2 files ship from this origin. There is
 * deliberately no <link> to any other host here: /privacy claims the site makes
 * no third-party request, and this file is where that claim would break first.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
