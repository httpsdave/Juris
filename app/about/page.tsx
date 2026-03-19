import Link from "next/link";
import { ArrowLeft, Scale, ShieldCheck, Zap } from "lucide-react";

export default function AboutPage() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 pb-24 pt-12 sm:px-8 space-y-16 animate-slide-up-cascade">
      <Link
        href="/"
        className="group inline-flex items-center gap-3 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-fg-muted)] hover:text-[var(--color-accent)] transition-colors"
      >
        <ArrowLeft className="h-5 w-5 transition-transform group-hover:-translate-x-1" aria-hidden="true" />
        Return to Index
      </Link>

      <section className="border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-inv)] text-[var(--color-fg-primary-inv)] p-8 sm:p-16 brutal-shadow group transition-all hover:-translate-y-1 hover:shadow-xl">
        <p className="mb-10 inline-flex items-center gap-3 font-mono text-xs font-bold uppercase tracking-widest text-[var(--color-accent)] border-b-2 border-dashed border-[var(--color-fg-muted)] pb-3 w-full">
          <Scale className="h-5 w-5" aria-hidden="true" />
          The Juris Manifesto
        </p>

        <h1 className="text-5xl font-black text-balance sm:text-7xl uppercase tracking-tighter leading-[0.9]">
          The Law is public property. <br/> <span className="text-[var(--color-accent)]">Stop hiding it.</span>
        </h1>

        <p className="mt-10 max-w-3xl font-mono text-lg leading-relaxed opacity-90 border-l-4 border-[var(--color-accent)] pl-6">
          Knowing the law should not require jumping between outdated portals, broken search tools, and scattered repositories.
          Juris exists to make legal information searchable, auditable, and immediate for citizens, students, journalists, and public servants.
        </p>
      </section>

      <section className="grid gap-8 sm:grid-cols-3">
        <InfoCard
          icon={<Zap className="h-6 w-6" aria-hidden="true" />}
          title="Velocity"
          body="Single search surface with ranking, filtering, and direct source links so users find the right material immediately."
        />
        <InfoCard
          icon={<ShieldCheck className="h-6 w-6" aria-hidden="true" />}
          title="Veracity"
          body="Every record displays source and freshness status. Primary government sources are prioritized where available."
        />
        <InfoCard
          icon={<Scale className="h-6 w-6" aria-hidden="true" />}
          title="Transparency"
          body="Community and mirrored sources are treated as discovery aids and clearly separated from official primary publications."
        />
      </section>

      <section className="border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-0)] brutal-shadow flex flex-col md:flex-row">
        <div className="p-8 sm:p-12 border-b-2 md:border-b-0 md:border-r-2 border-[var(--color-fg-primary)] w-full md:w-1/2 cursor-default hover:bg-[var(--color-surface-1)] transition-colors">
          <h2 className="text-3xl font-black uppercase text-[var(--color-fg-primary)] border-b-4 border-[var(--color-accent)] pb-4 mb-6">Why this matters</h2>
          <p className="font-mono text-base leading-relaxed text-[var(--color-fg-muted)]">
            Access to law is mandatory for democratic participation. If legal sources are hard to discover or arbitrarily blocked, ordinary people are left behind.
            Juris prioritizes <strong className="text-[var(--color-fg-primary)] bg-[var(--color-surface-2)]">discoverability and provenance</strong> over cosmetic flair. It forces the reality of the data into the light.
          </p>
        </div>

        <div className="p-8 sm:p-12 w-full md:w-1/2 cursor-default hover:bg-[var(--color-surface-1)] transition-colors">
          <h2 className="text-3xl font-black uppercase text-[var(--color-fg-primary)] border-b-4 border-[var(--color-accent)] pb-4 mb-6">The current reality</h2>
          <p className="font-mono text-base leading-relaxed text-[var(--color-fg-muted)]">
            Some official sites provide clean infrastructure; others require aggressive extraction from legacy HTML, and some outright block automated public access.
            Juris treats ingestion as an auditable pipeline: <strong className="text-[var(--color-accent)]">when a source is blocked or stale, that status is boldly shown—not hidden.</strong> The friction of the state&apos;s infrastructure is part of the record.
          </p>
        </div>
      </section>
    </main>
  );
}

function InfoCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <article className="border-2 border-[var(--color-fg-primary)] bg-[var(--color-surface-1)] p-8 brutal-shadow transition-transform hover:-translate-y-2 hover:bg-[var(--color-surface-0)] cursor-default">
      <div className="mb-6 inline-flex items-center gap-4 text-[var(--color-fg-primary)] border-b-4 border-[var(--color-fg-primary)] pb-4 w-full">
        <div className="bg-[var(--color-surface-0)] border-2 border-[var(--color-fg-primary)] p-2">
          {icon}
        </div>
        <h3 className="font-mono text-lg font-bold uppercase tracking-widest">{title}</h3>
      </div>
      <p className="font-sans text-base leading-relaxed text-[var(--color-fg-muted)] font-medium">
        {body}
      </p>
    </article>
  );
}
