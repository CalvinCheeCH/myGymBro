import type { Attachment } from "../media/attachments.js";

/**
 * Telegram album grouping. The Bot API delivers a multi-photo album as
 * separate messages sharing a media_group_id, with the caption on (usually)
 * one of them. Processing each alone means the captionless siblings lose
 * their meaning ("image 1 = X, image 2 = Y" mappings break, and only one
 * photo gets filed). Buffer siblings briefly, then handle them as one turn.
 */

export interface AlbumItem {
  text: string;
  attachments: Attachment[];
}

/**
 * Merge one album's messages in arrival order: captions joined (normally just
 * one), attachments concatenated. Pure, so the merge rule is unit-tested and
 * the timer glue in index.ts stays thin.
 */
export function mergeAlbum(items: AlbumItem[]): { text: string; attachments: Attachment[] } {
  return {
    text: items
      .map((i) => i.text.trim())
      .filter(Boolean)
      .join("\n"),
    attachments: items.flatMap((i) => i.attachments),
  };
}
