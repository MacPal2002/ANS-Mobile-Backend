import * as functions from "firebase-functions";
import axios, {isAxiosError} from "axios";
import {getTelegramBotToken, getTelegramChatId} from "./secretManager";

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
