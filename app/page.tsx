import { JurisExplorer } from "@/components/juris-explorer";
import { getCategoryOptions, getSourceCoverage } from "@/lib/law-repository";
import { getAllSourceProfiles } from "@/lib/source-registry";

function formatLabel(value: string): string {
  return value.replaceAll("_", " ");
}

export default function HomePage() {
  const sourceCoverage = getSourceCoverage();
  const sourceOptions = [
    { label: "all sources", value: "all" as const },
    ...getAllSourceProfiles().map((source) => ({
      label: source.name,
      value: source.id,
    })),
  ];

  const categoryOptions = getCategoryOptions().map((option) => ({
    ...option,
    label: formatLabel(option.label),
  }));

  return (
    <main className="min-h-screen pb-12">
      <JurisExplorer
        sourceCoverage={sourceCoverage}
        sourceOptions={sourceOptions}
        categoryOptions={categoryOptions}
      />
    </main>
  );
}
