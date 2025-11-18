// =================================================================
// Przetwarzanie planu zajęć całego semestru w kolejce Cloud Tasks==
// =================================================================

import {FAST_QUEUE_NAME, LOCATION, PROJECT_ID, QUEUE_NAME} from "../config/firebase/settings";
import {db} from "../utils/admin";
import {getAllGroupIdsForSemester, processAndUpdateBatch} from "../utils/firestore";
import {tasksClient} from "../utils/tasks";
import {fetchScheduleForGroup, getSemesterInfo} from "../utils/universityService";
import * as functions from "firebase-functions";
import * as scheduler from "firebase-functions/v2/scheduler";


// =================================================================
// === Dyspozytor (zleca zadania) =======================
// =================================================================

export const scheduleFastSemesterUpdates = scheduler.onSchedule({
  schedule: "0 7-22/2 * * *", // Co 2 godziny od 7:00 do 22:00
  timeZone: "Europe/Warsaw",
  region: LOCATION,
  timeoutSeconds: 60,
  memory: "256MiB",
}, async () => {
  console.log("Rozpoczynanie SZYBKIEGO zlecania zadań (2 tygodnie).");

  const semesterInfo = getSemesterInfo(new Date());
  if (!semesterInfo) {
    console.log("Okres wakacyjny, nie zlecam zadań.");
    return;
  }

  const groupIds = await getAllGroupIdsForSemester(semesterInfo.identifier);
  if (groupIds.size === 0) {
    console.log(`Brak grup do przetworzenia dla semestru ${semesterInfo.identifier}.`);
    return;
  }

  const queuePath = tasksClient.queuePath(PROJECT_ID, LOCATION, FAST_QUEUE_NAME);
  const targetUri = `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/processSingleSemesterUpdate`;

  const tasks = Array.from(groupIds).map((groupId) => {
    const taskBody = {
      groupId: groupId,
      weeksToScan: 2,
    };
    const task = {
      httpRequest: {
        httpMethod: "POST" as const,
        url: targetUri,
        headers: {"Content-Type": "application/json"},
        body: Buffer.from(JSON.stringify(taskBody)).toString("base64"),
      },
    };
    return tasksClient.createTask({parent: queuePath, task});
  });

  await Promise.all(tasks);
  console.log(`Zlecono ${tasks.length} SZYBKICH zadań do kolejki '${FAST_QUEUE_NAME}'.`);
});

export const scheduleFullSemesterUpdates = scheduler.onSchedule({
  schedule: "0 4 * * 0",
  timeZone: "Europe/Warsaw",
  region: LOCATION,
  timeoutSeconds: 60,
  memory: "256MiB",
}, async () => {
  console.log("Rozpoczynanie PEŁNEGO zlecania zadań (25 tygodni).");

  const semesterInfo = getSemesterInfo(new Date());
  if (!semesterInfo) {
    console.log("Okres wakacyjny, nie zlecam zadań.");
    return;
  }

  const groupIds = await getAllGroupIdsForSemester(semesterInfo.identifier);
  if (groupIds.size === 0) {
    console.log(`Brak grup do przetworzenia dla semestru ${semesterInfo.identifier}.`);
    return;
  }

  const queuePath = tasksClient.queuePath(PROJECT_ID, LOCATION, QUEUE_NAME);
  const targetUri = `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/processSingleSemesterUpdate`;

  const tasks = Array.from(groupIds).map((groupId) => {
    const taskBody = {
      groupId: groupId,
      weeksToScan: 25,
    };
    const task = {
      httpRequest: {
        httpMethod: "POST" as const,
        url: targetUri,
        headers: {"Content-Type": "application/json"},
        body: Buffer.from(JSON.stringify(taskBody)).toString("base64"),
      },
    };
    return tasksClient.createTask({parent: queuePath, task});
  });

  await Promise.all(tasks);
  console.log(`Zlecono ${tasks.length} PEŁNYCH zadań do kolejki '${QUEUE_NAME}'.`);
});
// =================================================================
// === Pracownik (wykonuje jedno zadanie) ===============
// =================================================================

export const processSingleSemesterUpdate = functions.https.onRequest({
  region: LOCATION,
  timeoutSeconds: 60,
  memory: "256MiB",
},
async (req, res) => {
  const {groupId, simulationDate, weeksToScan = 2} = req.body;

  if (!groupId) {
    console.error("Brak 'groupId' w ciele zapytania.");
    res.status(400).send("Brak 'groupId'.");
    return;
  }

  const effectiveDate = simulationDate ? new Date(simulationDate) : new Date();

  console.log(`Rozpoczynam pracę dla grupy: ${groupId}, data efektywna: ${effectiveDate.toISOString().split("T")[0]}`);
  try {
    const ONE_WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

    const monday = new Date(effectiveDate);
    const day = monday.getDay();
    const diff = monday.getDate() - day + (day === 0 ? -6 : 1);

    monday.setDate(diff);
    monday.setHours(0, 0, 0, 0);
    const startTimestamp = monday.getTime();

    let totalClassesSaved = 0;
    let batch = db.batch();
    let batchCounter = 0;
    let emptyWeeksCounter = 0;
    const MAX_EMPTY_WEEKS = 3;

    for (let i = 0; i < weeksToScan; i++) {
      const weekTimestamp = startTimestamp + i * ONE_WEEK_IN_MS;
      const weekId = weekTimestamp.toString();
      const scheduleItems = await fetchScheduleForGroup(groupId, weekTimestamp);

      if (scheduleItems.length > 0) {
        emptyWeeksCounter = 0;

        const {batchOperationsCount: savedOps, changedClassesCount: changes} =
        await processAndUpdateBatch(scheduleItems, groupId, weekId, batch);
        totalClassesSaved += changes;
        batchCounter += savedOps;
      } else {
        emptyWeeksCounter++;
        if (emptyWeeksCounter >= MAX_EMPTY_WEEKS) {
          console.log(`Koniec planu dla grupy ${groupId}. Zatrzymuję.`);
          break;
        }
      }

      if (batchCounter >= 450) {
        await batch.commit();
        batch = db.batch();
        batchCounter = 0;
      }
    }

    if (batchCounter > 0) {
      await batch.commit();
    }

    console.log(`✅ Zakończono pracę dla grupy ${groupId} (skan ${weeksToScan} tyg.). Zapisano ${totalClassesSaved} zajęć.`);
    res.status(200).send(`OK: ${groupId}`);
    return;
  } catch (error) {
    console.error(`Błąd krytyczny podczas przetwarzania grupy ${groupId}:`, error);
    res.status(500).send("Błąd wewnętrzny");
    return;
  }
});
