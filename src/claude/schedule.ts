function getZonedDateParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

function expandRange(segment: string, min: number, max: number): number[] {
  const [rangePart, stepPart] = segment.split("/");
  const step = stepPart ? Number(stepPart) : 1;
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`Invalid cron step: ${segment}`);
  }

  const [startText, endText] = rangePart === "*" ? [String(min), String(max)] : rangePart.split("-");
  const start = Number(startText);
  const end = endText !== undefined ? Number(endText) : start;

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
    throw new Error(`Invalid cron range: ${segment}`);
  }

  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

function parseField(field: string, min: number, max: number, normalize?: (value: number) => number): Set<number> {
  const values = new Set<number>();

  for (const rawSegment of field.split(",")) {
    const segment = rawSegment.trim();
    if (!segment) {
      continue;
    }

    for (const value of expandRange(segment, min, max)) {
      values.add(normalize ? normalize(value) : value);
    }
  }

  return values;
}

export function cronMatchesDate(schedule: string, date: Date, timeZone: string): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Unsupported cron expression "${schedule}". Expected 5 fields.`);
  }

  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  const parts = getZonedDateParts(date, timeZone);

  const minuteMatches = parseField(minuteField, 0, 59).has(parts.minute);
  const hourMatches = parseField(hourField, 0, 23).has(parts.hour);
  const monthMatches = parseField(monthField, 1, 12).has(parts.month);
  const daySet = parseField(dayField, 1, 31);
  const weekdaySet = parseField(weekdayField, 0, 7, (value) => (value === 7 ? 0 : value));

  const dayFieldIsWildcard = dayField.trim() === "*";
  const weekdayFieldIsWildcard = weekdayField.trim() === "*";
  const dayMatches = daySet.has(parts.day);
  const weekdayMatches = weekdaySet.has(parts.weekday);
  const calendarMatches =
    dayFieldIsWildcard && weekdayFieldIsWildcard
      ? true
      : dayFieldIsWildcard
        ? weekdayMatches
        : weekdayFieldIsWildcard
          ? dayMatches
          : dayMatches || weekdayMatches;

  return minuteMatches && hourMatches && monthMatches && calendarMatches;
}

export function scheduledMinuteKey(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
