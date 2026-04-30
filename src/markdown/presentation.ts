type MarkdownSection = {
  title: string;
  lines: string[];
};

type MarkdownCalloutTone = "info" | "success" | "warning" | "danger";

export function renderMarkdownDocument(params: {
  title: string;
  summary?: string[];
  facts?: Array<{ label: string; value: string | null | undefined }>;
  callouts?: Array<{ label: string; body: string | null | undefined; tone?: MarkdownCalloutTone }>;
  sections?: MarkdownSection[];
}): string {
  const lines: string[] = [`# ${params.title}`];

  const summary = (params.summary ?? []).map(cleanLine).filter(Boolean);
  if (summary.length > 0) {
    lines.push("", "## Summary", ...summary.map((line) => `- ${line}`));
  }

  const facts = (params.facts ?? [])
    .filter((fact) => cleanLine(fact.value).length > 0)
    .map((fact) => `- **${fact.label}:** ${cleanLine(fact.value)}`);
  if (facts.length > 0) {
    lines.push("", "## Details", ...facts);
  }

  const callouts = (params.callouts ?? [])
    .map((callout) => renderCallout(callout.label, callout.body, callout.tone ?? "info"))
    .filter(Boolean);
  if (callouts.length > 0) {
    lines.push("", ...callouts.flatMap((block) => ["", block]));
  }

  for (const section of params.sections ?? []) {
    const sectionLines = section.lines.map(cleanLine).filter(Boolean);
    lines.push("", `## ${section.title}`);
    if (sectionLines.length === 0) {
      lines.push("- None.");
      continue;
    }
    lines.push(...sectionLines);
  }

  return `${lines.join("\n").trim()}\n`;
}

export function renderCallout(
  label: string,
  body: string | null | undefined,
  tone: MarkdownCalloutTone = "info"
): string {
  const cleaned = cleanLine(body);
  if (!cleaned) {
    return "";
  }

  const badge = toneBadge(tone);
  return `> ${badge} **${label}**\n>\n> ${cleaned.split("\n").join("\n> ")}`;
}

export function renderBulletSection(title: string, values: string[]): MarkdownSection {
  return {
    title,
    lines: values.length > 0 ? values.map((value) => `- ${cleanLine(value)}`) : [],
  };
}

function toneBadge(tone: MarkdownCalloutTone): string {
  switch (tone) {
    case "success":
      return "[OK]";
    case "warning":
      return "[!]";
    case "danger":
      return "[X]";
    case "info":
    default:
      return "[i]";
  }
}

function cleanLine(value: string | null | undefined): string {
  return String(value ?? "").trim();
}
