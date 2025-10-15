import {LOCATION} from "../config/firebase/settings";
import * as functions from "firebase-functions";
import {db} from "../utils/admin";
import {buildTreeForCollection} from "../utils/firestore";
import {COLLECTIONS} from "../config/firebase/collections";

export const getGroupDetails = functions.https.onCall({
  region: LOCATION,
}, async (request) => {
  const groupIds = request.data.groupIds;

  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    throw new functions.https.HttpsError("invalid-argument", "Oczekiwano tablicy 'groupIds'.");
  }

  try {
    const promises = groupIds.map((id) => db.collection(COLLECTIONS.GROUP_DETAILS).doc(String(id)).get());
    const snapshots = await Promise.all(promises);

    const groupDetails = snapshots.map((doc) => {
      if (doc.exists) {
        return {
          id: parseInt(doc.id),
          name: doc.data()?.groupName || "Brak nazwy",
        };
      }
      return {id: parseInt(doc.id), name: "Nieznana grupa"};
    });

    return {groups: groupDetails};
  } catch (error) {
    console.error("Błąd podczas pobierania szczegółów grup:", error);
    throw new functions.https.HttpsError("internal", "Błąd serwera.");
  }
});

/**
 * Funkcja wywoływalna do pobierania wszystkich grup dziekańskich w formie drzewa.
 */
export const getAllDeanGroups = functions.https.onCall({
  region: LOCATION,
}, async () => {
  try {
    const deanGroupsRef = db.collection(COLLECTIONS.DEAN_GROUPS);
    const groupTree = await buildTreeForCollection(deanGroupsRef);
    return {tree: groupTree};
  } catch (error) {
    console.error("Błąd podczas budowania drzewa grup:", error);
    throw new functions.https.HttpsError("internal", "Błąd serwera przy budowaniu drzewa grup.");
  }
});

