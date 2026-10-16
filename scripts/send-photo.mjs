/**
 * Post a local image to a Telegram chat (report cards, progress pictures).
 * The bot's bash tool inherits TELEGRAM_BOT_TOKEN, so this just works in
 * chat; locally run it as `node --env-file=.env scripts/send-photo.mjs ...`.
 *
 * Usage:
 *   node scripts/send-photo.mjs --chat <chatId> --file <png> [--caption "..."]
 */
import fs from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  const chat = arg("chat", "");
  const file = arg("file", "");
  const caption = arg("caption", "");
  if (!chat || !file)
    throw new Error("Usage: send-photo.mjs --chat <id> --file <png> [--caption ...]");
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);

  const form = new FormData();
  form.append("chat_id", chat);
  if (caption) form.append("caption", caption);
  form.append(
    "photo",
    new Blob([fs.readFileSync(file)], { type: "image/png" }),
    path.basename(file),
  );
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`sendPhoto -> ${json.description ?? res.status}`);
  console.log(`Sent photo message ${json.result?.message_id} to ${chat}`);
}

main().catch((err) => {
  console.error(`send-photo failed: ${err.message}`);
  process.exit(1);
});
