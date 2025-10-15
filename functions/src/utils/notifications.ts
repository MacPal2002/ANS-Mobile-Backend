import * as admin from "firebase-admin";
import {db} from "./admin";
import {getSemesterInfo} from "./universityService";
import {TokenInfo} from "../types";
import {NOTIFICATION_WINDOWS} from "../config/notification";
import {cleanupInvalidTokens} from "./firestore";

/**
 * Główna funkcja do przetwarzania i wysyłania powiadomień o nadchodzących zajęciach.
 * Uruchamiana co 5 minut przez Cloud Scheduler.
 * @param {Date} now Obecny czas, używany do określenia nadchodzących zajęć.
 */
export async function processAndSendNotifications(now: Date) {
  const semesterInfo = getSemesterInfo(now);
  if (!semesterInfo) {
    console.log(`Sprawdzono ${now.toISOString()}: Okres wakacyjny. Zatrzymuję funkcję wysyłania powiadomień.`);
    return; // Zakończ działanie funkcji
  }
  console.log(`Funkcja wysyłania powiadomień uruchomiona o: ${now.toISOString()}`);


  // Pobierz wszystkie zajęcia, które mają się zacząć w ciągu najbliższych 2 godzin
  const twoHoursFromNow = new Date(now.getTime() + 120 * 60 * 1000);
  const upcomingClassesQuery = db.collectionGroup("classes")
    .where("startTime", ">=", now)
    .where("startTime", "<=", twoHoursFromNow);

  const classesSnapshot = await upcomingClassesQuery.get();
  if (classesSnapshot.empty) {
    console.log("Brak nadchodzących zajęć w ciągu najbliższych 2 godzin.");
    return;
  }

  // Przetwarzamy każde nadchodzące zajęcia
  for (const classDoc of classesSnapshot.docs) {
    const classData = classDoc.data();
    const startTime = (classData.startTime as admin.firestore.Timestamp).toDate();
    const groupId = classData.sourceGroupId;

    // Oblicz, ile minut pozostało do rozpoczęcia zajęć
    const minutesUntilStart = Math.round((startTime.getTime() - now.getTime()) / 60000);

    // Znajdź studentów obserwujących tę grupę
    const observedGroupsQuery = db.collection("student_observed_groups")
      .where("groups", "array-contains", groupId);
    const observedGroupsSnapshot = await observedGroupsQuery.get();

    if (observedGroupsSnapshot.empty) {
      continue; // Nikt nie obserwuje tej grupy, przejdź do następnych zajęć
    }

    const tokensToNotify: TokenInfo[] = [];
    const studentIds = observedGroupsSnapshot.docs.map((doc) => doc.id);

    // Pobierz dane studentów
    const studentDevicesSnapshot = await db.collection("student_devices")
      .where(admin.firestore.FieldPath.documentId(), "in", studentIds)
      .get();

    if (studentDevicesSnapshot.empty) {
      continue; // Brak danych studentów, przejdź do następnych zajęć
    }
    // Sprawdź ustawienia każdego studenta
    for (const deviceDoc of studentDevicesSnapshot.docs) {
      const deviceData = deviceDoc.data();
      const devices = deviceData.devices || {};

      for (const deviceId of Object.keys(devices)) {
        const device = devices[deviceId];
        const preferredMinutes = NOTIFICATION_WINDOWS[device.notificationTimeOption];

        // Sprawdź, czy ustawienia powiadomień pasują
        if (
          device.notificationEnabled === true &&
          preferredMinutes &&
          minutesUntilStart <= preferredMinutes &&
          minutesUntilStart > preferredMinutes - 5 // Okno 5 minut, aby uniknąć duplikatów
        ) {
          if (device.token) {
            tokensToNotify.push({
              token: device.token,
              userId: deviceDoc.id,
              deviceId: deviceId,
            });
          }
        }
      }
    }

    // Jeśli mamy tokeny do powiadomienia, wyślij wiadomość
    if (tokensToNotify.length > 0) {
      const message = {
        notification: {
          title: "Nadchodzące zajęcia",
          // eslint-disable-next-line max-len
          body: `${classData.subjectFullName} o ${startTime.toLocaleTimeString("pl-PL", {hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw"})} w sali ${classData.rooms[0]?.name || "N/A"}.`,
        },
        android: {
          priority: "high" as const,
        },
        data: {
          "classId": classDoc.id,
        },
        ttl: 60 * 5 * 1000,
        tokens: tokensToNotify.map((info) => info.token),
      };

      console.log(`Wysyłanie powiadomienia do ${tokensToNotify.length} urządzeń dla grupy ${groupId}.`);
      const response = await admin.messaging().sendEachForMulticast(message);
      await cleanupInvalidTokens(response, tokensToNotify);
    }
  }
  return;
}
