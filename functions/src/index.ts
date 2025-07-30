import * as functions from "firebase-functions";
import * as scheduler from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import {loginToUniversity, getStudentGroup, fetchScheduleForGroup, getSemesterInfo} from "./utils/universityService";
import {ApiResponse, GroupTreeItem, ProcessingContext, RegisterStudentData, RootApiResponseItem} from "./types";
import axios, {isAxiosError} from "axios";
import {accessSecret, reloginAndStoreSession} from "./utils/secretManager";
import {AJAX_URL} from "./config/urls";
import {sendAdminNotification} from "./utils/helpers";
import {
  buildTreeForCollection,
  getAllGroupIdsForSemester,
  getScheduleForDay,
  getScheduleForWeek,
  processAndSaveBatch,
} from "./utils/firestore";
import {CloudTasksClient} from "@google-cloud/tasks";

// Inicjalizacja
admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();
const tasksClient = new CloudTasksClient();
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const PROJECT_ID = process.env.GCLOUD_PROJECT!;
const QUEUE_NAME = "schedule-update-queue";
const LOCATION = "europe-central2";

// const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


// --- GŁÓWNE FUNKCJE W CHMURZE ---

/**
 * Funkcja-cron, która odświeża sesję konta serwisowego.
 */

export const renewVerbisSession = scheduler.onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Europe/Warsaw",
    region: LOCATION,
  },
  async () => {
    try {
      const sessionCookie = await accessSecret("verbis-session-cookie");
      if (!sessionCookie || sessionCookie === "placeholder") {
        functions.logger.warn("Brak sesji do odnowienia. Próba automatycznego zalogowania...");
        await reloginAndStoreSession();
        return;
      }
      const payload = {
        service: "KeepSession",
        method: "ping",
        params: [],
      };

      const response = await axios.post(AJAX_URL, payload, {
        headers: {
          "Content-Type": "application/json",
          "Cookie": `JSESSIONID=${sessionCookie}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        },
      });

      // Sprawdzamy, czy sesja nie wygasła
      if (response.data.exceptionClass === "org.objectledge.web.mvc.security.LoginRequiredException") {
        functions.logger.warn("⚠️ Sesja konta serwisowego wygasła. Uruchamiam ponowne logowanie...");
        await reloginAndStoreSession();
      } else if (response.data.exceptionClass === null && response.data.returnedValue === null) {
        functions.logger.info("✅ Pomyślnie odnowiono sesję konta serwisowego.");
      } else {
        functions.logger.info("ANALIZA: 🤔 Otrzymano nieoczekiwaną odpowiedź. Sprawdź powyższe dane.");
        sendAdminNotification(
          "Nieoczekiwana odpowiedź podczas odświeżania sesji konta serwisowego",
          `Otrzymano nieoczekiwaną odpowiedź podczas odświeżania sesji konta serwisowego. Odpowiedź: ${JSON.stringify(response.data)}`
        );
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      functions.logger.error("⚠️ Nie udało się odnowić sesji, błąd sieciowy. Próba ponownego zalogowania...", errorMessage);
      try {
        await reloginAndStoreSession();
      } catch (reloginError: unknown) {
        const reloginErrorMessage = reloginError instanceof Error ? reloginError.message : String(reloginError);
        functions.logger.error("❌❌❌ KRYTYCZNY BŁĄD: Ponowne logowanie również się nie powiodło!", reloginErrorMessage);
        sendAdminNotification(
          "Błąd krytyczny podczas odświeżania sesji konta serwisowego",
          `Nie udało się odświeżyć sesji konta serwisowego. Błąd: ${reloginErrorMessage}`
        );
      }
    }
  });


/**
 * Rejestruje nowego studenta, używając sesji konta serwisowego.
 * Weryfikuje dane studenta w systemie uczelni.
 */
export const registerStudent = functions.https.onCall(
  {region: LOCATION, timeoutSeconds: 30},
  async (request: functions.https.CallableRequest<RegisterStudentData>) => {
    const {email, password, albumNumber, verbisPassword} = request.data;

    // Walidacja danych wejściowych
    if (!email || !password || !albumNumber || !verbisPassword) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Proszę podać wszystkie wymagane dane.",
      );
    }

    // ZMIANA 1: Sprawdzamy istnienie studenta w kolekcji 'student_lookups' (jest to szybsze i bardziej logiczne)
    const lookupDocRef = db.collection("student_lookups").doc(albumNumber);
    const lookupDoc = await lookupDocRef.get();
    if (lookupDoc.exists) {
      throw new functions.https.HttpsError(
        "already-exists",
        `Użytkownik z numerem albumu ${albumNumber} już istnieje.`,
      );
    }

    // Weryfikacja w systemie uczelni
    const loginData = await loginToUniversity(albumNumber, verbisPassword);
    const {fullName, verbisId, sessionCookie} = loginData;

    // Pobranie grupy dziekańskiej
    const groupName = await getStudentGroup(sessionCookie);
    if (!groupName || groupName === "Nie znaleziono") {
      throw new functions.https.HttpsError(
        "not-found",
        "Nie udało się pobrać grupy dziekańskiej.",
      );
    }

    let newUserUid: string | null = null;
    try {
      // Tworzenie konta w Firebase Auth
      const userRecord = await auth.createUser({
        email: email,
        password: password,
        displayName: fullName,
      });
      newUserUid = userRecord.uid;
      functions.logger.info(
        `✅ Pomyślnie utworzono konto Firebase. UID: ${newUserUid}`,
      );

      // ZMIANA 2: Używamy "batched write" do zapisu w obu kolekcjach na raz
      const batch = db.batch();

      // 1. Przygotowujemy zapis do kolekcji 'students' (dane prywatne)
      const studentDocRef = db.collection("students").doc(newUserUid);
      batch.set(studentDocRef, {
        uid: newUserUid,
        email: userRecord.email,
        albumNumber: albumNumber,
        displayName: fullName,
        deanGroupName: groupName,
        verbisId: verbisId,
        createdAt: new Date(),
        observedGroups: [], // Domyślnie pusta lista obserwowanych grup
        devices: [],
      });

      // 2. Przygotowujemy zapis do kolekcji 'student_lookups' (dane publiczne)
      // ID dokumentu to numer albumu, a w środku tylko email
      batch.set(lookupDocRef, {
        email: email,
      });

      // 3. Wykonujemy oba zapisy atomowo
      await batch.commit();

      return {
        status: "success",
        message: "Rejestracja zakończona pomyślnie!",
        uid: newUserUid,
      };
    } catch (error: unknown) {
      // Logika sprzątająca w razie błędu pozostaje bez zmian - jest bardzo dobra!
      if (newUserUid) {
        await auth.deleteUser(newUserUid);
        functions.logger.warn(
          `Usunięto osierocone konto Firebase Auth dla UID: ${newUserUid}`,
        );
      }
      functions.logger.error(
        "Błąd Firebase podczas tworzenia użytkownika:",
        error,
      );
      throw new functions.https.HttpsError(
        "internal",
        "Wystąpił wewnętrzny błąd serwera podczas tworzenia konta.",
      );
    }
  },
);


/**
 * Funkcja Firebase uruchamiana zgodnie z harmonogramem (1 października o 5:00 rano).
 * Pobiera strukturę grup z API uczelni i zapisuje ją w Firestore.
 */
export const updateDeanGroups = functions.scheduler.onSchedule({
  schedule: "0 5 1 10 *", // 1 października o 5:00 rano czasu warszawskiego
  timeZone: "Europe/Warsaw",
  region: LOCATION,
}, async () => {
  functions.logger.info("🚀 Rozpoczynam zadanie aktualizacji grup na nowy rok akademicki!");

  // --- Pomocnicza funkcja do scentralizowanej obsługi błędów ---
  const handleError = async (error: unknown, contextMessage: string) => {
    let errorMessage: string;
    let notificationDetail: string;

    if (isAxiosError(error)) {
      errorMessage = `❌ Błąd Axios podczas komunikacji z API: ${error.message}`;
      notificationDetail =
        `URL: ${error.config?.url}\nStatus: ${error.response?.status}\n` +
        `Data: ${JSON.stringify(error.response?.data, null, 2)}`;
      functions.logger.error(errorMessage, {
        message: error.message,
        url: error.config?.url,
        status: error.response?.status,
        data: error.response?.data,
      });
    } else if (error instanceof Error) {
      errorMessage = `❌ Wystąpił błąd podczas wykonywania funkcji: ${error.message}`;
      notificationDetail = `Szczegóły: ${JSON.stringify(error, null, 2)}`;
      functions.logger.error(errorMessage, error);
    } else {
      errorMessage = `❌ Wystąpił nieznany błąd: ${String(error)}`;
      notificationDetail = `Szczegóły: ${String(error)}`;
      functions.logger.error(errorMessage, error);
    }

    // WAŻNE: Wysyłanie powiadomienia do administratora przez Telegram
    await sendAdminNotification(
      `Błąd podczas aktualizacji grup dziekańskich: ${contextMessage}`,
      `${errorMessage}\n\n${notificationDetail}`
    );

    throw error;
  };

  try {
    const sessionCookie = await accessSecret("verbis-session-cookie");
    functions.logger.info("✅ Pomyślnie załadowano ciasteczko sesji.");

    // Ustawienie roku akademickiego
    const now = new Date();
    const currentMonth = now.getMonth(); // 0-11 (styczeń-grudzień)
    let academicYearStart = now.getFullYear();

    // Jeśli obecny miesiąc jest wcześniejszy niż październik (indeks 9), to rok akademicki zaczął się w zeszłym roku
    if (currentMonth < 9) {
      academicYearStart--;
    }
    const academicYear = `${academicYearStart}-${academicYearStart + 1}`;
    const winterSemesterId = 90 + (academicYearStart - 2025) * 2;

    functions.logger.info(`Przetwarzanie dla roku akademickiego: ${academicYear} (ID semestru zimowego: ${winterSemesterId})`);

    const headers = {
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/json",
      "Cookie": `JSESSIONID=${sessionCookie}`,
      "X-Requested-With": "XMLHttpRequest",
    };

    // --- Pobieranie początkowych danych (jednostek głównych/kierunków) ---
    const initialPayload = {
      service: "Planowanie",
      method: "getGrupySemestralneSemestru",
      params: {idSemestru: winterSemesterId, cyklRoczny: true, itemIdList: ["r0"]},
    };
    const initialResponse = await axios.post<ApiResponse>(AJAX_URL, initialPayload, {headers});
    const initialData = initialResponse.data;

    // Sprawdzanie, czy sesja wygasła
    if (initialData.exceptionClass?.includes("LoginRequiredException")) {
      functions.logger.warn("⚠️ Sesja wygasła. Próba ponownego zalogowania...");
      await reloginAndStoreSession();
      // Rzucamy nowy błąd, który zostanie przechwycony przez handleError.
      // handleError zajmie się logowaniem, wysłaniem powiadomienia i ponownym rzuceniem dla schedulera.
      throw new Error("Sesja wygasła, wymagane ponowne uruchomienie przez Scheduler.");
    }

    const rootItem = initialData.returnedValue?.items?.[0] as RootApiResponseItem;
    if (!rootItem || !rootItem.children || rootItem.children.length === 0) {
      functions.logger.warn("Nie znaleziono żadnych jednostek podrzędnych (kierunków). Zakończono zadanie.");
      return; // Zakończ funkcję, jeśli nie ma kierunków
    }

    const unitIds = rootItem.children.map((child) => child._reference);
    functions.logger.info(`Znaleziono ${unitIds.length} jednostek głównych (kierunków).`);

    // --- Pobieranie pełnego drzewa grup ---
    const finalPayload = {
      service: "Planowanie",
      method: "getGrupySemestralneSemestru",
      params: {idSemestru: winterSemesterId, cyklRoczny: true, itemIdList: unitIds},
    };

    const finalResponse = await axios.post<ApiResponse>(AJAX_URL, finalPayload, {headers});
    const finalData = finalResponse.data;

    const allItems = finalData.returnedValue?.items as GroupTreeItem[];
    if (!allItems) {
      throw new Error("Otrzymano pustą odpowiedź przy pobieraniu pełnego drzewa grup.");
    }

    functions.logger.info("Pomyślnie pobrano pełne drzewo grup. Rozpoczynanie przetwarzania...");

    const batch = db.batch();
    let groupsFoundCounter = 0;
    const processedPaths = new Set<string>(); // Set do przechowywania unikalnych ścieżek dokumentów

    // ===================================================================
    // === FUNKCJA REKURENCYJNA PRZETWARZAJĄCA WĘZŁY DRZEWA GRUP ===
    // ===================================================================
    const processNode = (node: GroupTreeItem, context: ProcessingContext) => {
      const newContext = {...context};

      if (node.type === "jednostka") {
        newContext.fieldOfStudy = node.label.trim();
      } else if (node.type === "rodzajetapu") {
        newContext.studyMode = node.label.trim();
      } else if (node.type === "cykl") {
        newContext.semester = node.label.trim();
      } else if (node.type === "grupadziekanska" && typeof node.id === "number") {
        const originalLabel = node.label; // Zachowujemy oryginalną etykietę do logów
        let groupName = node.label;

        // ✅ NOWA LOGIKA: Dynamiczne tworzenie identyfikatora semestru (np. 2024Z lub 2025L)
        let semesterIdentifier: string | null = null;
        const semesterMatch = groupName.match(/\s\(([ZL])\)$/); // Szukamy " (Z)" lub " (L)" na końcu etykiety

        if (semesterMatch) {
          const semesterType = semesterMatch[1]; // Wyciągamy "Z" lub "L"
          if (semesterType === "Z") {
            semesterIdentifier = `${academicYearStart}Z`;
          } else { // semesterType === "L"
            semesterIdentifier = `${academicYearStart + 1}L`;
          }
        }

        // Stara logika czyszczenia nazwy grupy pozostaje bez zmian
        if (groupName.includes(":")) {
          groupName = groupName.split(":")[0];
        }
        groupName = groupName.replace(/\s\([ZL]\)$/, "").trim();

        const {fieldOfStudy, studyMode, semester} = newContext;

        // Sprawdza, czy mamy wszystkie potrzebne informacje, WŁĄCZNIE z nowym identyfikatorem semestru
        if (fieldOfStudy && studyMode && semester && groupName && semesterIdentifier) {
          // Ścieżki do dokumentów, które mogą być "widmami"
          const yearDocPath = `deanGroups/${academicYear}`;
          const fieldOfStudyDocPath = `deanGroups/${academicYear}/${semesterIdentifier}/${fieldOfStudy}`;
          const semesterDocPath = `deanGroups/${academicYear}/${semesterIdentifier}/${fieldOfStudy}/${studyMode}/${semester}`;

          // "Ożywianie" dokumentów nadrzędnych
          // Upewniamy się, że dokument roku (np. 2024-2025) istnieje
          batch.set(db.doc(yearDocPath), {lastUpdated: new Date()}, {merge: true});
          // Upewniamy się, że dokument kierunku (np. IEZI) istnieje
          batch.set(db.doc(fieldOfStudyDocPath), {lastUpdated: new Date()}, {merge: true});

          // Tworzymy unikalny klucz dla KAŻDEJ GRUPY, aby uniknąć duplikatów
          const uniqueGroupKey = `${semesterDocPath}/${groupName}`;

          // Sprawdzamy, czy ta konkretna GRUPA nie została już przetworzona
          if (!processedPaths.has(uniqueGroupKey)) {
            processedPaths.add(uniqueGroupKey);
            groupsFoundCounter++; // Zwiększamy licznik dla każdej unikalnej grupy

            // Zapis musi być wykonywany dla każdej unikalnej grupy,
            // aby dodać jej pole do odpowiedniego dokumentu semestru.
            const docRef = db.doc(semesterDocPath);
            batch.set(docRef, {[groupName]: node.id}, {merge: true});
            // Zapis do kolekcji `groupDetails`
            const groupDetailsRef = db.collection("groupDetails").doc(String(node.id));
            batch.set(groupDetailsRef, {
              groupName: groupName,
              fullPath: semesterDocPath, // Zapisujemy ścieżkę jako dodatkową informację
            }, {merge: true});
          }
        } else {
          // Ostrzeżenie, jeśli brakuje danych LUB nie udało się zidentyfikować typu semestru (Z/L)
          functions.logger.warn(`Pominięto grupę '${originalLabel}', ponieważ brak pełnego kontekstu lub identyfikatora Z/L.`, {
            context: newContext,
            resolvedSemester: semesterIdentifier,
          });
        }
      }

      if (node.children) {
        for (const child of node.children) {
          processNode(child, newContext);
        }
      }
    };

    // Rozpocznij przetwarzanie dla każdego elementu z najwyższego poziomu drzewa grup
    for (const item of allItems) {
      processNode(item, {}); // Zaczynamy z pustym kontekstem dla każdego głównego kierunku
    }

    // Wykonaj wszystkie operacje zapisu w batche'u, jeśli znaleziono jakieś grupy
    if (groupsFoundCounter > 0) {
      await batch.commit();
      functions.logger.info(
        `✅ Zakończono sukcesem! Zapisano ${groupsFoundCounter} grup dla roku ${academicYear} w Firestore.`,
      );
    } else {
      functions.logger.warn(
        "Zakończono przetwarzanie, ale nie znaleziono żadnych grup dziekańskich (type: \"grupadziekanska\") " +
        `do zapisania dla roku ${academicYear}. Upewnij się, że struktura danych API jest zgodna.`,
      );
    }
  } catch (error) {
    // Przechwytujemy wszystkie błędy i przekazujemy je do scentralizowanej funkcji handleError.
    // handleError zajmie się logowaniem, wysłaniem powiadomienia Telegram i ponownym rzuceniem błędu,
    // aby Firebase wiedział, że funkcja zakończyła się niepowodzeniem.
    await handleError(error, "Wystąpił błąd ogólny podczas aktualizacji grup dziekańskich.");
  }
});

// =================================================================
// PLANOWANIE I PRZETWARZANIE ZAJĘĆ SEMESTRALNYCH
// =================================================================

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

  let totalClassesUpdated = 0;
  let batch = db.batch();
  let batchCounter = 0;

  for (const groupId of groupIds) {
    const scheduleItems = await fetchScheduleForGroup(groupId, weekStartTimestamp);
    if (scheduleItems.length > 0) {
      const groupDocRef = db.collection("schedules").doc(groupId.toString());
      batch.set(groupDocRef, {lastUpdated: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      batchCounter++;

      const savedCount = await processAndSaveBatch(scheduleItems, groupId, weekId, batch);
      totalClassesUpdated += savedCount;
      batchCounter += savedCount;
    }

    if (batchCounter >= 450) {
      await batch.commit();
      console.log(`Zapisano paczkę ${batchCounter} operacji.`);
      batch = db.batch();
      batchCounter = 0;
    }
  }

  // Zatwierdź ostatnią, niepełną paczkę
  if (batchCounter > 0) {
    await batch.commit();
  }

  console.log(`✅ Szybka aktualizacja zakończona. Zaktualizowano ${totalClassesUpdated} zajęć.`);
});

// =================================================================
// Przetwarzanie planu zajęć całego semestru w kolejce Cloud Tasks==
// =================================================================

// =================================================================
// === FUNKCJA 1: Dyspozytor (zleca zadania) =======================
// =================================================================

export const scheduleSemesterUpdates = scheduler.onSchedule({
  schedule: "every day 02:00", // Uruchamia się codziennie o 2 w nocy
  timeZone: "Europe/Warsaw",
  region: LOCATION,
  timeoutSeconds: 540,
  memory: "1GiB",
}, async () => {
  console.log("Rozpoczynanie zlecania zadań aktualizacji semestrów.");

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
    const task = {
      httpRequest: {
        httpMethod: "POST" as const,
        url: targetUri,
        headers: {"Content-Type": "application/json"},
        body: Buffer.from(JSON.stringify({groupId})).toString("base64"),
      },
    };
    return tasksClient.createTask({parent: queuePath, task});
  });

  await Promise.all(tasks);
  console.log(`✅ Zlecono ${tasks.length} zadań do kolejki '${QUEUE_NAME}'.`);
});

// =================================================================
// === FUNKCJA 2: Pracownik (wykonuje jedno zadanie) ===============
// =================================================================

export const processSingleSemesterUpdate = functions.https.onRequest({
  region: LOCATION,
  timeoutSeconds: 540,
  memory: "1GiB",
},
async (req, res) => {
  // ✅ ZMIANA: Odczytaj groupId oraz opcjonalną, symulowaną datę
  const {groupId, simulationDate} = req.body;

  if (!groupId) {
    console.error("Brak 'groupId' w ciele zapytania.");
    res.status(400).send("Brak 'groupId'.");
    return;
  }

  // Użyj daty symulowanej, jeśli została podana, w przeciwnym razie użyj bieżącej
  const effectiveDate = simulationDate ? new Date(simulationDate) : new Date();

  console.log(`Rozpoczynam pracę dla grupy: ${groupId}, data efektywna: ${effectiveDate.toISOString().split("T")[0]}`);
  try {
    const ONE_WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

    const monday = new Date(effectiveDate); // 1. Utwórz kopię daty
    const day = monday.getDay();
    const diff = monday.getDate() - day + (day === 0 ? -6 : 1);

    monday.setDate(diff); // 2. Modyfikuj kopię, a nie oryginał
    monday.setHours(0, 0, 0, 0);
    const startTimestamp = monday.getTime();

    let totalClassesSaved = 0;
    let batch = db.batch();
    let batchCounter = 0;
    let emptyWeeksCounter = 0;
    const MAX_EMPTY_WEEKS = 3;

    for (let i = 0; i < 25; i++) {
      const weekTimestamp = startTimestamp + i * ONE_WEEK_IN_MS;
      const weekId = weekTimestamp.toString();
      const scheduleItems = await fetchScheduleForGroup(groupId, weekTimestamp);

      if (scheduleItems.length > 0) {
        emptyWeeksCounter = 0;
        const savedCount = await processAndSaveBatch(scheduleItems, groupId, weekId, batch);
        totalClassesSaved += savedCount;
        batchCounter += savedCount;
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

    console.log(`✅ Zakończono pracę dla grupy ${groupId}. Zapisano ${totalClassesSaved} zajęć.`);
    res.status(200).send(`OK: ${groupId}`);
    return;
  } catch (error) {
    console.error(`Błąd krytyczny podczas przetwarzania grupy ${groupId}:`, error);
    res.status(500).send("Błąd wewnętrzny");
    return;
  }
});


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


export const getGroupDetails = functions.https.onCall({
  region: LOCATION,
}, async (request) => {
  const groupIds = request.data.groupIds;

  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    throw new functions.https.HttpsError("invalid-argument", "Oczekiwano tablicy 'groupIds'.");
  }

  try {
    const promises = groupIds.map((id) => db.collection("groupDetails").doc(String(id)).get());
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
    const deanGroupsRef = db.collection("deanGroups");
    const groupTree = await buildTreeForCollection(deanGroupsRef);
    return {tree: groupTree};
  } catch (error) {
    console.error("Błąd podczas budowania drzewa grup:", error);
    throw new functions.https.HttpsError("internal", "Błąd serwera przy budowaniu drzewa grup.");
  }
});
