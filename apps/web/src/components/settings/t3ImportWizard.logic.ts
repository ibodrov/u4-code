import type { ProjectId, ThreadId, T3ImportSelection } from "@t3tools/contracts";

export const emptyImportSelection = (): T3ImportSelection => ({
  threadIds: [],
  projectIds: [],
  excludeThreadIds: [],
  newCopyUnitRootIds: [],
  projectMapping: [],
});
const toggle = <T>(values: ReadonlyArray<T>, id: T, checked: boolean) =>
  checked ? [...new Set([...values, id])] : values.filter((value) => value !== id);
export function selectImportThread(
  selection: T3ImportSelection,
  projectId: ProjectId,
  threadId: ThreadId,
  checked: boolean,
): T3ImportSelection {
  return selection.projectIds.includes(projectId)
    ? { ...selection, excludeThreadIds: toggle(selection.excludeThreadIds, threadId, !checked) }
    : {
        ...selection,
        threadIds: toggle(selection.threadIds, threadId, checked),
        excludeThreadIds: selection.excludeThreadIds.filter((id) => id !== threadId),
      };
}
export function selectImportProject(
  selection: T3ImportSelection,
  projectId: ProjectId,
  checked: boolean,
): T3ImportSelection {
  return { ...selection, projectIds: toggle(selection.projectIds, projectId, checked) };
}
export function importThreadSelected(
  selection: T3ImportSelection,
  projectId: ProjectId,
  threadId: ThreadId,
) {
  return (
    !selection.excludeThreadIds.includes(threadId) &&
    (selection.projectIds.includes(projectId) || selection.threadIds.includes(threadId))
  );
}
export const canPreviewImport = (selection: T3ImportSelection) =>
  selection.threadIds.length > 0 || selection.projectIds.length > 0;
