import * as functions from "firebase-functions";
import axios, {isAxiosError} from "axios";
import {LOCATION} from "../config/firebase/settings";
import {sendAdminNotification} from "../utils/helpers";
import {accessSecret, reloginAndStoreSession} from "../utils/secretManager";
import {ApiResponse, GroupTreeItem, ProcessingContext, RootApiResponseItem} from "../types";
import {AJAX_URL} from "../config/urls";
import {db} from "../utils/admin";
import {COLLECTIONS} from "../config/firebase/collections";


/**
 * Funkcja Firebase uruchamiana zgodnie z harmonogramem (1 października o 5:00 rano).
 * Pobiera strukturę grup z API uczelni i zapisuje ją w Firestore.
 */
export const updateDeanGroups = functions.scheduler.onSchedule({
  schedule: "0 1 1 10 *", // 1 października o 1:00 rano czasu warszawskiego
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
          const yearDocPath = `${COLLECTIONS.DEAN_GROUPS}/${academicYear}`;
          const fieldOfStudyDocPath = `${COLLECTIONS.DEAN_GROUPS}/${academicYear}/${semesterIdentifier}/${fieldOfStudy}`;
          // eslint-disable-next-line max-len
          const semesterDocPath = `${COLLECTIONS.DEAN_GROUPS}/${academicYear}/${semesterIdentifier}/${fieldOfStudy}/${studyMode}/${semester}`;

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
            // Zapis do kolekcji `group_details`
            const groupDetailsRef = db.collection(COLLECTIONS.GROUP_DETAILS).doc(String(node.id));
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
