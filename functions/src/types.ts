import * as admin from "firebase-admin";

// Ten plik przechowuje wszystkie niestandardowe typy i interfejsy

/**
 * Definiuje strukturę danych wejściowych oczekiwanych przez
 * funkcję `registerStudent`.
 */
export interface RegisterStudentData {
  email: string;
  password: string;
  albumNumber: string;
  verbisPassword: string;
}

export type OrganizationUnit = { _class: string; idJednostki: number };
export type ChildReference = { _reference: OrganizationUnit };
export type GroupTreeItem = { id: number | string; label: string; type: string; children: GroupTreeItem[] | null };
export type RootApiResponseItem = { id: string; label: string; type: "root"; children: ChildReference[] };
export type ApiResponse = { returnedValue: { items: (RootApiResponseItem | GroupTreeItem)[] } | null; exceptionClass: string | null };
export type ProcessingContext = {
    fieldOfStudy?: string;
    studyMode?: string;
    semester?: string;
}

export interface TokenInfo {
  token: string;
  userId: string;
  deviceId: string;
}

type FirestoreTimestamp = admin.firestore.Timestamp;
type FirestoreFieldValue = admin.firestore.FieldValue;

export interface LecturerData {
  id: number;
  name: string | null;
}

export interface RoomData {
  id: number;
  name: string | null;
}

export type ComparisonKey = keyof IClassComparisonData;
/** Struktura danych używana po oczyszczeniu do PORÓWNANIA (prepareDataForComparison) */
export interface IClassComparisonData {
  subjectFullName: string | null;
  subjectShortName: string | null;
  startTime: number; // Milisekundy
  endTime: number; // Milisekundy
  day: string; // Format YYYY-MM-DD
  classType: string | null;
  lecturers: LecturerData[];
  rooms: RoomData[];
}

/** Struktura danych używana do ZAPISU do Firestore (classDataToSave) */
export interface IClassSaveData {
  subjectFullName: string | null;
  subjectShortName: string | null;
  startTime: FirestoreTimestamp;
  endTime: FirestoreTimestamp;
  day: string;
  classType: string | null;
  weekId: string;
  lecturers: { id: number, name: string | null }[];
  rooms: { id: number, name: string | null }[];
  sourceGroupId: number;
  lastUpdated: FirestoreFieldValue;
}
