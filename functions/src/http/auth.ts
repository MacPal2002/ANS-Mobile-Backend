import {LOCATION} from "../config/firebase/settings";
import {RegisterStudentData} from "../types";
import {auth, db} from "../utils/admin";
import * as functions from "firebase-functions";
import {loginToUniversity} from "../utils/universityService";
import {COLLECTIONS} from "../config/firebase/collections";

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
    const lookupDocRef = db.collection(COLLECTIONS.STUDENT_LOOKUPS).doc(albumNumber);
    const lookupDoc = await lookupDocRef.get();
    if (lookupDoc.exists) {
      throw new functions.https.HttpsError(
        "already-exists",
        `Użytkownik z numerem albumu ${albumNumber} już istnieje.`,
      );
    }

    // Weryfikacja w systemie uczelni
    const loginData = await loginToUniversity(albumNumber, verbisPassword);
    const {fullName, verbisId} = loginData;

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
      const studentDocRef = db.collection(COLLECTIONS.STUDENTS).doc(newUserUid);
      batch.set(studentDocRef, {
        uid: newUserUid,
        email: userRecord.email,
        albumNumber: albumNumber,
        displayName: fullName,
        verbisId: verbisId,
        createdAt: new Date(),
        // observedGroups: [], // Domyślnie pusta lista obserwowanych grup
        // devices: [],
      });

      // Inicjalizacja dokumentu w 'student_observed_groups' z pustą listą
      const observedGroupsDocRef = db.collection(COLLECTIONS.STUDENT_OBSERVED_GROUPS).doc(newUserUid);
      batch.set(observedGroupsDocRef, {
        userId: newUserUid,
        groups: [],
      });

      // Inicjalizacja dokumentu w 'student_devices' z pustą listą
      const devicesDocRef = db.collection(COLLECTIONS.STUDENT_DEVICES).doc(newUserUid);
      batch.set(devicesDocRef, {
        userId: newUserUid,
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
