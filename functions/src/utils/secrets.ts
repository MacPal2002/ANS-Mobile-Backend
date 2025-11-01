import {loginToUniversity} from "./universityService";
import {getSessionFromFirestore, saveSessionToFirestore} from "./firestore";
import {telegramBotToken, telegramChatId, testKey, verbisLogin, verbisPassword} from "./env";

// --- CENTRALNY CACHE W PAMIĘCI ---
// Używamy Mapy, aby cache'ować dowolny sekret
const secretCache = new Map<string, string>();
// ---------------------------------

// --- ZAMEK GLOBALNY (dotyczy jednej instancji Cloud Function) ---
let isReloggingIn = false;

/**
 * Loguje się, zapisuje nową sesję w cache ORAZ w Secret Managerze.
 */
export async function reloginAndStoreSession(): Promise<string> {
  const login = verbisLogin.value();
  const password = verbisPassword.value();
  console.log("Sesja wygasła. Logowanie ponowne...");
  const loginData = await loginToUniversity(login, password);
  const newCookie = loginData?.sessionCookie;

  if (!newCookie) throw new Error("Nie udało się uzyskać ciasteczka sesji.");

  // Cache w pamięci
  secretCache.set("verbis-session-cookie", newCookie);

  // Zapis w Firestore
  await saveSessionToFirestore(newCookie);

  return newCookie;
}


/**
 * Pobiera aktywny i ważny plik cookie sesji.
 * Obsługuje cache'owanie, ponowne logowanie i mechanizm blokady, aby zapobiec wielokrotnemu logowaniu.
 */
export async function getValidSessionCookie(): Promise<string> {
  while (isReloggingIn) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const cachedCookie = secretCache.get("verbis-session-cookie");
  if (cachedCookie) return cachedCookie;

  const storedCookie = await getSessionFromFirestore().catch(() => null);
  if (storedCookie) {
    secretCache.set("verbis-session-cookie", storedCookie);
    return storedCookie;
  }

  try {
    isReloggingIn = true;
    return await reloginAndStoreSession();
  } finally {
    isReloggingIn = false;
  }
}

/**
 * Pobiera token bota Telegrama z konfiguracji Functions (functions.config().telegram.bot_token).
 * @return {string} Token bota Telegrama.
 */
export function getTelegramBotToken(): string {
  return telegramBotToken.value();
}

/**
 * Pobiera identyfikator czatu Telegrama z konfiguracji Functions (functions.config().telegram.chat_id).
 * @return {string} ID czatu Telegrama.
 */
export function getTelegramChatId(): string {
  return telegramChatId.value();
}

/**
 * Pobiera klucz testowy z konfiguracji Functions (functions.config().test.key).
 * @return {string} Klucz testowy.
 */
export function getSecretTestKey(): string {
  return testKey.value();
}
