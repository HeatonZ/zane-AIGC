import assert from "node:assert/strict";
import test from "node:test";
import { visibleInputFields } from "./workflowInputVisibility.js";

test("only explicitly hidden scene inputs are omitted from forms", () => {
  const fields = [{ key: "visible" }, { key: "hidden", hidden: true }, { key: "explicitly-visible", hidden: false }];
  assert.deepEqual(visibleInputFields(fields), [fields[0], fields[2]]);
  assert.equal(fields.length, 3);
});
