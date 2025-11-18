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

    if (!email || !password || !albumNumber || !verbisPassword) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Proszę podać wszystkie wymagane dane.",
      );
    }

    const lookupDocRef = db.collection(COLLECTIONS.STUDENT_LOOKUPS).doc(albumNumber);
    const lookupDoc = await lookupDocRef.get();
    if (lookupDoc.exists) {
      throw new functions.https.HttpsError(
        "already-exists",
        `Użytkownik z numerem albumu ${albumNumber} już istnieje.`,
      );
    }

    const loginData = await loginToUniversity(albumNumber, verbisPassword);
    const {fullName, verbisId} = loginData;

    let newUserUid: string | null = null;
    try {
      const userRecord = await auth.createUser({
        email: email,
        password: password,
        displayName: fullName,
      });
      newUserUid = userRecord.uid;
      functions.logger.info(
        `Pomyślnie utworzono konto Firebase. UID: ${newUserUid}`,
      );

      const batch = db.batch();

      const studentDocRef = db.collection(COLLECTIONS.STUDENTS).doc(newUserUid);
      batch.set(studentDocRef, {
        uid: newUserUid,
        email: userRecord.email,
        albumNumber: albumNumber,
        displayName: fullName,
        verbisId: verbisId,
        createdAt: new Date(),
        // observedGroups: [],
        // devices: [],
      });

      const observedGroupsDocRef = db.collection(COLLECTIONS.STUDENT_OBSERVED_GROUPS).doc(newUserUid);
      batch.set(observedGroupsDocRef, {
        userId: newUserUid,
        groups: [],
      });

      const devicesDocRef = db.collection(COLLECTIONS.STUDENT_DEVICES).doc(newUserUid);
      batch.set(devicesDocRef, {
        userId: newUserUid,
        devices: [],
      });

      batch.set(lookupDocRef, {
        email: email,
      });

      await batch.commit();

      return {
        status: "success",
        message: "Rejestracja zakończona pomyślnie!",
        uid: newUserUid,
      };
    } catch (error: unknown) {
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
