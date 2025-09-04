/* eslint-disable @typescript-eslint/no-explicit-any */
import * as admin from "firebase-admin";
import {messaging} from "firebase-admin";
import {TokenInfo} from "../types";


// =================================================================
// Funkcje pomocnicze do pracy z Firestore =========================
// =================================================================

/**
 * Pobiera identyfikatory wszystkich grup dziekańskich z bazy Firestore.
 * Przechodzi przez całą strukturę kolekcji i dokumentów, aby zebrać unikalne ID grup.
 * @return {Promise<Set<number>>} Zbiór unikalnych ID grup dziekańskich.
 */
export const getAllGroupIds = async (): Promise<Set<number>> => {
  const db = admin.firestore();
  const allGroupIds = new Set<number>();

  // 1. Pobierz dokumenty lat (np. "2024-2025")
  const academicYearSnapshot = await db.collection("deanGroups").get();

  for (const yearDoc of academicYearSnapshot.docs) {
    // 2. Pobierz kolekcje semestrów (np. "2024Z")
    const semesterIdColls = await yearDoc.ref.listCollections();
    for (const semIdColl of semesterIdColls) {
      // 3. Pobierz dokumenty kierunków (np. "IEZI")
      const fieldDocsSnapshot = await semIdColl.get();
      for (const fieldDoc of fieldDocsSnapshot.docs) {
        // 4. Pobierz kolekcje trybów studiów (np. "I,D,PL")
        const modeColls = await fieldDoc.ref.listCollections();
        for (const modeColl of modeColls) {
          // 5. Pobierz dokumenty semestrów (np. "semestr 1")
          const semesterDocsSnapshot = await modeColl.get();
          for (const semesterDoc of semesterDocsSnapshot.docs) {
            // 6. Odczytaj ID grup z pól dokumentu
            const groupData = semesterDoc.data();
            Object.values(groupData).forEach((id) => {
              if (typeof id === "number") {
                allGroupIds.add(id);
              }
            });
          }
        }
      }
    }
  }
  return allGroupIds;
};


/**
 * Przetwarza tablicę elementów i dodaje je do Firestore WriteBatch w celu zapisania.
 * Każdy element jest przekształcany w dokument zajęć pod ścieżką "schedules/{groupId}/classes/{classId}".
 * Funkcja wyciąga odpowiednie pola z każdego elementu, formatuje daty i ustawia dodatkowe metadane.
 * Przetwarzane są tylko elementy z prawidłowym `classId`.
 *
 * @param {any[]} items - Tablica elementów do przetworzenia i zapisania.
 * @param {number} groupId - Identyfikator grupy używany w ścieżce Firestore.
 * @param {string} weekId - Identyfikator tygodnia przypisywany do każdego zajęcia.
 * @param {admin.firestore.WriteBatch} batch - Instancja Firestore WriteBatch, do której dodawane są operacje.
 * @return {Promise<number>} Liczba elementów pomyślnie dodanych do batcha.
 */
export const processAndSaveBatch = async (
  items: any[], groupId: number, weekId: string, batch: admin.firestore.WriteBatch,
): Promise<number> => {
  const db = admin.firestore();
  let itemsInBatch = 0;
  for (const item of items) {
    const classId = item.idSpotkania?.idSpotkania?.toString();
    if (!classId) continue;

    const startTime = new Date(item.dataRozpoczecia);
    const dayString = startTime.toISOString().split("T")[0]; // Format YYYY-MM-DD

    const classData = {
      subjectFullName: item.nazwaPelnaPrzedmiotu || null,
      subjectShortName: item.nazwaSkroconaPrzedmiotu || null,
      startTime: admin.firestore.Timestamp.fromMillis(item.dataRozpoczecia),
      endTime: admin.firestore.Timestamp.fromMillis(item.dataZakonczenia),
      day: dayString,
      classType: item.listaIdZajecInstancji?.[0]?.typZajec || null,
      weekId: weekId,
      lecturers: item.wykladowcy?.map((w: any) => ({id: w.idProwadzacego, name: w.stopienImieNazwisko})) || [],
      rooms: item.sale?.map((s: any) => ({id: s.idSali, name: s.nazwaSkrocona})) || [],
      sourceGroupId: groupId,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    };

    const scheduleRef = db.collection("schedules").doc(groupId.toString()).collection("classes").doc(classId);
    batch.set(scheduleRef, classData, {merge: true});
    itemsInBatch++;
  }
  return itemsInBatch;
};


