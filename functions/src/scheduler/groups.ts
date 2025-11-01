import * as functions from "firebase-functions";
import * as scheduler from "firebase-functions/v2/scheduler";
import {LOCATION} from "../config/firebase/settings";
import {fetchGroupTreeForSemester, getSemesterInfo} from "../utils/universityService";
import {processGroupTree} from "../utils/groupProcessor";
import {handleError} from "../utils/helpers";
import {buildTreeForCollection} from "../utils/firestore";
import {db, firestore} from "../utils/admin";
import {COLLECTIONS} from "../config/firebase/collections";
import {WriteBatch} from "firebase-admin/firestore";

/**
 * Funkcja Firebase uruchamiana zgodnie z harmonogramem (1 października o 5:00 rano).
 * Pobiera strukturę grup z API uczelni i zapisuje ją w Firestore.
 */
export const updateDeanGroups = scheduler.onSchedule({
  schedule: "0 1 1 10 *",
  timeZone: "Europe/Warsaw",
  region: LOCATION,
  timeoutSeconds: 300,
  memory: "512MiB",
}, async () => {
  functions.logger.info("🚀 Rozpoczynam zadanie aktualizacji grup!");

  try {
    const semesterInfo = getSemesterInfo(new Date());
    if (!semesterInfo) {
      functions.logger.warn("Uruchomiono 'updateDeanGroups', ale jest okres wakacyjny. Zatrzymuję.");
      return;
    }
    if (semesterInfo.identifier.endsWith("L")) {
      functions.logger.warn(`Uruchomiono 'updateDeanGroups', ale wykryto semestr letni (${semesterInfo.identifier}). Zatrzymuję.`);
      return;
    }
    const {academicYear} = semesterInfo;
    const academicYearStart = parseInt(academicYear.split("-")[0]);
    const winterSemesterId = 90 + (academicYearStart - 2025) * 2;
    functions.logger.info(`Przetwarzanie dla roku akademickiego: ${academicYear}`);

    // === KROK 2: Pobieranie danych ===
    const allItems = await fetchGroupTreeForSemester(winterSemesterId);

    if (allItems.length === 0) {
      functions.logger.warn("Pobrano 0 jednostek. Zakończono zadanie.");
      return;
    }
    functions.logger.info(`Pomyślnie pobrano ${allItems.length} węzłów drzewa grup. Przetwarzanie...`);

    // === KROK 3: Przetwarzanie danych ===
    const batches = processGroupTree(
      allItems,
      academicYear,
      academicYearStart
    );

    // === KROK 4: Zapis do bazy ===
    if (batches.length > 0) {
      await Promise.all(
        batches.map((batch: WriteBatch) => batch.commit())
      );
      functions.logger.info(
        `✅ Zakończono sukcesem! Zapisano ${batches.length} paczek danych dla roku ${academicYear}.`
      );
    } else {
      functions.logger.warn("Nie znaleziono żadnych grup do zapisania.");
      // Nie przerywamy, bo może chcemy tylko odbudować JSON
    }

    // === KROK 5: ZBUDUJ I ZAPISZ DRZEWO JSON ===
    functions.logger.info("Generowanie zbuforowanego drzewa JSON...");
    const deanGroupsRef = db.collection(COLLECTIONS.DEAN_GROUPS);
    const groupTree = await buildTreeForCollection(deanGroupsRef);

    // 3. Zapisz całe drzewo jako jeden dokument
    const configRef = db.collection("config").doc("deanGroupsTree");
    await configRef.set({
      tree: groupTree,
      lastUpdated: firestore.FieldValue.serverTimestamp(),
    });
    functions.logger.info("✅ Pomyślnie zapisano zbuforowane drzewo JSON w 'config/deanGroupsTree'.");
  } catch (error) {
    await handleError(error, "Wystąpił błąd ogólny podczas aktualizacji grup dziekańskich.");
  }
});
