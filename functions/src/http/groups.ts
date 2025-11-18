/* eslint-disable @typescript-eslint/no-explicit-any */
import {LOCATION} from "../config/firebase/settings";
import * as functions from "firebase-functions";
import {db} from "../utils/admin";
import {COLLECTIONS} from "../config/firebase/collections";

let cachedDeanGroupTree: any | null = null;
let cacheTimestamp: number | null = null;

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
  // Sprawdź, czy cache istnieje i nie jest starszy niż 1 godzina
  if (cachedDeanGroupTree && cacheTimestamp && (Date.now() - cacheTimestamp < 3600000)) {
    functions.logger.info("Zwracam drzewo grup z CACHE'A PAMIĘCI (0 odczytów).");
    return cachedDeanGroupTree;
  }

  try {
    functions.logger.warn("CACHE MISS: Pobieram drzewo grup z Firestore (1 odczyt).");
    const configRef = db.collection("config").doc("deanGroupsTree");
    const doc = await configRef.get();

    if (!doc.exists) {
      functions.logger.error("Krytyczny błąd: Dokument 'config/deanGroupsTree' nie istnieje.");
      throw new functions.https.HttpsError("not-found", "Nie znaleziono konfiguracji drzewa grup.");
    }
    const treeData = doc.data();

    cachedDeanGroupTree = treeData;
    cacheTimestamp = Date.now();
    return treeData;
  } catch (error) {
    console.error("Błąd podczas pobierania drzewa grup:", error);
    throw new functions.https.HttpsError("internal", "Błąd serwera przy pobieraniu drzewa grup.");
  }
});

