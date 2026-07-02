import nodemailer from "nodemailer";

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
}): Promise<{ sent: boolean; skipped: boolean }> {
  if (!isSmtpConfigured()) {
    console.warn("[email] SMTP 未配置，跳过发送");
    return { sent: false, skipped: true };
  }

  const transporter = createSmtpTransport();
  const from =
    process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || "";

  await transporter.sendMail({
    from,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });

  return { sent: true, skipped: false };
}
