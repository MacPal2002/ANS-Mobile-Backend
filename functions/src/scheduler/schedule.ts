import * as functions from "firebase-functions";
import {LOCATION} from "../config/firebase/settings";
import {fetchScheduleForGroup, getSemesterInfo} from "../utils/universityService";
import {getAllGroupIdsForSemester, processAndUpdateBatch} from "../utils/firestore";
import {db} from "../utils/admin";
import * as admin from "firebase-admin";


// =================================================================
// Szybka aktualizacja bieżącego tygodnia ==========================
// =================================================================
export const updateCurrentWeekSchedule = functions.scheduler.onSchedule({
  schedule: "*/15 * * * *",
  timeZone: "Europe/Warsaw",
  region: LOCATION,
}, async () => {
  const semesterInfo = getSemesterInfo();
  if (!semesterInfo) {
    console.log("Okres wakacyjny. Zatrzymuję szybką aktualizację.");
    return;
  }

  console.log(`Rozpoczynanie szybkiej aktualizacji dla semestru: ${semesterInfo.identifier}`);
  const groupIds = await getAllGroupIdsForSemester(semesterInfo.identifier);
  if (groupIds.size === 0) {
    console.log(`Brak grup do przetworzenia dla semestru ${semesterInfo.identifier}.`);
    return;
  }

  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  const weekStartTimestamp = monday.getTime();
  const weekId = weekStartTimestamp.toString();

  let totalChangedClasses = 0;
  let batch = db.batch();
  let batchOperationsCounter = 0;

  for (const groupId of groupIds) {
    console.log(`[${groupId}] ⚙️ Rozpoczynam przetwarzanie grupy.`);

    const scheduleItems = await fetchScheduleForGroup(groupId, weekStartTimestamp);
    console.log(`[${groupId}] Otrzymano ${scheduleItems.length} zajęć z zewnętrznego API.`);

    if (scheduleItems.length > 0) {
      // 1. Zapis metadanych grupy (zawsze)
      const groupDocRef = db.collection("schedules").doc(groupId.toString());
      batch.set(groupDocRef, {lastUpdated: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      batchOperationsCounter++;

      console.log(`[${groupId}] Wywołuję processAndUpdateBatch...`);

      // 2. Przetwarzanie zajęć i dodawanie operacji do TEGO SAMEGO batcha
      const {batchOperationsCount: groupClassesOperations, changedClassesCount} =
        await processAndUpdateBatch(scheduleItems, groupId, weekId, batch);
      totalChangedClasses += changedClassesCount;
      batchOperationsCounter += groupClassesOperations;

      console.log(`[${groupId}] Zakończono. Operacje w batchu: ${groupClassesOperations}, Zmiany zajęć: ${changedClassesCount}.`);
    } else {
      console.log(`[${groupId}] Brak danych z API lub błąd pobierania. Pomijam aktualizację.`);
    }

    // 3. Zarządzanie limitem batcha w funkcji nadrzędnej
    if (batchOperationsCounter >= 450) {
      await batch.commit();
      console.log(`⚡️ GŁÓWNY COMMIT: Zapisano paczkę ${batchOperationsCounter} operacji.`);
      batch = db.batch();
      batchOperationsCounter = 0;
    }
  }

  // 4. Zatwierdzenie ostatniej, niepełnej paczki
  if (batchOperationsCounter > 0) {
    await batch.commit();
    console.log(`⚡️ OSTATNI COMMIT: Zapisano końcową paczkę ${batchOperationsCounter} operacji.`);
  }

  console.log(`✅ Szybka aktualizacja zakończona. Zaktualizowano ${totalChangedClasses} zajęć.`);
});
