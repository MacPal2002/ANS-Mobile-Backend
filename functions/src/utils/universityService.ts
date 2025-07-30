import * as functions from "firebase-functions";
import axios, {isAxiosError} from "axios";
import {JSDOM} from "jsdom";
import {AJAX_URL, LOGIN_URL, PERSONAL_DATA_TAB_URL, PROFILE_URL} from "../config/urls";
import {accessSecret, reloginAndStoreSession} from "./secretManager";
import {sendAdminNotification} from "./helpers";

// =================================================================
// Funkcje do komunikacji z systemem uczelni =======================
// =================================================================


/**
 * Loguje się do systemu uczelni, aby zweryfikować dane.
 * @param {string} albumNumber Numer albumu studenta.
 * @param {string} verbisPassword Hasło jednorazowe do systemu Verbis.
 * @return {Promise<object|null>} Obiekt z danymi sesji lub null.
 */
export async function loginToUniversity(
  albumNumber: string,
  verbisPassword: string,
): Promise<{
    sessionCookie: string;
    fullName: string;
    verbisId: string;
  }> {
  functions.logger.info(
    `🔐 Weryfikacja konta w systemie uczelni dla albumu: ${albumNumber}...`,
  );
  const body = new URLSearchParams({
    login: albumNumber,
    password: verbisPassword,
  }).toString();

  try {
    const response = await axios.post(LOGIN_URL, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
      },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const cookies = response.headers["set-cookie"];
    if (!cookies || !cookies.some((c: string) => c.includes("JSESSIONID"))) {
      throw new Error("Logowanie pozornie udane, ale brak ciasteczka sesji.");
    }

    const sessionMatch = cookies
      .find((c: string) => c.startsWith("JSESSIONID="))
      ?.match(/JSESSIONID=([^;]+)/);
    const sessionCookie = sessionMatch?.[1] ?? null;
    if (!sessionCookie) {
      throw new Error("Nie udało się wyodrębnić JSESSIONID.");
    }

    const mainPageResponse = await axios.get(PROFILE_URL, {
      headers: {Cookie: `JSESSIONID=${sessionCookie}`},
    });
    const html = mainPageResponse.data as string;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const userMatch = doc.querySelector(
      "#vdo-uzytkownik > span:last-of-type",
    )?.textContent;
    const studentIdMatch = html.match(/idosoby=(\d+)/);

    if (!userMatch) {
      throw new Error("Nie znaleziono danych użytkownika po zalogowaniu.");
    }

    const fullName = userMatch.trim();
    const verbisId = studentIdMatch?.[1] ?? "Nie znaleziono";

    functions.logger.info(
      `✅ Weryfikacja pomyślna! Użytkownik: ${fullName}`,
    );
    return {sessionCookie, fullName, verbisId};
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "response" in error &&
      typeof (error as { response?: { data?: string } }).response?.data === "string" &&
      ((error as { response?: { data?: string } }).response?.data ?? "").includes("Podane hasło jest nieprawidłowe")
    ) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Weryfikacja nie powiodła się: podane hasło jest nieprawidłowe.",
      );
    }
    functions.logger.error("❌ Błąd podczas weryfikacji:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Wystąpił błąd podczas komunikacji z serwerem uczelni.",
    );
  }
}

/**
 * Pobiera nazwę grupy dziekańskiej studenta.
 * @param {string} sessionCookie Aktywne ciasteczko JSESSIONID.
 * @return {Promise<string>} Nazwa grupy dziekańskiej.
 */
