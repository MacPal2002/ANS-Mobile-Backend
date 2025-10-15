import {LOCATION} from "../config/firebase/settings";
import * as functions from "firebase-functions";
import {accessSecret} from "../utils/secretManager";
import {processAndSendNotifications} from "../utils/notifications";

// =================================================================
// Funkcja do wysyłania powiadomień o nadchodzących zajęciach
// =================================================================

export const sendUpcomingClassNotifications = functions.scheduler.onSchedule({
  schedule: "*/5 * * * *",
  timeZone: "Europe/Warsaw",
  region: LOCATION,
}, async () => {
  await processAndSendNotifications(new Date());
});

export const testUpcomingClassNotifications = functions.https.onRequest({
  region: LOCATION,
},
async (req, res) => {
  // Sprawdź sekretny klucz w nagłówku
  if (req.headers["x-secret-key"] !== await accessSecret("test-secret-key")) {
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

