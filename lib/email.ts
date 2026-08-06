import nodemailer from "nodemailer";
import { logger } from "@/lib/logger";

export function isSmtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASSWORD,
  );
}

export function normalizeEmailAddress(email: string): string {
  const trimmed = email.trim();
  if (!trimmed) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error("邮箱格式不正确");
  }
  return trimmed.toLowerCase();
}

function configuredEmailAllowlist(): Set<string> {
  return new Set(
    (process.env.EMAIL_DELIVERY_ALLOWED_ADDRESSES ?? "")
      .split(/[\n,，;；]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function createSmtpTransport() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) {
    throw new Error("SMTP 未配置");
  }

  const port = Number(process.env.SMTP_PORT ?? 587);
  const secure = process.env.SMTP_SECURE === "true";

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    ...(secure
      ? {}
      : {
          requireTLS: process.env.SMTP_REQUIRE_TLS !== "false",
        }),
  });
}

export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<
  | { sent: true; skipped: false }
  | {
      sent: false;
      skipped: true;
      reason: "delivery_disabled" | "smtp_not_configured" | "recipient_not_allowed";
    }
> {
  if (process.env.NOTIFICATION_DELIVERY_DISABLED === "true") {
    logger.info("email.delivery.skipped", {
      module: "email",
      action: "sendEmail",
      reason: "NOTIFICATION_DELIVERY_DISABLED",
      result: "skipped",
    });
    return { sent: false, skipped: true, reason: "delivery_disabled" };
  }

  const normalizedRecipient = normalizeEmailAddress(options.to);
  const allowlist = configuredEmailAllowlist();
  if (allowlist.size > 0 && !allowlist.has(normalizedRecipient)) {
    logger.info("email.delivery.skipped", {
      module: "email",
      action: "sendEmail",
      reason: "recipient_not_allowed",
      result: "skipped",
    });
    return { sent: false, skipped: true, reason: "recipient_not_allowed" };
  }

  if (!isSmtpConfigured()) {
    logger.warn("email.smtp.skipped_not_configured", {
      module: "email",
      action: "sendEmail",
    });
    return { sent: false, skipped: true, reason: "smtp_not_configured" };
  }

  const transporter = createSmtpTransport();
  const from =
    process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || "";

  await transporter.sendMail({
    from,
    to: normalizedRecipient,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });

  return { sent: true, skipped: false };
}
