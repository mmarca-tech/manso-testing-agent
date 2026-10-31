import { stat } from "node:fs/promises";

/** True when something exists at `path` (file or directory). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
