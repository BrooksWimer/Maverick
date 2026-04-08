/**
 * Configuration schema for the Codex Orchestrator.
 *
 * Uses Zod for runtime validation. The config file (config/control-plane.json)
 * is the single source of truth for project definitions, routing, and defaults.
 */
import { z } from "zod";

// --- Workstream state machine ---

export const StateTransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string().describe("What causes this transition (e.g. 'plan-approved', 'tests-pass', 'review-done')"),
  autoAdvance: z.boolean().default(false).describe("If true, transition happens without human approval"),
});

export const WorkflowSchema = z.object({
  name: z.string(),
  states: z.array(z.string()),
  initialState: z.string(),
  terminalStates: z.array(z.string()),
  transitions: z.array(StateTransitionSchema),
});

// Default workflow matching the research report's state machine
export const DEFAULT_WORKFLOW: z.infer<typeof WorkflowSchema> = {
  name: "standard",
  states: ["intake", "planning", "implementation", "verification", "review", "done", "blocked"],
  initialState: "intake",
  terminalStates: ["done"],
  transitions: [
    { from: "intake", to: "planning", trigger: "scope-defined", autoAdvance: true },
    { from: "intake", to: "blocked", trigger: "missing-info", autoAdvance: false },
    { from: "blocked", to: "intake", trigger: "info-supplied", autoAdvance: false },
    { from: "planning", to: "implementation", trigger: "plan-approved", autoAdvance: false },
    { from: "implementation", to: "verification", trigger: "implementation-complete", autoAdvance: true },
    { from: "verification", to: "review", trigger: "verification-passed", autoAdvance: true },
    { from: "verification", to: "implementation", trigger: "verification-failed", autoAdvance: true },
    { from: "review", to: "done", trigger: "review-approved", autoAdvance: false },
    { from: "review", to: "implementation", trigger: "changes-requested", autoAdvance: true },
  ],
};

// --- Escalation tiers ---

export const EscalationTierSchema = z.enum(["auto", "approval-gated", "human-decision"]);

export const EscalationRuleSchema = z.object({
  pattern: z.string().describe("Glob or regex matching the action/command"),
  tier: EscalationTierSchema,
  description: z.string().optional(),
});

// --- Execution backend ---

export const ExecutionBackendSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("codex-app-server"),
    transport: z.enum(["stdio", "websocket"]).default("stdio"),
    model: z.string().optional(),
    sandboxMode: z.string().default("workspace-write"),
    approvalPolicy: z.string().default("on-request"),
    nodePath: z.string().optional(),
    codexJsPath: z.string().optional(),
    websocketPort: z.number().int().min(1024).max(65535).default(8765),
    persistExtendedHistory: z.boolean().default(true),
    experimentalRawEvents: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("codex-cli"),
    model: z.string().default("gpt-5.4"),
    approvalMode: z.enum(["auto-edit", "full-auto", "suggest"]).default("auto-edit"),
  }),
  z.object({
    type: z.literal("claude-code"),
    model: z.string().default("sonnet"),
    claudePath: z.string().optional(),
    permissionMode: z.enum(["plan", "auto", "default"]).default("plan"),
    maxTurns: z.number().int().min(1).max(50).default(10),
  }),
  z.object({
    type: z.literal("mock"),
    responseDelay: z.number().default(1000),
  }),
]);

// --- Project definition ---

export const RemoteHostSchema = z.object({
  host: z.string().describe("Hostname or IP address for a trusted remote target"),
  user: z.string().describe("SSH username for the trusted remote target"),
  remotePath: z.string().optional().describe("Primary project path on the remote target"),
  autoApproveReadOnlySsh: z.boolean().default(false).describe(
    "Whether read-only SSH inspection commands to this host may be auto-approved"
  ),
});

export const ProjectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  repoPath: z.string().describe("Absolute path to the project repo root"),
  workflow: WorkflowSchema.optional().describe("Override the default workflow for this project"),
  executionBackend: ExecutionBackendSchema.optional().describe("Override the default execution backend"),
  escalationRules: z.array(EscalationRuleSchema).optional(),
  agentsMdPath: z.string().optional().describe("Custom AGENTS.md path; defaults to <repoPath>/AGENTS.md"),
  skillsPath: z.string().optional().describe("Custom skills directory; defaults to <repoPath>/.agents/skills"),
  remoteHosts: z.array(RemoteHostSchema).optional().describe("Trusted SSH targets for project-scoped remote validation"),
  maxConcurrentWorkstreams: z.number().min(1).max(20).default(3),
  claudeReview: z.object({
    enabled: z.boolean().default(false),
    autoAfterTurn: z.boolean().default(false),
    model: z.string().optional(),
  }).optional(),
  claudePlanning: z.object({
    enabled: z.boolean().default(false),
    autoOnPlanningState: z.boolean().default(false),
    model: z.string().optional(),
  }).optional(),
  metadata: z.record(z.string()).optional().describe("Arbitrary key-value pairs for project-specific config"),
});

// --- Discord routing ---

export const DiscordRouteSchema = z.object({
  projectId: z.string(),
  channelId: z.string(),
  purpose: z.enum(["workstreams", "notifications", "approvals", "logs"]).default("workstreams"),
});

// --- Personal assistant ---

