export function getRuntimeInstanceId(): string {
  const explicit = process.env.MAVERICK_INSTANCE_ID?.trim();
  if (explicit) {
    return explicit;
  }

  const hostName =
    process.env.COMPUTERNAME?.trim() ||
    process.env.HOSTNAME?.trim() ||
    process.env.HOST?.trim();

  return hostName && hostName.length > 0 ? hostName.toLowerCase() : "default";
}

export type MaverickRuntimeRole = "server" | "client";

export function getRuntimeRole(): MaverickRuntimeRole {
  const explicit = process.env.MAVERICK_ROLE?.trim().toLowerCase();
  if (explicit === "server" || explicit === "client") {
    return explicit;
  }

  return "server";
}

export function ownsServerSideWork(): boolean {
  return getRuntimeRole() === "server";
}
