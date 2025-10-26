import {LOCATION} from "../config/firebase/settings";
import * as scheduler from "firebase-functions/v2/scheduler";
import * as functions from "firebase-functions";
import {processAndSendNotifications} from "../utils/notifications";
import {getSecretTestKey} from "../utils/secretManager";

// =================================================================
// Funkcja do wysyłania powiadomień o nadchodzących zajęciach
// =================================================================

export const sendUpcomingClassNotifications = scheduler.onSchedule({
  schedule: "*/5 7-22 * * *",
  timeZone: "Europe/Warsaw",
  region: LOCATION,
  timeoutSeconds: 240,
  memory: "256MiB",
}, async () => {
  await processAndSendNotifications(new Date());
});

export const testUpcomingClassNotifications = functions.https.onRequest({
  region: LOCATION,
},
async (req, res) => {
  if (req.headers["x-secret-key"] !== await getSecretTestKey()) {
    res.status(401).send("Brak autoryzacji.");
    return;
  }
  // Odczytaj datę z requestu lub użyj bieżącej
  const {dateString} = req.body;
  const now = dateString ? new Date(dateString) : new Date();

  // Wywołaj tę samą logikę z podaną datą
  await processAndSendNotifications(now);
  res.status(200).send(`Funkcja testowa wykonana dla daty: ${now.toISOString()}`);
});

