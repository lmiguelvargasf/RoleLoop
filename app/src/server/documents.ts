import { chromium } from "playwright";
import nodemailer from "nodemailer";
import type { Draft, Opportunity, Profile } from "../shared/types.js";
import { settings } from "./config.js";
import { careerFacts } from "../shared/types.js";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export async function resumePdf(draft: Draft): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:20mm}body{font:11pt Arial,sans-serif;line-height:1.5;color:#172b35}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}h1{font-size:23pt;line-height:1.2;margin:0 0 18px}footer{font-size:9pt;color:#64717a;margin-top:24px}</style><h1>${escape(draft.resume.split("\n")[0] || "Résumé")}</h1><pre>${escape(draft.resume.split("\n").slice(1).join("\n"))}</pre>`,
    );
    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}
function mail(draft: Draft, op: Opportunity, profile: Profile) {
  return {
    from: {
      name: careerFacts(profile)?.name || "RoleLoop tester",
      address: "candidate@roleloop.test",
    },
    to: {
      name: op.contactName || op.company,
      address: "outreach@roleloop.test",
    },
    subject: `[TEST ONLY] ${draft.subject}`,
    text: `Local test. No email was delivered externally.\nIntended contact: ${op.contactEmail || "unconfirmed"}\n\n${draft.body}`,
    headers: { "X-RoleLoop-Draft": draft.id, "X-RoleLoop-Mode": "local-test" },
  };
}
export async function sendToLocalInbox(
  draft: Draft,
  op: Opportunity,
  profile: Profile,
): Promise<string> {
  // The SMTP host and recipient cannot be overridden by data or settings.
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: settings.smtpPort,
    secure: false,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    ignoreTLS: true,
  });
  try {
    const result = await transport.sendMail({
      ...mail(draft, op, profile),
      messageId: `<${draft.id}@roleloop.test>`,
    });
    return String(result.messageId);
  } finally {
    transport.close();
  }
}
