import { expect, it } from "vite-plus/test";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  emptyImportSelection,
  importThreadSelected,
  selectImportProject,
  selectImportThread,
  canPreviewImport,
} from "./t3ImportWizard.logic";

it("keeps partial project and individual selections across pages and restores an explicitly selected exclusion", () => {
  const project = ProjectId.make("project"),
    a = ThreadId.make("a"),
    b = ThreadId.make("b");
  let selection = emptyImportSelection();
  expect(canPreviewImport(selection)).toBe(false);
  selection = selectImportProject(selection, project, true);
  selection = selectImportThread(selection, project, a, false);
  expect(importThreadSelected(selection, project, a)).toBe(false);
  expect(importThreadSelected(selection, project, b)).toBe(true);
  expect(selection.excludeThreadIds).toEqual([a]);
  selection = selectImportProject(selection, project, false);
  selection = selectImportThread(selection, project, a, true);
  expect(importThreadSelected(selection, project, a)).toBe(true);
  expect(importThreadSelected(selection, project, b)).toBe(false);
  expect(canPreviewImport(selection)).toBe(true);
  expect(selection.threadIds).toEqual([a]);
});
