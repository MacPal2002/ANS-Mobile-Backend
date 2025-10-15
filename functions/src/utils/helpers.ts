import * as functions from "firebase-functions";
import {accessSecret} from "./secretManager";
import axios from "axios";

/**
 * Wysyła powiadomienie do administratora o błędzie krytycznym na Telegrama.
 * @param {string} title Tytuł powiadomienia.
 * @param {string} message Treść powiadomienia.
 */
export async function sendAdminNotification(title: string, message: string): Promise<void> {
  try {
    const botToken = await accessSecret("telegram-bot-token");
    const chatId = await accessSecret("telegram-chat-id");

    if (!botToken || !chatId) {
      functions.logger.error("Brak tokenu bota lub chat ID w Secret Managerze.");
      return;
    }

    const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

    // Formatujemy wiadomość używając składni Markdown Telegrama
    const text = `🚨 *ALERT APLIKACJI* 🚨\n\n*${title}*\n\n\`\`\`\n${message}\n\`\`\``;

    await axios.post(telegramApiUrl, {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
    });

    functions.logger.info("✅ Pomyślnie wysłano powiadomienie na Telegrama.");
  } catch (error) {
    functions.logger.error(
      "❌ Błąd krytyczny podczas wysyłania powiadomienia na Telegrama:",
      error
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
  } catch (e) {
    return String(value);
  }
};
