/* eslint-disable @typescript-eslint/no-explicit-any */
import deepEqual from "fast-deep-equal";
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
 * Przygotowuje dane zajęć do porównania z istniejącym dokumentem.
 * Wyklucza pola dynamiczne, takie jak 'lastUpdated'.
 * @param {any} item Dane zajęć (nowe lub istniejące).
 * @return {object} Oczyszczony obiekt danych.
 */
// eslint-disable-next-line max-len
const prepareDataForComparison = (item: any): any => {
  let startTimeMillis;
  let endTimeMillis;

  // Funkcja pomocnicza sprawdzająca, czy dany obiekt jest poprawnym Timestampem
  const isTimestamp = (t: any) => t && typeof t.toMillis === "function";

  // Zabezpieczamy OBA czasy przed wywołaniem .toMillis()
  if (isTimestamp(item.startTime) && isTimestamp(item.endTime)) {
    // Dane z Firestore (Timestamp)
    startTimeMillis = Math.floor(item.startTime.toMillis());
    endTimeMillis = Math.floor(item.endTime.toMillis());
  } else {
    // Dane z API (Milisekundy/Number)
    // Używamy 0 jako wartość awaryjną, jeśli któregoś z pól brakuje w API
    const startValue = item.dataRozpoczecia || item.startTime || 0;
    const endValue = item.dataZakonczenia || item.endTime || 0;

    startTimeMillis = Math.floor(Number(startValue));
    endTimeMillis = Math.floor(Number(endValue));
  }

  // --- Zmiana tutaj: Zapewnienie trymowania dla tablic (Nowe/API i Stare/Firestore) ---
  const getLecturersForComparison = (lecturersArray: any[]) => lecturersArray.map((w: any) => ({
    id: w.idProwadzacego || w.id,
    name: (w.stopienImieNazwisko || w.name)?.trim() || null,
  }));

  const getRoomsForComparison = (roomsArray: any[]) => roomsArray.map((s: any) => ({
    id: s.idSali || s.id,
    name: (s.nazwaSkrocona || s.name)?.trim() || null,
  }));
  // ---------------------------------------------------------------------------------

  const lecturersToCompare =
      (item.lecturers && getLecturersForComparison(item.lecturers)) || // Stary format (Firestore)
      (item.wykladowcy && getLecturersForComparison(item.wykladowcy)) || // Nowy format (API)
      [];

  const roomsToCompare =
      (item.rooms && getRoomsForComparison(item.rooms)) || // Stary format (Firestore)
      (item.sale && getRoomsForComparison(item.sale)) || // Nowy format (API)
      [];

  // Sortowanie, żeby kolejność nie wpływała na wynik porównania
  lecturersToCompare.sort((a: any, b: any) => a.id - b.id);
  roomsToCompare.sort((a: any, b: any) => a.id - b.id);

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

/**
 * Funkcja pomocnicza do zwięzłego wyświetlania wartości w logach.
 * Używa JSON.stringify, aby poprawnie formatować obiekty i tablice.
 *
 * @param {any} value Wartość do sformatowania (może być obiektem, tablicą lub innym typem).
 * @param {number} [maxLength=70] Maksymalna długość zwracanego stringa (opcjonalnie, domyślnie 70).
 * @return {string} Sformatowana wartość jako string, skrócona jeśli przekracza maxLength.
 */
const formatValueForLog = (value: any, maxLength = 70): string => {
  try {
    const str = JSON.stringify(value);
    if (str.length > maxLength) {
      // Skracanie długich stringów, np. dla dużych list wykładowców/sal
      return str.substring(0, maxLength - 3) + "... (Skrócono)";
    }
    return str;
  } catch (e) {
    return String(value); // W przypadku błędu serializacji
  }
};
const formatClassDetails = (data: any, docId?: string) => {
  // 1. Ustalenie źródła milisekund (dataRozpoczecia dla API, startTime dla Firestore)
  // UWAGA: Użycie || (LUB) pozwala na obsługę danych z API lub Firestore
  const rawStartTime = data.startTime || data.dataRozpoczecia;

  // 2. Bezpieczne wyznaczenie wartości startTime w milisekundach (lub null)
  const startTimeMillis = rawStartTime ?
    (rawStartTime.toMillis ? rawStartTime.toMillis() : rawStartTime) :
    null;

  // 3. Bezpieczne obliczenie pola Dzień
  const dayString = data.day || (
    startTimeMillis ? new Date(startTimeMillis).toISOString().split("T")[0] : null
  );

  // Zbieranie i ujednolicanie danych
  const details = {
    // Poprawiony odczyt ID: używamy docId (ID dokumentu) lub idSpotkania
    ID: docId || String(data.idSpotkania?.idSpotkania ?? data.id ?? "N/A"),
    KrótkaNazwa: data.subjectShortName || data.nazwaSkroconaPrzedmiotu || null,
    PełnaNazwa: data.subjectFullName || data.nazwaPelnaPrzedmiotu || null,
    Typ: data.classType || data.listaIdZajecInstancji?.[0]?.typZajec || null,
    Dzień: dayString,
    // Zapewnienie, że logujemy pole czasu, które rzeczywiście ma wartość
    Od: data.startTime || data.dataRozpoczecia,
    Do: data.endTime || data.dataZakonczenia,
    // ... (reszta pól bez zmian)
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
 * Generuje klucz unikalności (soft key) na podstawie niezmiennych pól zajęć.
 * Służy do identyfikacji tych samych zajęć, których ID mogło zmienić się w API.
 * @param {object} item Oczyszczony obiekt z prepareDataForComparison.
 * @return {string} Unikalny klucz.
 */
const getSoftKey = (item: any): string => {
  // Używamy najbardziej niezmiennych pól: dzień, czas rozpoczęcia, typ i krótka nazwa.
  // Sale i Wykładowcy mogą się zmieniać, ale klucz unikalności powinien zostać stały.
  const lecturerIds = item.lecturers.map((l: any) => l.id).join(",");
  const roomIds = item.rooms.map((r: any) => r.id).join(",");

  return [
    item.day,
    item.startTime,
    item.classType,
    item.subjectShortName,
    lecturerIds,
    roomIds,
  ].join("|");
};

export const processAndUpdateBatch = async (
  items: any[], groupId: number, weekId: string, batch: admin.firestore.WriteBatch,
): Promise<{ batchOperationsCount: number, changedClassesCount: number }> => {
  const db = admin.firestore();
  let batchOperationsCount = 0;
  let changedClassesCount = 0;

  const groupClassesRef = db.collection("schedules").doc(groupId.toString()).collection("classes");

  // Pobieranie istniejących zajęć
  console.log(`[${groupId}][${weekId}] 📥 Rozpoczynam pobieranie istniejących zajęć.`);
  const existingSnapshot = await groupClassesRef.where("weekId", "==", weekId).get();

  // MAPOWANIE NA POTRZEBY SOFT MATCHINGU
  const existingClassesMap = new Map<string, any>();
  const softKeyToExistingClass = new Map<string, { id: string, data: any, softKey: string }>();

  existingSnapshot.forEach((doc) => {
    const data = doc.data();
    const docId = String(doc.id);
    existingClassesMap.set(docId, data);

    // Tworzymy oczyszczony obiekt do wyliczenia soft key
    const dataForComparison = prepareDataForComparison(data);
    const softKey = getSoftKey(dataForComparison);

    softKeyToExistingClass.set(softKey, {id: docId, data, softKey});
  });

  console.log(
    `[${groupId}][${weekId}] 📚 Znaleziono ${existingSnapshot.size} istniejących zajęć. Nowe dane z API: ${items.length}`
  );

  const processedExistingIds = new Set<string>(); // Śledzić, które stare ID zostały użyte

  // Porównanie i aktualizacja
  for (const newItem of items) {
    const classId = String(newItem.idSpotkania?.idSpotkania ?? ""); // ID z API

    if (!classId) {
      console.warn(`[${groupId}][${weekId}] ⚠️ Pominięto element bez ID: ${JSON.stringify(newItem)}`);
      continue;
    }

    // --- PRZYGOTOWANIE DANYCH ---
    const newDataForComparison = prepareDataForComparison(newItem);
    const newSoftKey = getSoftKey(newDataForComparison);
    // Dane do zapisu (TRYMOWANE!)
    const startTime = new Date(newItem.dataRozpoczecia);
    const dayString = startTime.toISOString().split("T")[0];
    const classDataToSave = {
      subjectFullName: newItem.nazwaPelnaPrzedmiotu?.trim() || null,
      subjectShortName: newItem.nazwaSkroconaPrzedmiotu?.trim() || null,
      startTime: admin.firestore.Timestamp.fromMillis(newItem.dataRozpoczecia),
      endTime: admin.firestore.Timestamp.fromMillis(newItem.dataZakonczenia),
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
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    };
      // ------------------------------

    // 1. SOFT MATCHING: Czy istnieje zajęcie o tym samym Soft Key?
    const existingMatch = softKeyToExistingClass.get(newSoftKey);

    if (existingMatch) {
    // ZNALEZIONO DOPASOWANIE (Soft Match)

      const existingId = existingMatch.id;
      const existingItemData = existingMatch.data;
      const existingDataForComparison = prepareDataForComparison(existingItemData);

      // Używamy starego ID do aktualizacji (klucz Soft Match)
      const matchedScheduleRef = groupClassesRef.doc(existingId);
      processedExistingIds.add(existingId);

      // Jeżeli deepEqual zwróci false (wykryto zmianę w szczegółach)
      if (!deepEqual(newDataForComparison, existingDataForComparison)) {
        // --- Ręczne zbieranie różnic (dla logowania) ---
        const differences: Record<string, { old: any, new: any }> = {};
        const diffKeys: string[] = [];

        for (const key of Object.keys(newDataForComparison)) {
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

      const scheduleRef = groupClassesRef.doc(classId); // Używamy nowego ID z API

      batch.set(scheduleRef, classDataToSave);
      batchOperationsCount++;
      changedClassesCount++;

      const details = formatClassDetails(newItem);

      console.log(`[${groupId}][${weekId}][${classId}] ➕ DODANO: ${classDataToSave.subjectShortName} (${dayString})`);
      console.log(`[${groupId}][${weekId}][${classId}] DODANO SZCZEGÓŁY: ${JSON.stringify(details, null, 2)}`);
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
