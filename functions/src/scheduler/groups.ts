import * as functions from "firebase-functions";
import * as scheduler from "firebase-functions/v2/scheduler";
import {LOCATION} from "../config/firebase/settings";
import {fetchGroupTreeForSemester} from "../utils/universityService";
import {processGroupTree} from "../utils/groupProcessor";
import {handleError} from "../utils/helpers";

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
    const now = new Date();
    const currentMonth = now.getMonth();
    let academicYearStart = now.getFullYear();
    if (currentMonth < 9) {
      academicYearStart--;
    }
    const academicYear = `${academicYearStart}-${academicYearStart + 1}`;
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
    const {batch, groupsFoundCounter} = processGroupTree(
      allItems,
      academicYear,
      academicYearStart
    );

    // === KROK 4: Zapis do bazy ===
    if (groupsFoundCounter > 0) {
      await batch.commit();
      functions.logger.info(
        `✅ Zakończono sukcesem! Zapisano ${groupsFoundCounter} grup dla roku ${academicYear}.`
      );
    } else {
      functions.logger.warn(
        "Zakończono przetwarzanie, ale nie znaleziono żadnych grup do zapisania."
      );
    }
  } catch (error) {
    await handleError(error, "Wystąpił błąd ogólny podczas aktualizacji grup dziekańskich.");
  }
});
