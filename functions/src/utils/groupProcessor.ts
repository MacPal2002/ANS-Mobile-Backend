import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import {GroupTreeItem, ProcessingContext} from "../types"; // Importuj nasze typy
import {COLLECTIONS} from "../config/firebase/collections";

const db = admin.firestore();

/**
 * Przetwarza pobrane drzewo grup i przygotowuje paczkę (batch) do zapisu w Firestore.
 * @param {GroupTreeItem[]} allItems - Tablica węzłów drzewa grup z API.
 * @param {string} academicYear - Rok akademicki (np. "2024-2025").
 * @param {number} academicYearStart - Rok rozpoczęcia (np. 2024).
 * @return {{batch: admin.firestore.WriteBatch, groupsFoundCounter: number}} Obiekt zawierający batch i liczbę znalezionych grup.
 */
export function processGroupTree(
  allItems: GroupTreeItem[],
  academicYear: string,
  academicYearStart: number
) {
  const batch = db.batch();
  let groupsFoundCounter = 0;
  const processedPaths = new Set<string>();

  // Definicja funkcji rekurencyjnej (skopiowana z Twojego kodu)
  const processNode = (node: GroupTreeItem, context: ProcessingContext) => {
    const newContext = {...context};

    if (node.type === "jednostka") {
      newContext.fieldOfStudy = node.label.trim();
    } else if (node.type === "rodzajetapu") {
      newContext.studyMode = node.label.trim();
    } else if (node.type === "cykl") {
      newContext.semester = node.label.trim();
    } else if (node.type === "grupadziekanska" && typeof node.id === "number") {
      const originalLabel = node.label;
      let groupName = node.label;

      let semesterIdentifier: string | null = null;
      const semesterMatch = groupName.match(/\s\(([ZL])\)$/);

      if (semesterMatch) {
        const semesterType = semesterMatch[1];
        if (semesterType === "Z") {
          semesterIdentifier = `${academicYearStart}Z`;
        } else {
          semesterIdentifier = `${academicYearStart + 1}L`;
        }
      }

      if (groupName.includes(":")) {
        groupName = groupName.split(":")[0];
      }
      groupName = groupName.replace(/\s\([ZL]\)$/, "").trim();

      const {fieldOfStudy, studyMode, semester} = newContext;

      if (fieldOfStudy && studyMode && semester && groupName && semesterIdentifier) {
        const yearDocPath = `${COLLECTIONS.DEAN_GROUPS}/${academicYear}`;
        const fieldOfStudyDocPath = `${COLLECTIONS.DEAN_GROUPS}/${academicYear}/${semesterIdentifier}/${fieldOfStudy}`;
        const semesterDocPath = `${COLLECTIONS.DEAN_GROUPS}/${academicYear}/${semesterIdentifier}/${fieldOfStudy}/${studyMode}/${semester}`;

        batch.set(db.doc(yearDocPath), {lastUpdated: new Date()}, {merge: true});
        batch.set(db.doc(fieldOfStudyDocPath), {lastUpdated: new Date()}, {merge: true});

        const uniqueGroupKey = `${semesterDocPath}/${groupName}`;
        if (!processedPaths.has(uniqueGroupKey)) {
          processedPaths.add(uniqueGroupKey);
          groupsFoundCounter++;

          const docRef = db.doc(semesterDocPath);
          batch.set(docRef, {[groupName]: node.id}, {merge: true});

          const groupDetailsRef = db.collection(COLLECTIONS.GROUP_DETAILS).doc(String(node.id));
          batch.set(groupDetailsRef, {
            groupName: groupName,
            fullPath: semesterDocPath,
          }, {merge: true});
        }
      } else {
        functions.logger.warn(`Pominięto grupę '${originalLabel}', brak kontekstu.`, {
          context: newContext,
          resolvedSemester: semesterIdentifier,
        });
      }
    }

    if (node.children) {
      for (const child of node.children) {
        processNode(child, newContext);
      }
    }
  }; // Koniec funkcji processNode

  // Rozpocznij przetwarzanie
  for (const item of allItems) {
    processNode(item, {});
  }

  // Zwróć gotowy batch i wynik
  return {batch, groupsFoundCounter};
}