export async function getStudentGroup(sessionCookie: string): Promise<string> {
  functions.logger.info("ℹ️  Pobieranie grupy dziekańskiej...");
  const headers = {
    "Cookie": `JSESSIONID=${sessionCookie}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  };
  try {
    const response = await axios.get(PERSONAL_DATA_TAB_URL, {headers});
    const tabHtml = response.data as string;
    const dom = new JSDOM(tabHtml);
    const tabDoc = dom.window.document;

    const dataFields = tabDoc.querySelectorAll("div.jednostka-info.data > div");
    for (let i = 0; i < dataFields.length; i++) {
      if (dataFields[i].textContent?.trim() === "Grupa dziekańska:") {
        const groupName =
          dataFields[i + 1]?.textContent?.trim() ?? "Nie znaleziono";
        functions.logger.info(`✅ Pomyślnie pobrano grupę: ${groupName}`);
        return groupName;
      }
    }
    return "Nie znaleziono grupy";
  } catch (e: unknown) {
    functions.logger.error("Błąd podczas pobierania grupy studenta:", e);
    throw new functions.https.HttpsError(
      "internal", "Błąd pobierania grupy.",
    );
  }
}


/**
 * Pobiera plan zajęć dla danej grupy dziekańskiej na podstawie ID grupy i znacznika czasu początku tygodnia.
 * @param {number} groupId ID grupy dziekańskiej.
 * @param {number} weekStartTimestamp Znacznik czasu początku tygodnia (w milisekundach).
 * @return {Promise<any[]>} Lista terminów zajęć.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fetchScheduleForGroup = async (groupId: number, weekStartTimestamp: number): Promise<any[]> => {
  // Pobierz najnowsze ciasteczko na początku każdego wywołania
  const sessionCookie = await accessSecret("verbis-session-cookie");
  const headers = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json",
    "Cookie": `JSESSIONID=${sessionCookie}`,
    "X-Requested-With": "XMLHttpRequest",
  };

  const payload = {
    service: "Planowanie",
    method: "getUlozoneTerminyGrupy",
    params: {
      idGrupyDziekanskiej: groupId,
      poczatekTygodnia: weekStartTimestamp,
    },
  };

  try {
    const response = await axios.post(AJAX_URL, payload, {headers});

    // ✅ ZMIANA: Sprawdzanie błędu sesji
    if (response.data?.exceptionClass?.includes("LoginRequiredException")) {
      console.warn(`⚠️ Sesja wygasła dla grupy ${groupId}. Próba ponownego zalogowania i restart funkcji...`);
      await reloginAndStoreSession();
      // Rzuć błąd, aby Firebase ponowiło całe zadanie CRON
      throw new Error("Sesja wygasła, wymagane ponowne uruchomienie przez Scheduler.");
    }

    return response.data?.returnedValue?.items || [];
  } catch (error) {
    // Sprawdź, czy to błąd sieciowy wskazujący na blokadę
    if (isAxiosError(error) && (
      error.code === "ECONNRESET" || // Zerwano połączenie
        error.response?.status === 403 || // Dostęp zabroniony
        error.response?.status === 429 // Zbyt wiele zapytań
    )) {
      console.error(`Prawdopodobna blokada IP przy grupie ${groupId}. Przerywam i czekam na ponowienie.`, error.message);
      sendAdminNotification(
        `Prawdopodobna blokada IP przy grupie ${groupId}. Przerywam i czekam na ponowienie.`,
        "Błąd pobierania planu",
      );
      // Rzuć błąd, aby cała funkcja Cloud Function zakończyła się niepowodzeniem
      throw new Error(`Server block or connection reset detected: ${error.message}`);
    }

    // Inne, mniej krytyczne błędy tylko logujemy i kontynuujemy
    console.error(`Wystąpił inny błąd podczas pobierania planu dla grupy ${groupId}:`, error);
    sendAdminNotification(
      `Wystąpił inny błąd podczas pobierania planu dla grupy ${groupId}: ${error}`,
      "Błąd pobierania planu",
    );
    return []; // Zwróć pustą tablicę, aby nie przerywać dla np. błędu 500
  }
};


/**
 * Zwraca informacje o bieżącym semestrze akademickim na podstawie podanej daty.
 * @param {Date} date - Data, dla której należy określić semestr (domyślnie dzisiaj).
 * @return {{identifier: string, academicYear: string} | null} Obiekt z identyfikatorem
 * (np. "2024Z", "2025L") i rokiem akademickim, lub null jeśli jest przerwa wakacyjna.
 */
export const getSemesterInfo = (date: Date = new Date()) => {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-11 (Styczeń-Grudzień)
  const day = date.getDate();

  // Semestr ZIMOWY (październik - luty)
  // Obejmuje: październik, listopad, grudzień, styczeń, oraz pierwszą połowę lutego
  if (
    month >= 9 || // Październik, Listopad, Grudzień
    month === 0 || // Styczeń
    (month === 1 && day < 15) // Luty przed 15-tym
  ) {
    // Jeśli jesteśmy w styczniu/lutym, rok akademicki zaczął się w zeszłym roku
    const academicYearStart = (month <= 1) ? year - 1 : year;
    return {
      identifier: `${academicYearStart}Z`,
      academicYear: `${academicYearStart}-${academicYearStart + 1}`,
    };
  }

  // Semestr LETNI (luty - czerwiec)
  // Obejmuje: drugą połowę lutego, marzec, kwiecień, maj, czerwiec
  if (
    (month === 1 && day >= 15) || // Luty od 15-tego
    (month >= 2 && month <= 5) // Marzec, Kwiecień, Maj, Czerwiec
  ) {
    return {
      identifier: `${year}L`,
      academicYear: `${year - 1}-${year}`,
    };
  }

  // Przerwa wakacyjna (lipiec, sierpień, wrzesień)
  return null;
};
