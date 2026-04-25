import type {
  AssistantAgendaSnapshot,
  AssistantCalendarSnapshot,
  AssistantPrimaryContext,
  AssistantSearchResult,
  AssistantTaskSnapshot,
} from "./types.js";

type MarkdownSection = {
  title: string;
  lines: string[];
};

export function renderAssistantMarkdown(title: string, summary: string[], sections: MarkdownSection[]): string {
  const lines = [`# ${title}`, ""];

  if (summary.length > 0) {
    lines.push("## Summary", ...summary.map((line) => `- ${line}`), "");
  }

  for (const section of sections) {
    lines.push(`## ${section.title}`);
    if (section.lines.length === 0) {
      lines.push("- None.");
    } else {
      lines.push(...section.lines);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function renderAgendaMarkdown(snapshot: AssistantAgendaSnapshot): string {
  return renderAssistantMarkdown(
    "Assistant Agenda",
    [
      `Generated: ${formatDateTime(snapshot.generatedAt, snapshot.timeZone)}`,
      `Overdue tasks: ${snapshot.overdueTasks.length}`,
      `Due today: ${snapshot.dueTodayTasks.length}`,
      `Open tasks: ${snapshot.openTasks.length}`,
      `Scheduled tasks: ${snapshot.scheduledTasks.length}`,
      `Inbox tasks: ${snapshot.inboxTasks.length}`,
      `Upcoming calendar items: ${snapshot.upcomingCalendar.length}`,
      `Active workstreams: ${snapshot.activeWorkstreams.length}`,
    ],
    [
      {
        title: "Next Action",
        lines: [`- ${snapshot.nextAction}`],
      },
      {
        title: "Overdue",
        lines: snapshot.overdueTasks.map((task) => renderTaskLine(task, snapshot.timeZone)),
      },
      {
        title: "Due Today",
        lines: snapshot.dueTodayTasks.map((task) => renderTaskLine(task, snapshot.timeZone)),
      },
      {
        title: "Scheduled",
        lines: snapshot.scheduledTasks.map((task) => renderTaskLine(task, snapshot.timeZone)),
      },
      {
        title: "Open",
        lines: snapshot.openTasks.map((task) => renderTaskLine(task, snapshot.timeZone)),
      },
      {
        title: "Inbox",
        lines: snapshot.inboxTasks.map((task) => renderTaskLine(task, snapshot.timeZone)),
      },
      {
        title: "Calendar",
        lines: snapshot.upcomingCalendar.map((event) => renderCalendarLine(event, snapshot.timeZone)),
      },
      {
        title: "Workstreams",
        lines: snapshot.activeWorkstreams.map((workstream) =>
          `- [${workstream.projectId}] ${workstream.name} [${workstream.state}]${workstream.currentGoal ? `: ${workstream.currentGoal}` : workstream.summary ? `: ${workstream.summary}` : ""}`
        ),
      },
    ]
  );
}

export function renderInboxMarkdown(
  tasks: AssistantTaskSnapshot[],
  timeZone: string,
  generatedAt: string
): string {
  return renderAssistantMarkdown(
    "Assistant Inbox",
    [
      `Generated: ${formatDateTime(generatedAt, timeZone)}`,
      `Inbox items: ${tasks.length}`,
    ],
    [
      {
        title: "Open Items",
        lines: tasks.map((task) => renderTaskLine(task, timeZone)),
      },
    ]
  );
}

export function renderSearchMarkdown(
  query: string,
  results: AssistantSearchResult[],
  timeZone: string,
  generatedAt: string
): string {
  return renderAssistantMarkdown(
    `Assistant Search - ${query}`,
    [
      `Generated: ${formatDateTime(generatedAt, timeZone)}`,
      `Results: ${results.length}`,
    ],
    [
      {
        title: "Matches",
        lines: results.map((result) => {
          const metadata = [
            result.type,
            result.primaryContext ? `context: ${result.primaryContext}` : null,
            result.relatedAt ? formatDateTime(result.relatedAt, timeZone) : null,
            result.path ? `path: ${result.path}` : null,
          ].filter(Boolean);
          return `- ${result.title}${metadata.length > 0 ? ` (${metadata.join("; ")})` : ""}\n  ${result.excerpt}`;
        }),
      },
    ]
  );
}

export function buildAgendaSummary(snapshot: AssistantAgendaSnapshot): string {
  if (snapshot.overdueTasks.length > 0) {
    return `You have ${snapshot.overdueTasks.length} overdue task${snapshot.overdueTasks.length === 1 ? "" : "s"}. ${snapshot.nextAction}`;
  }

  if (snapshot.dueTodayTasks.length > 0) {
    return `You have ${snapshot.dueTodayTasks.length} task${snapshot.dueTodayTasks.length === 1 ? "" : "s"} due today. ${snapshot.nextAction}`;
  }

  if (snapshot.inboxTasks.length > 0) {
    return `Your inbox has ${snapshot.inboxTasks.length} item${snapshot.inboxTasks.length === 1 ? "" : "s"} waiting for triage. ${snapshot.nextAction}`;
  }

  if (snapshot.openTasks.length > 0) {
    return `You have ${snapshot.openTasks.length} open task${snapshot.openTasks.length === 1 ? "" : "s"}. ${snapshot.nextAction}`;
  }

  if (snapshot.upcomingCalendar.length > 0) {
    return `Your next calendar item is ${snapshot.upcomingCalendar[0]?.title ?? "coming up soon"}. ${snapshot.nextAction}`;
  }

  if (snapshot.activeWorkstreams.length > 0) {
    return `You have ${snapshot.activeWorkstreams.length} active workstream${snapshot.activeWorkstreams.length === 1 ? "" : "s"}. ${snapshot.nextAction}`;
  }

  return snapshot.nextAction;
}

function renderTaskLine(task: AssistantTaskSnapshot, timeZone: string): string {
  const parts = [
    `id: ${task.id}`,
    `context: ${task.primaryContext}`,
    `status: ${task.status}`,
    task.dueAt ? `due: ${formatDateTime(task.dueAt, timeZone)}` : null,
    task.scheduledFor ? `scheduled: ${formatDateTime(task.scheduledFor, timeZone)}` : null,
  ].filter(Boolean);

  return `- ${task.title} (${parts.join("; ")})${task.details ? `\n  ${task.details}` : ""}`;
}

function renderCalendarLine(event: AssistantCalendarSnapshot, timeZone: string): string {
  const parts = [
    formatDateTime(event.startsAt, timeZone),
    event.recurrenceRule ? `recurs: ${describeRecurrenceRule(event.recurrenceRule)}` : null,
    event.location ? `location: ${event.location}` : null,
    `sync: ${event.syncStatus}`,
  ].filter(Boolean);

  return `- ${event.title} (${parts.join("; ")})`;
}

function formatDateTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function normalizeStoredContext(value: string | null | undefined): AssistantPrimaryContext {
  switch (value) {
    case "work":
    case "home":
    case "errands":
    case "health":
    case "planning":
    case "personal":
      return value;
    case "general":
    default:
      return "personal";
  }
}

function describeRecurrenceRule(rule: string): string {
  if (rule === "RRULE:FREQ=DAILY") {
    return "daily";
  }
  if (rule === "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") {
    return "every weekday";
  }
  if (rule === "RRULE:FREQ=WEEKLY;BYDAY=SA,SU") {
    return "every weekend";
  }

  const byDayMatch = rule.match(/BYDAY=([A-Z,]+)/);
  if (!byDayMatch?.[1]) {
    return "recurring";
  }

  const dayLabels: Record<string, string> = {
    SU: "Sunday",
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
  };

  const labels = byDayMatch[1]
    .split(",")
    .map((value) => dayLabels[value] ?? value)
    .filter(Boolean);

  return labels.length > 0 ? labels.join(", ") : "recurring";
}
