import {loginToUniversity} from "./universityService";
import * as functions from "firebase-functions";
import {SecretManagerServiceClient} from "@google-cloud/secret-manager";

const secretManager = new SecretManagerServiceClient();

// --- CENTRALNY CACHE W PAMIĘCI ---
// Używamy Mapy, aby cache'ować dowolny sekret
const secretCache = new Map<string, string>();
// ---------------------------------

// --- ZAMEK GLOBALNY ---
// Ta zmienna jest kluczowa. Jest współdzielona między wszystkimi wywołaniami
// w jednej instancji Cloud Function.
let isReloggingIn = false;

/**
 * Pobiera ID projektu.
 * @return {string} ID projektu Google Cloud.
 */
function getProjectId(): string {
  const projectId = process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error("Nie można odnaleźć ID projektu Google Cloud.");
  }
  return projectId;
}

/**
 * Generyczna funkcja do pobierania i cache'owania *dowolnego* sekretu.
 * @param {string} name Nazwa sekretu do pobrania.
 */
async function getAndCacheSecret(name: string): Promise<string> {
  // 1. Sprawdź cache
  const cachedValue = secretCache.get(name);
  if (cachedValue) {
    return cachedValue;
  }

  // 2. Cache pusty, pobierz z Secret Managera
  functions.logger.warn(`CACHE MISS: Pobieram sekret [${name}] z Secret Managera.`);
  const secretPath = `projects/${getProjectId()}/secrets/${name}/versions/latest`;
  try {
    const [version] = await secretManager.accessSecretVersion({name: secretPath});
    const secretValue = version.payload?.data?.toString().trim() ?? "";

    if (!secretValue) {
      throw new Error(`Sekret [${name}] jest pusty.`);
    }

    // 3. Zapisz do cache'a na przyszłość
    secretCache.set(name, secretValue);
    return secretValue;
  } catch (error) {
    functions.logger.error(`Krytyczny błąd pobierania sekretu [${name}]:`, error);
    throw new Error(`Nie udało się pobrać ${name}`);
  }
}

/**
 * Prywatna funkcja do zapisu sekretu DO MANAGERA.
 * @param {string} name Nazwa sekretu do zapisu.
 * @param {string} value Wartość sekretu do zapisania.
 * (Tylko dla sesji, więc zostaje specyficzna)
 */
async function updateSecretInManager(name: string, value: string): Promise<void> {
  const secretPath = `projects/${getProjectId()}/secrets/${name}`;
  await secretManager.addSecretVersion({
    parent: secretPath,
    payload: {data: Buffer.from(value, "utf8")},
  });
  functions.logger.info(`✅ Pomyślnie zaktualizowano sekret [${name}] w Secret Managerze.`);
}

/**
 * Loguje się, zapisuje nową sesję w cache ORAZ w Secret Managerze.
 */
export async function reloginAndStoreSession(): Promise<string> {
  functions.logger.info("🔄 Inicjowanie procesu ponownego logowania...");

  try {
    // Używamy nowej, generycznej funkcji
    const login = await getAndCacheSecret("verbis-login");
    const password = await getAndCacheSecret("verbis-password");

    if (!login || !password) {
      functions.logger.error(
        "Krytyczny błąd: Nie udało się załadować loginu lub hasła. " +
        "Sprawdź, czy sekrety 'verbis-login' i 'verbis-password' istnieją."
      );
      throw new Error("Brak danych logowania do ponownego zalogowania.");
    }

    const loginData = await loginToUniversity(login, password);
    const newCookie = loginData?.sessionCookie;

    if (!newCookie) {
      throw new Error("Nie udało się uzyskać ciasteczka sesji podczas ponownego logowania.");
    }

    // Zapisz nową sesję w obu miejscach:
    // 1. W cache'u (używamy tej samej Mapy)
    secretCache.set("verbis-session-cookie", newCookie);
    functions.logger.info("Zapisano nową sesję w cache'u.");

    // 2. W Secret Managerze
    updateSecretInManager("verbis-session-cookie", newCookie).catch((err) => {
      functions.logger.error("Błąd zapisu sesji do Secret Managera w tle:", err);
    });

    return newCookie;
  } catch (error) {
    functions.logger.error("❌ Błąd krytyczny podczas reloginAndStoreSession:", error);
    throw error;
  }
}


/**
 * Pobiera aktywny i ważny plik cookie sesji.
 * Obsługuje cache'owanie, ponowne logowanie i mechanizm blokady, aby zapobiec wielokrotnemu logowaniu.
 */
export async function getValidSessionCookie(): Promise<string> {
  // 1. ZAWSZE SPRAWDŹ ZAMEK
  while (isReloggingIn) {
    functions.logger.info("Czekam na zwolnienie zamka ponownego logowania...");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // 2. SPRAWDŹ CACHE (BEZ PINGA)
  const cachedCookie = secretCache.get("verbis-session-cookie");
  if (cachedCookie) {
    return cachedCookie; // Zwróć "na ślepo"
  }

  // 3. SPRAWDŹ SECRET MANAGER (BEZ PINGA)
  try {
    const storedCookie = await getAndCacheSecret("verbis-session-cookie");
    if (storedCookie) {
      return storedCookie; // Zwróć "na ślepo"
    }
  } catch (error) {
    functions.logger.warn("Nie znaleziono sesji w Secret Managerze, przechodzę do logowania.");
    // Błąd jest oczekiwany, jeśli sekret nie istnieje, idziemy dalej
  }

  // === KROK 4: BRAKUJĄCY FRAGMENT (NAJWAŻNIEJSZY) ===
  // Sesji nie ma ani w cache, ani w managerze. Trzeba się zalogować.
  try {
    isReloggingIn = true; // <-- ZAŁÓŻ ZAMEK

    functions.logger.warn("Brak sesji, rozpoczynam ponowne logowanie...");

    // reloginAndStoreSession zaloguje się I zapisze cookie w cache
    return await reloginAndStoreSession();
  } catch (error) {
    functions.logger.error("KRYTYCZNE: Nie udało się ponownie zalogować podczas getValidSessionCookie!", error);
    // Rzuć błąd, aby funkcja nadrzędna (np. Pracownik) wiedziała, że ma spróbować ponownie
    throw new Error("Nie można uzyskać sesji konta serwisowego.");
  } finally {
    isReloggingIn = false; // <-- ZAWSZE ZDEJMIJ ZAMEK
  }
}

/**
 * Pobiera (i cache'uje) token bota Telegrama.
 */
export async function getTelegramBotToken(): Promise<string> {
  return getAndCacheSecret("telegram-bot-token");
}

/**
 * Pobiera (i cache'uje) ID chatu Telegrama.
 */
export async function getTelegramChatId(): Promise<string> {
  return getAndCacheSecret("telegram-chat-id");
}
/**
 * Pobiera (i cache'uje) sekret testowy.
 */
export async function getSecretTestKey(): Promise<string> {
  return getAndCacheSecret("test-secret-key");
}