/**
 * Pobiera identyfikatory wszystkich grup dziekańskich dla danego semestru.
 * @param {string} semesterIdentifier - Identyfikator semestru, np. "2024Z" lub "2025L".
 * @return {Promise<Set<number>>} Zbiór unikalnych ID grup.
 */
export const getAllGroupIdsForSemester = async (semesterIdentifier: string): Promise<Set<number>> => {
  const db = admin.firestore();
  const allGroupIds = new Set<number>();

  // 1. Określ rok akademicki na podstawie identyfikatora semestru
  const year = parseInt(semesterIdentifier.substring(0, 4), 10);
  const type = semesterIdentifier.slice(-1); // "Z" lub "L"

  const academicYear = type === "Z" ? `${year}-${year + 1}` : `${year - 1}-${year}`;

  // 2. Zbuduj ścieżkę startową do kolekcji kierunków studiów
  const fieldsOfStudyCollectionRef = db.collection(`deanGroups/${academicYear}/${semesterIdentifier}`);

  // 3. Rozpocznij przechodzenie przez strukturę od tego miejsca
  const fieldDocsSnapshot = await fieldsOfStudyCollectionRef.get();

  if (fieldDocsSnapshot.empty) {
    console.log(`Nie znaleziono żadnych kierunków dla semestru ${semesterIdentifier}.`);
    return allGroupIds;
  }

  for (const fieldDoc of fieldDocsSnapshot.docs) {
    const modeColls = await fieldDoc.ref.listCollections();
    for (const modeColl of modeColls) {
      const semesterDocsSnapshot = await modeColl.get();
      for (const semesterDoc of semesterDocsSnapshot.docs) {
        const groupData = semesterDoc.data();
        // 4. Zbierz wszystkie wartości liczbowe (ID grup) z każdego dokumentu
        Object.values(groupData).forEach((id) => {
          if (typeof id === "number") {
            allGroupIds.add(id);
          }
        });
      }
    }
  }

  return allGroupIds;
};


/**
 * Pobiera plan zajęć dla danej grupy i konkretnego dnia.
 * @param {number} groupId Identyfikator grupy dziekańskiej.
 * @param {string} dateString Data w formacie "YYYY-MM-DD", np. "2025-07-22".
 * @return {Promise<any[]>} Tablica obiektów z zajęciami lub pusta tablica.
 */
export async function getScheduleForDay(groupId: number, dateString: string): Promise<any[]> {
  const db = admin.firestore();

  const scheduleCollectionRef = db.collection("schedules")
    .doc(groupId.toString())
    .collection("classes");

  // Zapytanie filtruje po polu "day" i sortuje po czasie rozpoczęcia
  const q = scheduleCollectionRef
    .where("day", "==", dateString)
    .orderBy("startTime");

  const snapshot = await q.get();

  if (snapshot.empty) {
    console.log(`Nie znaleziono zajęć dla grupy ${groupId} w dniu ${dateString}.`);
    return [];
  }

  // Zwróć tablicę z danymi zajęć
  return snapshot.docs.map((doc) => doc.data());
}

/**
 * Pobiera plan zajęć dla danej grupy na cały tydzień.
 * @param {number} groupId Identyfikator grupy dziekańskiej.
 * @param {string} weekId Timestamp początku tygodnia (poniedziałek, 00:00).
 * @return {Promise<any[]>} Tablica obiektów z zajęciami.
 */
export async function getScheduleForWeek(groupId: number, weekId: string): Promise<any[]> {
  const db = admin.firestore();
  const scheduleCollectionRef = db
    .collection("schedules")
    .doc(groupId.toString())
    .collection("classes");

  const q = scheduleCollectionRef
    .where("weekId", "==", weekId)
    .orderBy("startTime");

  const snapshot = await q.get();

  if (snapshot.empty) {
    console.log(`Nie znaleziono zajęć dla grupy ${groupId} w tygodniu ${weekId}.`);
    return [];
  }

  return snapshot.docs.map((doc) => doc.data());
}


/**
 * Rekurencyjnie buduje węzeł drzewa na podstawie dokumentu Firestore.
 * @param {FirebaseFirestore.DocumentSnapshot} doc Dokument Firestore.
 * @return {Promise<any>} Obiekt reprezentujący węzeł w drzewie.
 */
