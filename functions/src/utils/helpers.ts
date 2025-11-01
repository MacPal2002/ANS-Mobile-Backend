/* eslint-disable @typescript-eslint/no-explicit-any */
import * as functions from "firebase-functions";
import axios, {isAxiosError} from "axios";
import {getTelegramBotToken, getTelegramChatId, reloginAndStoreSession} from "./secrets";
import * as crypto from "crypto";

/**
 * Wysyła powiadomienie do administratora o błędzie krytycznym na Telegrama.
 * @param {string} title Tytuł powiadomienia.
 * @param {string} message Treść wiadomości.
 */
export async function sendAdminNotification(title: string, message: string): Promise<void> {
  try {
    const botToken = await getTelegramBotToken();
    const chatId = await getTelegramChatId();
    // ------------------------

    if (!botToken || !chatId) {
      functions.logger.error("Brak tokenu bota lub chat ID.");
      return;
    }

    const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const text = `🚨 *ALERT APLIKACJI* 🚨\n\n*${title}*\n\n\`\`\`\n${message}\n\`\`\``;

    await axios.post(telegramApiUrl, {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
    });

    functions.logger.info("✅ Pomyślnie wysłano powiadomienie na Telegrama.");
  } catch (error) {
    functions.logger.error(
      "❌ Błąd krytyczny podczas WYSYŁANIA powiadomienia na Telegrama:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Funkcja pomocnicza do zwięzłego wyświetlania wartości w logach.
 * @param {unknown} value Wartość do sformatowania jako string.
 * @param {number} [maxLength=70] Maksymalna długość zwracanego stringa.
 * @return {string} Sformatowana wartość jako string, skrócona jeśli przekracza maxLength.
 */
export const formatValueForLog = (value: unknown, maxLength = 70): string => {
  try {
    const str = JSON.stringify(value);
    if (str.length > maxLength) {
      return str.substring(0, maxLength - 3) + "... (Skrócono)";
    }
    return str;
  } catch {
    return String(value);
  }
};


export const handleError = async (error: unknown, contextMessage: string) => {
  let errorMessage: string;
  let notificationDetail: string;

  if (isAxiosError(error)) {
    errorMessage = `❌ Błąd Axios podczas komunikacji z API: ${error.message}`;
    notificationDetail =
      `URL: ${error.config?.url}\nStatus: ${error.response?.status}\n` +
      `Data: ${JSON.stringify(error.response?.data, null, 2)}`;
    functions.logger.error(errorMessage, {
      url: error.config?.url,
      status: error.response?.status,
      responseData: error.response?.data,
    });
  } else if (error instanceof Error) {
    errorMessage = `❌ Wystąpił błąd: ${error.message}`;
    notificationDetail = `Szczegóły: ${JSON.stringify(error, null, 2)}`;
    functions.logger.error(errorMessage, error);
  } else {
    errorMessage = `❌ Nieznany błąd: ${String(error)}`;
    notificationDetail = `Szczegóły: ${String(error)}`;
    functions.logger.error(errorMessage, error);
  }
  await sendAdminNotification(
    `Błąd podczas aktualizacji grup dziekańskich: ${contextMessage}`,
    `${errorMessage}\n\n${notificationDetail}`
  );
  throw error;
};


/**
 * Waliduje odpowiedź z API. Rzuca błąd, jeśli sesja wygasła lub wystąpił inny błąd API.
 * @param {any} responseData - Obiekt `response.data` z axiosa.
 */
export async function validateApiResponse(responseData: any) { // Zmieniona nazwa
  const exception = responseData?.exceptionClass;

  // 1. Sesja wygasła - napraw i rzuć błąd, aby ponowić
  if (exception === "org.objectledge.web.mvc.security.LoginRequiredException" || exception === "java.lang.SecurityException") {
    functions.logger.warn("⚠️ Sesja konta serwisowego wygasła. Uruchamiam ponowne logowanie...");
    await reloginAndStoreSession(); // Napraw sesję
    // Rzuć specyficzny błąd, aby poinformować `fetchScheduleForGroup`
    throw new Error("SessionExpiredRetry");
  }

  // 2. Inny błąd API - rzuć błąd
  if (exception !== null) {
    functions.logger.error("API zwróciło błąd (inny niż sesja):", exception);
    sendAdminNotification(
      "Błąd API (nie sesja)",
      `API zwróciło błąd: ${exception}`
    );
    throw new Error(`ApiError: ${exception}`);
  }
}
/**
 * Szyfruje tekst za pomocą algorytmu AES-256-CBC.
 * @param {string} text Tekst do zaszyfrowania.
 * @param {string} secretKey Klucz szyfrujący (32 bajty).
 * @return {string} Zaszyfrowany tekst w formacie IV:zaszyfrowany.
 */
export function encrypt(text: string, secretKey: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(secretKey), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}


/**
 * Odszyfrowuje tekst zaszyfrowany algorytmem AES-256-CBC.
 * @param {string} text Zaszyfrowany tekst w formacie IV:zaszyfrowany.
 * @param {string} secretKey Klucz szyfrujący (32 bajty).
 * @return {string} Odszyfrowany tekst.
 */
export function decrypt(text: string, secretKey: string): string {
  const [ivHex, encrypted] = text.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(secretKey), iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
