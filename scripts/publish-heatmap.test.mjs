import assert from "node:assert/strict";
import { test } from "node:test";
import { findSectionIndex } from "./publish-heatmap.mjs";

const h2 = (text, id = "h") => ({
  type: "heading_2",
  heading_2: { rich_text: [{ plain_text: text }] },
  id,
});
const table = (id = "t") => ({ type: "table", id });
const cols = (id = "c") => ({ type: "column_list", id });

test("findSectionIndex: locates our Dashboard section heading", () => {
  const kids = [cols(), h2("Next Session"), h2("Training Calendar"), table()];
  assert.equal(findSectionIndex(kids), 2);
});

test("findSectionIndex: -1 when absent or wrong level", () => {
  assert.equal(findSectionIndex([cols(), table()]), -1);
  assert.equal(
    findSectionIndex([
      { type: "heading_3", heading_3: { rich_text: [{ plain_text: "Training Calendar" }] } },
    ]),
    -1,
  );
  assert.equal(findSectionIndex([]), -1);
});
