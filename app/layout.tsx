import type { Metadata } from "next";
import Link from "next/link";
import { Playfair_Display, Bricolage_Grotesque } from "next/font/google";
import { ScaleIcon } from "@heroicons/react/24/outline";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Juris - Philippine Legal Database",
  description:
    "A brutally efficient legal research portal for Philippine laws.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${bricolage.variable} ${playfair.variable} antialiased`}
      >
        <div className="min-h-screen noise-overlay bg-[var(--color-surface-0)] text-[var(--color-fg-primary)] overflow-x-hidden">
          <header className="sticky top-0 z-40 border-b-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-0)] uppercase">
            <div className="flex w-full items-center justify-between px-4 py-3 sm:px-8 max-w-7xl mx-auto">
              <Link href="/" className="font-sans font-black tracking-tighter text-2xl md:text-3xl text-[var(--color-fg-primary)] flex items-center gap-2">
                <ScaleIcon className="h-6 w-6 md:h-8 md:w-8" strokeWidth={1.5} aria-hidden="true" />
                <span>JURIS<span className="text-[var(--color-accent)]">.</span></span>
              </Link>
              <nav className="flex items-center gap-6 text-sm font-bold font-sans tracking-wide">
                <Link
                  href="/"
                  className="hover:text-[var(--color-accent)] transition-colors relative group"
                >
                  Index
                  <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-[var(--color-accent)] transition-all group-hover:w-full"></span>
                </Link>
                <Link
                  href="/about"
                  className="hover:text-[var(--color-accent)] transition-colors relative group"
                >
                  Manifesto
                  <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-[var(--color-accent)] transition-all group-hover:w-full"></span>
                </Link>
              </nav>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
