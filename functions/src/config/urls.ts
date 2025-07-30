// Ten plik przechowuje wszystkie stałe i adresy URL używane w aplikacji.

export const BASE_URL = "https://wu.ans-nt.edu.pl";


export const AJAX_URL = `${BASE_URL}/ppuz-stud-app/ledge/view/AJAX`;
export const LOGIN_URL =
  `${BASE_URL}/ppuz-stud-app/ledge/view/stud.info.ListaAktualnosciView` +
  "?action=security.authentication.ImapLogin";
export const PERSONAL_DATA_TAB_URL =
  `${BASE_URL}/ppuz-stud-app/ledge/view/stud.daneosobowe.DaneOsoboweTabView`;
export const PROFILE_URL =
  `${BASE_URL}/ppuz-stud-app/ledge/view/stud.daneosobowe.MojProfilView`;
