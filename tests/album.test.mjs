import assert from "node:assert/strict";
import { test } from "node:test";

// Album glue is timer-based and lives in the bot entrypoint; the merge rule
// itself is pure and tested here.
process.env.TELEGRAM_BOT_TOKEN ??= "0:test";
const { mergeAlbum } = await import("../dist/channel/album.js");

const img = (n) => ({ mediaType: "image/jpeg", data: `bytes-${n}` });

test("mergeAlbum: one captioned photo plus two bare siblings become one turn", () => {
  const out = mergeAlbum([
    { text: "", attachments: [img(1)] },
    { text: "", attachments: [img(2)] },
    { text: "Remember this: image 1 = milk, image 2 = peanut butter", attachments: [img(3)] },
  ]);
  assert.equal(out.text, "Remember this: image 1 = milk, image 2 = peanut butter");
  assert.deepEqual(
    out.attachments.map((a) => a.data),
    ["bytes-1", "bytes-2", "bytes-3"],
  );
});

test("mergeAlbum: empty album stays empty", () => {
  assert.deepEqual(mergeAlbum([]), { text: "", attachments: [] });
  assert.deepEqual(mergeAlbum([{ text: "  ", attachments: [] }]), { text: "", attachments: [] });
});
