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
