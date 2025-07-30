import {loginToUniversity} from "./universityService";
import * as functions from "firebase-functions";
import {SecretManagerServiceClient} from "@google-cloud/secret-manager";


const secretManager = new SecretManagerServiceClient();

/**
/** Pobiera wartość sekretu z Secret Managera. */
/**
 * @param {string} name Nazwa sekretu do pobrania.
 */
export async function accessSecret(name: string): Promise<string> {
  const projectId = process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error("Nie można odnaleźć ID projektu Google Cloud.");
  }
  const secretPath = `projects/${projectId}/secrets/${name}/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({name: secretPath});
  return version.payload?.data?.toString().trim() ?? "";
}

/**
 * Zapisuje nową wersję sekretu.
 * @param {string} name Nazwa sekretu do zaktualizowania.
 * @param {string} value Nowa wartość sekretu.
 */
async function updateSecret(name: string, value: string): Promise<void> {
  // 1. Pobierz ID Twojego projektu (np. "test-f856b")
  const projectId = process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error("Nie można odnaleźć ID projektu Google Cloud.");
  }

  // 2. Zbuduj pełną, unikalną "ścieżkę" do Twojego sejfu
  // np. "projects/test-f856b/secrets/verbis-session-cookie"
  const secretPath = `projects/${projectId}/secrets/${name}`;

  // 3. Wywołaj metodę API, która dodaje nową wersję sekretu
  await secretManager.addSecretVersion({
    // Wskazujemy, który "sejf" chcemy zaktualizować
    parent: secretPath,
    // Przekazujemy nową wartość, zakodowaną do formatu,
    // którego wymaga Secret Manager (Buffer)
    payload: {data: Buffer.from(value, "utf8")},
  });

  // 4. Zapisz informację w logach, że operacja się powiodła
  functions.logger.info(`✅ Pomyślnie zaktualizowano sekret: ${name}`);
}

/**
 * Ponownie loguje się do systemu uczelni i zapisuje nową sesję w Secret Managerze.
 */
export async function reloginAndStoreSession(): Promise<void> {
  functions.logger.info("🔄 Inicjowanie procesu ponownego logowania...");
  const login = await accessSecret("verbis-login");
  const password = await accessSecret("verbis-password");

  const loginData = await loginToUniversity(login, password);
  if (!loginData?.sessionCookie) {
    throw new Error("Nie udało się uzyskać ciasteczka sesji podczas ponownego logowania.");
  }

  await updateSecret("verbis-session-cookie", loginData.sessionCookie);
}
