/* eslint-disable @typescript-eslint/no-explicit-any */
import deepEqual from "fast-deep-equal";
import {messaging} from "firebase-admin";
import {IClassComparisonData, IClassSaveData, TokenInfo, LecturerData, RoomData, ComparisonKey} from "../types";
import {decrypt, encrypt, formatValueForLog} from "./helpers";
import {db, firestore} from "./admin";
import {COLLECTIONS} from "../config/firebase/collections";
import {WriteBatch, DocumentSnapshot} from "firebase-admin/firestore";
import {encryptionKey} from "./env";

// =================================================================
// Funkcje pomocnicze do pracy z Firestore =========================
// =================================================================

/**
 * Pobiera identyfikatory wszystkich grup dziekańskich z bazy Firestore.
 * Przechodzi przez całą strukturę kolekcji i dokumentów, aby zebrać unikalne ID grup.
 * @return {Promise<Set<number>>} Zbiór unikalnych ID grup dziekańskich.
 */
export const getAllGroupIds = async (): Promise<Set<number>> => {
  const allGroupIds = new Set<number>();

  // 1. Pobierz dokumenty lat (np. "2024-2025")
  const academicYearSnapshot = await db.collection(COLLECTIONS.DEAN_GROUPS).get();

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

export const processAndUpdateBatch = async (
  items: any[], groupId: number, weekId: string, batch: WriteBatch,
): Promise<{ batchOperationsCount: number, changedClassesCount: number }> => {
  let batchOperationsCount = 0;
  let changedClassesCount = 0;

  const groupClassesRef = db.collection(COLLECTIONS.SCHEDULES).doc(groupId.toString()).collection(COLLECTIONS.CLASSES_SUBCOLLECTION);

  // Pobieranie istniejących zajęć
  console.log(`[${groupId}][${weekId}] 📥 Rozpoczynam pobieranie istniejących zajęć.`);
  const existingSnapshot = await groupClassesRef.where("weekId", "==", weekId).get();

  // MAPOWANIE NA POTRZEBY SOFT MATCHINGU
  const existingClassesMap = new Map<string, any>();
  // Dodanie typu IClassComparisonData do obiektu Soft Key
  const softKeyToExistingClass = new Map<string, { id: string, data: any, softKey: string, comparisonData: IClassComparisonData }>();

  existingSnapshot.forEach((doc) => {
    const data = doc.data();
    const docId = String(doc.id);
    existingClassesMap.set(docId, data);

    // Tworzymy oczyszczony obiekt do wyliczenia soft key
    const comparisonData: IClassComparisonData = prepareDataForComparison(data); // Użycie typu
    const softKey = getSoftKey(comparisonData);

    softKeyToExistingClass.set(softKey, {id: docId, data, softKey, comparisonData}); // Zapisanie danych do porównania
  });

  console.log(
    `[${groupId}][${weekId}] 📚 Znaleziono ${existingSnapshot.size} istniejących zajęć. Nowe dane z API: ${items.length}`
  );

  const processedExistingIds = new Set<string>();

  // Porównanie i aktualizacja
  for (const newItem of items) {
    const classId = String(newItem.idSpotkania?.idSpotkania ?? ""); // ID z API

    if (!classId) {
      console.warn(`[${groupId}][${weekId}] ⚠️ Pominięto element bez ID: ${JSON.stringify(newItem)}`);
      continue;
    }

    // --- PRZYGOTOWANIE DANYCH ---
    const newDataForComparison: IClassComparisonData = prepareDataForComparison(newItem); // Użycie typu
    const newSoftKey = getSoftKey(newDataForComparison);

    // Dane do zapisu (TRYMOWANE!) - Użycie typu IClassSaveData
    const startTime = new Date(newItem.dataRozpoczecia);
    const dayString = startTime.toISOString().split("T")[0];

    const classDataToSave: IClassSaveData = {
      subjectFullName: newItem.nazwaPelnaPrzedmiotu?.trim() || null,
      subjectShortName: newItem.nazwaSkroconaPrzedmiotu?.trim() || null,
      startTime: firestore.Timestamp.fromMillis(newItem.dataRozpoczecia),
      endTime: firestore.Timestamp.fromMillis(newItem.dataZakonczenia),
      day: dayString,
      classType: newItem.listaIdZajecInstancji?.[0]?.typZajec || null,
      weekId,
      lecturers: newItem.wykladowcy?.map((w: any) => ({
        id: w.idProwadzacego,
        name: w.stopienImieNazwisko?.trim(),
      })) || [],
      rooms: newItem.sale?.map((s: any) => ({
        id: s.idSali,
        name: s.nazwaSkrocona?.trim(),
      })) || [],
      sourceGroupId: groupId,
      lastUpdated: firestore.FieldValue.serverTimestamp(),
    };
    // ------------------------------

    // 1. SOFT MATCHING: Czy istnieje zajęcie o tym samym Soft Key?
    const existingMatch = softKeyToExistingClass.get(newSoftKey);

    if (existingMatch) {
      // ZNALEZIONO DOPASOWANIE (Soft Match)

      const existingId = existingMatch.id;
      const existingDataForComparison = existingMatch.comparisonData; // Pobieramy już wyliczone dane do porównania!

      // Używamy starego ID do aktualizacji (klucz Soft Match)
      const matchedScheduleRef = groupClassesRef.doc(existingId);
      processedExistingIds.add(existingId);

      // Jeżeli deepEqual zwróci false (wykryto zmianę w szczegółach)
      if (!deepEqual(newDataForComparison, existingDataForComparison)) {
        // --- Ręczne zbieranie różnic (dla logowania) ---
        const differences: Record<string, { old: any, new: any }> = {};
        const diffKeys: string[] = [];

        for (const key of Object.keys(newDataForComparison) as ComparisonKey[]) {
          const newValStr = formatValueForLog(newDataForComparison[key]);
          const oldValStr = formatValueForLog(existingDataForComparison[key]);

          if (newValStr !== oldValStr) {
            diffKeys.push(key);
            differences[key] = {
              old: existingDataForComparison[key],
              new: newDataForComparison[key],
            };
          }
        }
        // ------------------------------------------------

        batch.set(matchedScheduleRef, classDataToSave, {merge: true});
        batchOperationsCount++;
        changedClassesCount++;

        const diffDetails = diffKeys.map((key) => {
          const diff = differences[key];
          return `${key}: (Stara) ${formatValueForLog(diff.old)} -> (Nowa) ${formatValueForLog(diff.new)}`;
        }).join("; ");

        console.log(
          // eslint-disable-next-line max-len
          `[${groupId}][${weekId}][${existingId}] 🔄 ZAKTUALIZOWANO (Soft Match): ${classDataToSave.subjectShortName} (${dayString}). Zmienione pola: ${diffKeys.join(", ")}. Szczegóły: ${diffDetails}`
        );
      }
    } else {
      // 2. BRAK SOFT MATCHINGU: Traktujemy jako nowe zajęcia do dodania

      const scheduleRef = groupClassesRef.doc();
      const newDocumentId = scheduleRef.id;

      batch.set(scheduleRef, classDataToSave);
      batchOperationsCount++;
      changedClassesCount++;

      const details = formatClassDetails(newItem);

      console.log(`[${groupId}][${weekId}][${newDocumentId}] ➕ DODANO: ${classDataToSave.subjectShortName} (${dayString})`);
      console.log(`[${groupId}][${weekId}][${newDocumentId}] DODANO SZCZEGÓŁY: ${JSON.stringify(details, null, 2)}`);
    }
  }

  // Usuwanie zajęć, które ZNIKNĘŁY z planu (nie zostały użyte w Soft Matchingu)
  for (const classId of existingClassesMap.keys()) {
    if (!processedExistingIds.has(classId)) {
      const deletedItemData = existingClassesMap.get(classId);
      batch.delete(groupClassesRef.doc(classId));
      batchOperationsCount++;
      changedClassesCount++;
      if (deletedItemData) {
        const details = formatClassDetails(deletedItemData, classId);
        console.log(
          `[${groupId}][${weekId}][${classId}] ➖ USUNIĘTO: ${details.KrótkaNazwa} (${details.Typ}) dnia ${details.Dzień}`
        );
        console.log(`[${groupId}][${weekId}][${classId}] USUNIĘTE SZCZEGÓŁY: ${JSON.stringify(details, null, 2)}`);
      } else {
        // eslint-disable-next-line max-len
        console.log(`[${groupId}][${weekId}][${classId}] ➖ USUNIĘTO: Zajęcia (ID: ${classId}) nie znalezione w nowych danych. Brak szczegółowych danych.`);
      }
    }
  }

  // eslint-disable-next-line max-len
  console.log(`[${groupId}][${weekId}] 🏁 Zakończono przetwarzanie grupy. Operacje w batchu: ${batchOperationsCount}, Zmiany zajęć: ${changedClassesCount}`);

  return {batchOperationsCount, changedClassesCount};
};

/**
 * @deprecated
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
  items: any[], groupId: number, weekId: string, batch: WriteBatch,
): Promise<number> => {
  let itemsInBatch = 0;
  for (const item of items) {
    const classId = item.idSpotkania?.idSpotkania?.toString();
    if (!classId) continue;

    const startTime = new Date(item.dataRozpoczecia);
    const dayString = startTime.toISOString().split("T")[0]; // Format YYYY-MM-DD

    const classData = {
      subjectFullName: item.nazwaPelnaPrzedmiotu || null,
      subjectShortName: item.nazwaSkroconaPrzedmiotu || null,
      startTime: firestore.Timestamp.fromMillis(item.dataRozpoczecia),
      endTime: firestore.Timestamp.fromMillis(item.dataZakonczenia),
      day: dayString,
      classType: item.listaIdZajecInstancji?.[0]?.typZajec || null,
      weekId: weekId,
      lecturers: item.wykladowcy?.map((w: any) => ({id: w.idProwadzacego, name: w.stopienImieNazwisko})) || [],
      rooms: item.sale?.map((s: any) => ({id: s.idSali, name: s.nazwaSkrocona})) || [],
      sourceGroupId: groupId,
      lastUpdated: firestore.FieldValue.serverTimestamp(),
    };

    // eslint-disable-next-line max-len
    const scheduleRef = db.collection(COLLECTIONS.SCHEDULES).doc(groupId.toString()).collection(COLLECTIONS.CLASSES_SUBCOLLECTION).doc(classId);
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
  const allGroupIds = new Set<number>();

  // 1. Określ rok akademicki na podstawie identyfikatora semestru
  const year = parseInt(semesterIdentifier.substring(0, 4), 10);
  const type = semesterIdentifier.slice(-1); // "Z" lub "L"

  const academicYear = type === "Z" ? `${year}-${year + 1}` : `${year - 1}-${year}`;

  // 2. Zbuduj ścieżkę startową do kolekcji kierunków studiów
  const fieldsOfStudyCollectionRef = db.collection(`${COLLECTIONS.DEAN_GROUPS}/${academicYear}/${semesterIdentifier}`);

  // 3. Rozpocznij przechodzenie przez strukturę od tego miejsca
  const fieldDocsSnapshot = await fieldsOfStudyCollectionRef.get();

  if (fieldDocsSnapshot.empty) {
    console.log(`Nie znaleziono żadnych kierunków dla semestru ${semesterIdentifier}.`);
    return allGroupIds;
  }


  const modeCollsPromises = fieldDocsSnapshot.docs.map((fieldDoc) => fieldDoc.ref.listCollections());
  const allModeCollsNested = await Promise.all(modeCollsPromises);
  const allModeColls = allModeCollsNested.flat(); // Spłaszcz tablicę tablic

  // Zbierz wszystkie obietnice pobierania dokumentów
  const semesterDocsPromises = allModeColls.map((modeColl) => modeColl.get());
  const allSemesterSnapshots = await Promise.all(semesterDocsPromises);

  // Teraz iteruj po wynikach, które już masz
  for (const semesterDoc of allSemesterSnapshots.flatMap((snap) => snap.docs)) {
    const groupData = semesterDoc.data();
    // 4. Zbierz wszystkie wartości liczbowe (ID grup) z każdego dokumentu
    Object.values(groupData).forEach((id) => {
      if (typeof id === "number") {
        allGroupIds.add(id);
      }
    });
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
  const scheduleCollectionRef = db.collection(COLLECTIONS.SCHEDULES)
    .doc(groupId.toString())
    .collection(COLLECTIONS.CLASSES_SUBCOLLECTION);

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
  const scheduleCollectionRef = db
    .collection(COLLECTIONS.SCHEDULES)
    .doc(groupId.toString())
    .collection(COLLECTIONS.CLASSES_SUBCOLLECTION);

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
async function buildTreeForDocument(doc: DocumentSnapshot): Promise<any> {
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
  const promises = snapshot.docs.map((doc: DocumentSnapshot) => buildTreeForDocument(doc));
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
      return db.collection(COLLECTIONS.STUDENT_DEVICES).doc(info.userId).update({
        [`devices.${info.deviceId}`]: firestore.FieldValue.delete(),
      });
    });

    // Zaczekaj, aż wszystkie operacje zakończą się równolegle
    await Promise.all(deletePromises);
    console.log(`Pomyślnie usunięto dane dla ${tokensToDelete.length} nieaktywnych tokenów.`);
  }
}

/**
 * Przygotowuje dane zajęć do porównania z istniejącym dokumentem.
 * @param {any} item Dane zajęć (nowe lub istniejące).
 * @return {IClassComparisonData} Oczyszczony obiekt danych.
 */
const prepareDataForComparison = (item: any): IClassComparisonData => {
  let startTimeMillis: number;
  let endTimeMillis: number;

  const isTimestamp = (t: any) => t && typeof t.toMillis === "function";

  if (isTimestamp(item.startTime) && isTimestamp(item.endTime)) {
    startTimeMillis = Math.floor(item.startTime.toMillis());
    endTimeMillis = Math.floor(item.endTime.toMillis());
  } else {
    const startValue = item.dataRozpoczecia || item.startTime || 0;
    const endValue = item.dataZakonczenia || item.endTime || 0;

    startTimeMillis = Math.floor(Number(startValue));
    endTimeMillis = Math.floor(Number(endValue));
  }

  const getLecturersForComparison = (lecturersArray: any[]): LecturerData[] => lecturersArray.map((w: any) => ({
    id: w.idProwadzacego || w.id,
    name: (w.stopienImieNazwisko || w.name)?.trim() || null,
  }));

  const getRoomsForComparison = (roomsArray: any[]): RoomData[] => roomsArray.map((s: any) => ({
    id: s.idSali || s.id,
    name: (s.nazwaSkrocona || s.name)?.trim() || null,
  }));

  const lecturersToCompare =
        (item.lecturers && getLecturersForComparison(item.lecturers)) ||
        (item.wykladowcy && getLecturersForComparison(item.wykladowcy)) ||
        [];

  const roomsToCompare =
        (item.rooms && getRoomsForComparison(item.rooms)) ||
        (item.sale && getRoomsForComparison(item.sale)) ||
        [];

  lecturersToCompare.sort((a: LecturerData, b: LecturerData) => a.id - b.id);
  roomsToCompare.sort((a: RoomData, b: RoomData) => a.id - b.id);

  return {
    subjectFullName: item.nazwaPelnaPrzedmiotu?.trim() || item.subjectFullName?.trim() || null,
    subjectShortName: item.nazwaSkroconaPrzedmiotu?.trim() || item.subjectShortName?.trim() || null,
    startTime: startTimeMillis,
    endTime: endTimeMillis,
    day: item.day || new Date(startTimeMillis).toISOString().split("T")[0],
    classType: item.listaIdZajecInstancji?.[0]?.typZajec || item.classType || null,
    lecturers: lecturersToCompare,
    rooms: roomsToCompare,
  };
};
const formatClassDetails = (data: any, docId?: string) => {
  const rawStartTime = data.startTime || data.dataRozpoczecia;

  const startTimeMillis = rawStartTime ?
    (rawStartTime.toMillis ? rawStartTime.toMillis() : rawStartTime) :
    null;

  const dayString = data.day || (
    startTimeMillis ? new Date(startTimeMillis).toISOString().split("T")[0] : null
  );

  const details = {
    ID: docId || String(data.idSpotkania?.idSpotkania ?? data.id ?? "N/A"),
    KrótkaNazwa: data.subjectShortName || data.nazwaSkroconaPrzedmiotu || null,
    PełnaNazwa: data.subjectFullName || data.nazwaPelnaPrzedmiotu || null,
    Typ: data.classType || data.listaIdZajecInstancji?.[0]?.typZajec || null,
    Dzień: dayString,
    Od: data.startTime || data.dataRozpoczecia,
    Do: data.endTime || data.dataZakonczenia,
    Wykładowcy: (data.lecturers || data.wykladowcy)?.map((w: any) => ({
      id: w.id || w.idProwadzacego,
      name: (w.name || w.stopienImieNazwisko)?.trim(),
    })) || [],
    Sale: (data.rooms || data.sale)?.map((s: any) => ({
      id: s.id || s.idSali,
      name: (s.name || s.nazwaSkrocona)?.trim(),
    })) || [],
  };
  return details;
};

/**
 * Szyfruje przekazany ciąg sesji i zapisuje go w bazie Firestore w kolekcji "sessions"
 * pod dokumentem o ID "verbis". Przechowywany jest zaszyfrowany token oraz aktualny znacznik czasu serwera.
 *
 * @param {string} session - Ciąg sesji do zaszyfrowania i zapisania.
 * @return {Promise<void>} Promise, która kończy się po zapisaniu sesji w Firestore.
 */
export async function saveSessionToFirestore(session: string) {
  const key = encryptionKey.value();
  const encrypted = encrypt(session, key);
  await db.collection("sessions").doc("verbis").set({
    token: encrypted,
    updatedAt: firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Pobiera zaszyfrowany token sesji z kolekcji "sessions" (dokument "verbis"),
 * odszyfrowuje go przy użyciu klucza z konfiguracji i zwraca odszyfrowany token jako string.
 *
 * @return {Promise<string | null>} Odszyfrowany token sesji, jeśli istnieje; w przeciwnym razie `null`.
 */
export async function getSessionFromFirestore(): Promise<string | null> {
  const key = encryptionKey.value();
  const doc = await db.collection("sessions").doc("verbis").get();
  if (!doc.exists) return null;
  return decrypt(doc.data()?.token, key);
}

/**
 * Generuje klucz unikalności (soft key) na podstawie niezmiennych pól zajęć.
 * @param {IClassComparisonData} item Oczyszczony obiekt z prepareDataForComparison.
 * @return {string} Unikalny klucz.
 */
const getSoftKey = (item: IClassComparisonData): string => {
// Sortowanie list ID jest kluczowe, nawet jeśli już były posortowane w prepareDataForComparison,
// Soft Key wymaga absolutnej stabilności formatu stringa.
  const lecturerIds = item.lecturers.map((l: LecturerData) => l.id).sort((a, b) => a - b).join(",");
  const roomIds = item.rooms.map((r: RoomData) => r.id).sort((a, b) => a - b).join(",");

  return [
    item.day,
    item.startTime,
    item.classType,
    item.subjectShortName,
    lecturerIds,
    roomIds,
  ].join("|");
};

