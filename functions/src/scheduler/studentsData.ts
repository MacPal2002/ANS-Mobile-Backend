import * as functions from "firebase-functions";
import * as scheduler from "firebase-functions/v2/scheduler";
import {LOCATION} from "../config/firebase/settings";
import {db} from "../utils/admin";
import {COLLECTIONS} from "../config/firebase/collections";

export const clearObservedGroupsForStudent = scheduler.onSchedule({
  schedule: "0 0 1 10 *",
  timeZone: "Europe/Warsaw",
  region: LOCATION,
  timeoutSeconds: 300,
  memory: "512MiB",
}, async () => {
  const studentsSnapshot = await db.collection(COLLECTIONS.STUDENT_OBSERVED_GROUPS)
    .where("groups", "!=", [])
    .get();
  const batch = db.batch();
  studentsSnapshot.forEach((doc) => {
    batch.update(doc.ref, {groups: []});
  });
  await batch.commit();
  functions.logger.info("Pomyślnie wyczyszczono obserwowane grupy dla wszystkich studentów.");
});