async function buildTreeForDocument(doc: admin.firestore.DocumentSnapshot): Promise<any> {
  const subcollections = await doc.ref.listCollections();

  // Przypadek 1: Ten dokument jest "liściem" zawierającym mapę grup (np. "semestr 6")
  if (subcollections.length === 0) {
    const data = doc.data() || {};
    const children = Object.entries(data).map(([name, id]) => ({
      id: String(id),
      name: name,
      type: "group", // To jest finalna, wybieralna grupa
      children: [],
      groupId: id as number,
    }));

    return {
      id: doc.id,
      name: doc.id,
      type: "parent_node",
      children: children,
      groupId: null,
    };
  } else {
    const childrenPromises = subcollections.map(async (subColl: { id?: any; get?: (() => any) | undefined; }) => {
      // Dla każdej podkolekcji (np. "2025L") tworzymy osobny, klikalny węzeł...
      if (typeof subColl.get === "function") {
        return {
          id: subColl.id,
          name: subColl.id,
          type: "parent_node",
          // ...i rekurencyjnie budujemy drzewo dla dokumentów wewnątrz niej.
          children: await buildTreeForCollection(subColl as { get: () => any }),
          groupId: null,
        };
      } else {
        return {
          id: subColl.id,
          name: subColl.id,
          type: "parent_node",
          children: [],
          groupId: null,
        };
      }
    });

    // Węzeł dla bieżącego dokumentu (np. "IEZI") będzie zawierał węzły dla swoich podkolekcji (np. "I,D,PL")
    return {
      id: doc.id,
      name: doc.id,
      type: "parent_node",
      children: await Promise.all(childrenPromises),
      groupId: null,
    };
  }
}

/**
 * Rekurencyjnie buduje drzewo na podstawie kolekcji Firestore.
 * @param {FirebaseFirestore.CollectionReference} collectionRef Referencja do kolekcji Firestore.
 * @return {Promise<any[]>} Tablica obiektów reprezentujących węzły w drzewie.
 */
export async function buildTreeForCollection(collectionRef: { get: () => any; }) {
  const snapshot = await collectionRef.get();
  if (snapshot.empty) return [];
  const promises = snapshot.docs.map((doc: admin.firestore.DocumentSnapshot) => buildTreeForDocument(doc));
  return Promise.all(promises);
}

/**
 * Analizuje odpowiedź z FCM i usuwa z bazy danych tokeny, które stały się nieaktywne.
 * @param {messaging.BatchResponse} response Odpowiedź z sendEachForMulticast.
 * @param {TokenInfo[]} tokenInfos Oryginalna lista informacji o tokenach.
 */
export async function cleanupInvalidTokens(
  response: messaging.BatchResponse,
  tokenInfos: TokenInfo[]
) {
  const db = admin.firestore();
  const tokensToDelete: TokenInfo[] = [];

  response.responses.forEach((result, index) => {
    // Sprawdź, czy wysyłka dla danego tokena się nie powiodła
    if (!result.success) {
      const errorCode = result.error?.code;
      console.log(`Błąd wysyłki do tokena: ${tokenInfos[index].token}, kod: ${errorCode}`);

      // Sprawdź, czy błąd oznacza, że token jest nieprawidłowy/niezarejestrowany
      if (
        errorCode === "messaging/registration-token-not-registered" ||
        errorCode === "messaging/invalid-registration-token"
      ) {
        tokensToDelete.push(tokenInfos[index]);
      }
    }
  });

  // Jeśli znaleziono tokeny do usunięcia, wykonaj operacje na bazie danych
  if (tokensToDelete.length > 0) {
    console.log(`Znaleziono ${tokensToDelete.length} nieaktywnych tokenów do usunięcia.`);
    // Stwórz listę wszystkich operacji usunięcia (obietnic)
    const deletePromises = tokensToDelete.map((info) => {
      return db.collection("students").doc(info.userId).update({
        [`devices.${info.deviceId}`]: admin.firestore.FieldValue.delete(),
      });
    });

    // Zaczekaj, aż wszystkie operacje zakończą się równolegle
    await Promise.all(deletePromises);
    console.log(`Pomyślnie usunięto dane dla ${tokensToDelete.length} nieaktywnych tokenów.`);
  }
}
