import * as functions from "firebase-functions";
import * as scheduler from "firebase-functions/v2/scheduler";
import {LOCATION} from "../config/firebase/settings";
import {reloginAndStoreSession, getValidSessionCookie} from "../utils/secrets";
import axios from "axios";
import {AJAX_URL} from "../config/urls";
import {sendAdminNotification} from "../utils/helpers";


export const renewVerbisSession = scheduler.onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Europe/Warsaw",
    region: LOCATION,
    timeoutSeconds: 60, // 1 minuta (i tak trwa 2 sekundy)
    memory: "256MiB",
  },
  async () => {
    try {
      const sessionCookie = await getValidSessionCookie();
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
