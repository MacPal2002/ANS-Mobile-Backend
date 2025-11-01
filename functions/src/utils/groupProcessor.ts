import * as functions from "firebase-functions";
import {GroupTreeItem, ProcessingContext} from "../types";
import {COLLECTIONS} from "../config/firebase/collections";
import {WriteBatch} from "firebase-admin/firestore";
import {db} from "./admin";

/**
 * Przetwarza pobrane drzewo grup i przygotowuje TABLICĘ paczek (batches) do zapisu w Firestore,
 * szanując limit 500 operacji.
 *
 * @param {GroupTreeItem[]} allItems - Tablica elementów drzewa grup do przetworzenia.
 * @param {string} academicYear - Rok akademicki w formacie tekstowym (np. "2023-2024").
 * @param {number} academicYearStart - Rok rozpoczęcia roku akademickiego (np. 2023).
 * @return {WriteBatch[]} Tablica paczek (batches) do zapisu w Firestore.
 */
export function processGroupTree(
  allItems: GroupTreeItem[],
  academicYear: string,
  academicYearStart: number
): WriteBatch[] {
  const batches: WriteBatch[] = [];
  let currentBatch = db.batch();
  let operationCounter = 0;
  const BATCH_LIMIT = 490;
  const processedPaths = new Set<string>();

  // Definicja funkcji rekurencyjnej
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

        const uniqueGroupKey = `${semesterDocPath}/${groupName}`;
        if (!processedPaths.has(uniqueGroupKey)) {
          processedPaths.add(uniqueGroupKey);

          if (operationCounter + 4 > BATCH_LIMIT) {
            batches.push(currentBatch);
            currentBatch = db.batch();
            operationCounter = 0;
          }
          currentBatch.set(db.doc(yearDocPath), {lastUpdated: new Date()}, {merge: true});
          currentBatch.set(db.doc(fieldOfStudyDocPath), {lastUpdated: new Date()}, {merge: true});

          const docRef = db.doc(semesterDocPath);
          currentBatch.set(docRef, {[groupName]: node.id}, {merge: true});

          const groupDetailsRef = db.collection(COLLECTIONS.GROUP_DETAILS).doc(String(node.id));
          currentBatch.set(groupDetailsRef, {
            groupName: groupName,
            fullPath: semesterDocPath,
          }, {merge: true});

          operationCounter += 4;
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
  };
  for (const item of allItems) {
    processNode(item, {});
  }

  if (operationCounter > 0) {
    batches.push(currentBatch);
  }
  return batches;
}
