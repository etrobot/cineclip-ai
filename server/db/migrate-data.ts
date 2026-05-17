import { db } from "./index";
import { author, originalPost, clips, shots } from "./schema";

export async function migrateClipsJson() {
  console.log("migrateClipsJson is deprecated, data now lives in SQLite");
}