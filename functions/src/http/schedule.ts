import {LOCATION} from "../config/firebase/settings";
import * as functions from "firebase-functions";
import {getScheduleForDay, getScheduleForWeek} from "../utils/firestore";

/**
 * Funkcja wywoływalna do pobierania planu na dany dzień.
 */
export const getDailySchedule = functions.https.onCall({
  region: LOCATION,
},
async (request: functions.https.CallableRequest<{ groupId: number; dateString: string }>) => {
  // Walidacja danych wejściowych
  const groupId = request.data.groupId;
  const dateString = request.data.dateString;

  if (typeof groupId !== "number" || typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Żądanie musi zawierać poprawne 'groupId' (number) oraz 'dateString' (YYYY-MM-DD)."
    );
  }

  try {
    // Wywołanie naszej funkcji pomocniczej z przekazanymi parametrami
    const schedule = await getScheduleForDay(groupId, dateString);

    // Zwrócenie wyniku do aplikacji
    return {schedule: schedule};
  } catch (error) {
    console.error("Błąd podczas pobierania planu dnia:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Wystąpił nieoczekiwany błąd serwera."
    );
  }
});

/**
 * Funkcja wywoływalna do pobierania planu na cały tydzień.
 */
export const getWeeklySchedule = functions.https.onCall({
  region: LOCATION,
},
async (request: functions.https.CallableRequest<{ groupId: number; weekId: string }>) => {
  const {groupId, weekId} = request.data;

  // Walidacja danych wejściowych
  if (typeof groupId !== "number" || typeof weekId !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Żądanie musi zawierać poprawne 'groupId' (number) oraz 'weekId' (string)."
    );
  }

  try {
    const schedule = await getScheduleForWeek(groupId, weekId);
    return {schedule: schedule};
  } catch (error) {
    console.error(`Błąd podczas pobierania planu tygodnia dla grupy ${groupId}:`, error);
    throw new functions.https.HttpsError(
      "internal",
      "Wystąpił nieoczekiwany błąd serwera."
    );
  }
});