export const AssistantSmsConfigSchema = z.object({
  provider: z.enum(["disabled", "twilio"]).default("disabled"),
  replyToInbound: z.boolean().default(true),
  fromNumber: z.string().nullable().optional(),
  requireSignatureValidation: z.boolean().default(false),
});

export const AssistantDiscordConfigSchema = z.object({
  enabled: z.boolean().default(true),
  channelIds: z.array(z.string()).default([]),
  allowedUserIds: z.array(z.string()).default([]),
  replyInThread: z.boolean().default(false),
});

export const AssistantCalendarConfigSchema = z.object({
  provider: z.enum(["disabled", "memory", "google"]).default("memory"),
  calendarId: z.string().default("primary"),
  defaultEventDurationMinutes: z.number().int().min(5).max(1440).default(30),
});

export const AssistantReminderConfigSchema = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().int().min(15_000).max(3_600_000).default(60_000),
  defaultChannel: z.enum(["discord", "sms"]).default("discord"),
  requireTimeForReminders: z.boolean().default(false),
});

export const AssistantConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agentProjectId: z.string().default("maverick"),
  timeZone: z.string().default("UTC"),
  allowedPhoneNumbers: z.array(z.string()).default([]),
  discord: AssistantDiscordConfigSchema.default({
    enabled: true,
    channelIds: [],
    allowedUserIds: [],
    replyInThread: false,
  }),
  sms: AssistantSmsConfigSchema.default({
    provider: "disabled",
    replyToInbound: true,
    requireSignatureValidation: false,
  }),
  calendar: AssistantCalendarConfigSchema.default({
    provider: "memory",
    calendarId: "primary",
    defaultEventDurationMinutes: 30,
  }),
  reminders: AssistantReminderConfigSchema.default({
    enabled: true,
    pollIntervalMs: 60_000,
    defaultChannel: "sms",
    requireTimeForReminders: false,
  }),
});

export const BriefConfigSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().optional().describe("Five-field cron expression interpreted in the assistant time zone"),
  discordChannelId: z.string().nullable().optional(),
  storagePath: z.string().default("./data/briefs"),
  model: z.string().optional(),
});

// --- Top-level config ---

export const OrchestratorConfigSchema = z.object({
  version: z.literal(1),

  defaults: z.object({
    workflow: WorkflowSchema.default(DEFAULT_WORKFLOW),
    executionBackend: ExecutionBackendSchema.default({
      type: "codex-app-server",
      transport: "stdio",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      persistExtendedHistory: true,
      experimentalRawEvents: false,
    }),
    escalationRules: z.array(EscalationRuleSchema).default([
      { pattern: "rm -rf *", tier: "human-decision", description: "Destructive filesystem operations" },
      { pattern: "git push --force*", tier: "human-decision", description: "Force pushes" },
      { pattern: "git checkout -b *", tier: "auto", description: "Branch creation" },
      { pattern: "npm test*", tier: "auto", description: "Running tests" },
      { pattern: "npm install*", tier: "approval-gated", description: "Installing dependencies" },
    ]),
    maxConcurrentWorkstreams: z.number().default(6),
  }),

  projects: z.array(ProjectSchema).min(1),

  discord: z.object({
    enabled: z.boolean().default(true),
    routes: z.array(DiscordRouteSchema).default([]),
    defaultNotificationChannelId: z.string().nullable().optional(),
  }).default({ enabled: true, routes: [] }),

  http: z.object({
    enabled: z.boolean().default(true),
    port: z.number().default(3847),
    host: z.string().default("127.0.0.1"),
  }).default({ enabled: true, port: 3847, host: "127.0.0.1" }),

  assistant: AssistantConfigSchema.default({
    enabled: false,
    agentProjectId: "maverick",
    timeZone: "UTC",
    allowedPhoneNumbers: [],
    discord: {
      enabled: true,
      channelIds: [],
      allowedUserIds: [],
      replyInThread: false,
    },
    sms: {
      provider: "disabled",
      replyToInbound: true,
      requireSignatureValidation: false,
    },
    calendar: {
      provider: "memory",
      calendarId: "primary",
      defaultEventDurationMinutes: 30,
    },
    reminders: {
      enabled: true,
      pollIntervalMs: 60_000,
      defaultChannel: "sms",
      requireTimeForReminders: false,
    },
  }),

  brief: BriefConfigSchema.default({
    enabled: false,
    discordChannelId: null,
    storagePath: "./data/briefs",
  }),
});

// Type exports
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type RemoteHostConfig = z.infer<typeof RemoteHostSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowSchema>;
export type StateTransition = z.infer<typeof StateTransitionSchema>;
export type EscalationRule = z.infer<typeof EscalationRuleSchema>;
export type EscalationTier = z.infer<typeof EscalationTierSchema>;
export type ExecutionBackend = z.infer<typeof ExecutionBackendSchema>;
export type DiscordRoute = z.infer<typeof DiscordRouteSchema>;
export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;
export type AssistantDiscordConfig = z.infer<typeof AssistantDiscordConfigSchema>;
export type AssistantSmsConfig = z.infer<typeof AssistantSmsConfigSchema>;
export type AssistantCalendarConfig = z.infer<typeof AssistantCalendarConfigSchema>;
export type AssistantReminderConfig = z.infer<typeof AssistantReminderConfigSchema>;
export type BriefConfig = z.infer<typeof BriefConfigSchema>;
