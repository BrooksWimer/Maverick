# Daily Briefs

Maverick can generate a nightly daily brief that summarizes:

- what was worked on today for each configured project
- the latest known update when a project had no activity today
- what should happen next
- blockers and pending approvals
- workspace hygiene signals from git workspaces and repo roots
- work notes captured today
- upcoming reminders

## Ownership

Daily briefs are Maverick-owned orchestration artifacts.

- Maverick owns the collection, scheduling, Discord delivery, and artifact generation.
- Product repos remain the source of implementation truth.
- Generated brief files are stored under the configured artifact directory, not inside product repos.

## Config

Use the top-level `dailyBrief` config block:

```json
{
  "dailyBrief": {
    "enabled": true,
    "timeZone": "America/New_York",
    "deliveryHour": 21,
    "deliveryMinute": 0,
    "pollIntervalMs": 300000,
    "channelId": "your-discord-channel-id",
    "artifactDirectory": "./data/daily-briefs",
    "maxProjectsInDigest": 10,
    "maxNotesInDigest": 8,
    "maxRemindersInDigest": 5
  }
}
```

Behavior notes:

- `channelId` is optional. If it is missing, Maverick falls back to the Discord default notification channel, then the first assistant Discord channel.
- `timeZone` is optional. If it is missing, Maverick uses `assistant.timeZone`.
- The scheduler is idempotent per local date. Maverick records a `daily-brief.sent` event and will not send the same day's scheduled brief twice.

## Discord

The nightly brief is delivered as a Markdown attachment plus a short inline digest.

You can also preview the current brief manually with:

```text
/brief daily
```

This generates the same report without waiting for the scheduled run.
