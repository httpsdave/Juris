import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
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
          <footer className="border-t-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)]">
            <div className="mx-auto flex w-full max-w-7xl items-start gap-4 px-4 py-3 sm:px-8 sm:gap-6">
              <section className="flex-1 space-y-2">
                <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)]">
                  Sources
                </h2>
                <ul className="space-y-1 font-mono text-xs uppercase tracking-wide text-[var(--color-fg-primary)]">
                  <li>
                    <a href="https://lawphil.net" target="_blank" rel="noreferrer" className="hover:text-[var(--color-accent)] transition-colors">
                      Lawphil
                    </a>
                  </li>
                  <li>
                    <a href="https://www.officialgazette.gov.ph" target="_blank" rel="noreferrer" className="hover:text-[var(--color-accent)] transition-colors">
                      Official Gazette
                    </a>
                  </li>
                  <li>
                    <a href="https://www.congress.gov.ph/legis" target="_blank" rel="noreferrer" className="hover:text-[var(--color-accent)] transition-colors">
                      Congress Legislative Portal
                    </a>
                  </li>
                  <li>
                    <a href="https://elibrary.judiciary.gov.ph" target="_blank" rel="noreferrer" className="hover:text-[var(--color-accent)] transition-colors">
                      Supreme Court E-Library
                    </a>
                  </li>
                  <li>
                    <a href="https://open-congress-api.bettergov.ph" target="_blank" rel="noreferrer" className="hover:text-[var(--color-accent)] transition-colors">
                      Open Congress API
                    </a>
                  </li>
                </ul>
              </section>

              <section className="flex shrink-0 items-start gap-3 sm:gap-4 mt-9">
                <Image
                  src="https://github.com/httpsdave.png"
                  alt="httpsdave"
                  width={48}
                  height={48}
                  className="border-2 border-[var(--color-fg-primary)]"
                />
                <div className="space-y-1">
                  <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)]">
                    Built by
                  </h2>
                  <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-fg-primary)]">
                    <a
                      href="https://github.com/httpsdave"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--color-accent)] hover:underline"
                    >
                      httpsdave
                    </a>
                  </p>
                </div>
              </section>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
