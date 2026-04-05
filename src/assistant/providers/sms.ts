import { createHmac, timingSafeEqual } from "node:crypto";
import { createLogger } from "../../logger.js";
import type { AssistantConfig } from "../../config/index.js";
import type { SmsProvider, SmsSendResult } from "../types.js";

const log = createLogger("assistant:sms");

class DisabledSmsProvider implements SmsProvider {
  readonly name = "disabled";

  async sendMessage(): Promise<SmsSendResult> {
    return {
      provider: this.name,
      status: "pending-config",
      error: "SMS provider is not configured.",
    };
  }
}

class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";

  constructor(private readonly fromNumber: string | null) {}

  async sendMessage(to: string, body: string): Promise<SmsSendResult> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken || !this.fromNumber) {
      return {
        provider: this.name,
        status: "pending-config",
        error: "Missing Twilio credentials or from number.",
      };
    }

    try {
      const payload = new URLSearchParams({
        To: to,
        From: this.fromNumber,
        Body: body,
      });

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: payload,
        }
      );

      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const errorMessage =
          typeof result.message === "string"
            ? result.message
            : `Twilio request failed with status ${response.status}`;
        return {
          provider: this.name,
          status: "failed",
          error: errorMessage,
        };
      }

      return {
        provider: this.name,
        status: "sent",
        providerMessageId: typeof result.sid === "string" ? result.sid : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ err: error }, "Twilio send failed");
      return {
        provider: this.name,
        status: "failed",
        error: message,
      };
    }
  }
}

export function createSmsProvider(config: AssistantConfig): SmsProvider {
  if (config.sms.provider !== "twilio") {
    return new DisabledSmsProvider();
  }

  const fromNumber = config.sms.fromNumber ?? process.env.TWILIO_PHONE_NUMBER ?? null;
  return new TwilioSmsProvider(fromNumber);
}

export function validateTwilioSignature(
  authToken: string,
  webhookUrl: string,
  payload: Record<string, string | undefined>,
  providedSignature: string | null | undefined
): boolean {
  if (!providedSignature) {
    return false;
  }

  const sortedEntries = Object.entries(payload)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  const data = sortedEntries.reduce((accumulator, [key, value]) => `${accumulator}${key}${value ?? ""}`, webhookUrl);
  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");

  const providedBuffer = Buffer.from(providedSignature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
