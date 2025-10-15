import * as functions from "firebase-functions";
import {LOCATION} from "../config/firebase/settings";
import {db} from "../utils/admin";
import {COLLECTIONS} from "../config/firebase/collections";

export const clearObservedGroupsForStudent = functions.scheduler.onSchedule({
  schedule: "0 0 1 10 *", // 1 października o północy czasu warszawskiego
  timeZone: "Europe/Warsaw",
  region: LOCATION,
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
