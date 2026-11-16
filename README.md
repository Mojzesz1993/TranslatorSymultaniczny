# Debate Live Translator (PL ➔ EN)

Aplikacja lokalna do symultanicznego tłumaczenia debat i konferencji prowadzonych w języku polskim na wyraźne, duże napisy w języku angielskim wyświetlane na rzutniku, telebimie, telewizorze lub w OBS.

---

## 🚀 Wdrożenie na nowym laptopie (Windows 10 / 11)

1. Sklonuj repozytorium lub pobierz paczkę ZIP i rozpakuj ją na dysku:
   ```powershell
   git clone https://github.com/Mojzesz1993/TranslatorSymultaniczny.git
   cd TranslatorSymultaniczny
   ```
2. Kliknij dwukrotnie plik **`Instaluj_Translator.bat`**.
   Instalator automatycznie:
   - sprawdzi (lub pobierze i zainstaluje) środowisko **Python 3.12**,
   - zainstaluje biblioteki **`numpy`**, **`onnxruntime`** oraz **`msvc-runtime`** (biblioteki C++),
   - zweryfikuje lokalny model biometrii głosowej **WeSpeaker CAM++ ONNX** (`models/wespeaker_campp.onnx`),
   - utworzy na Pulpicie skrót **`Debate Live Translator`**.

---

## ▶ Codzienne uruchomienie

1. Kliknij dwukrotnie **`Uruchom_Translator.bat`** (lub skrót na Pulpicie).
2. Aplikacja uruchomi lokalny serwer (`http://localhost:8765`) i otworzy **Panel Operatora** w przeglądarce (zalecany Google Chrome lub Microsoft Edge).
3. Kliknij **`🖥 OTWÓRZ EKRAN PREZENTACJI`**, przeciągnij okno na drugi ekran (rzutnik / TV) i naciśnij **`F`** (pełny ekran).
4. **Prezentacje (PowerPoint / PDF):** Kliknij **`📊 PANEL SLAJDÓW`** (lub wejdź na `http://localhost:8766`), aby wgrać plik `.pptx`/`.pdf`, sterować slajdami (z podglądem i notatkami) oraz wyświetlać tłumaczenie na żywo bezpośrednio nad slajdami.

Szczegółowa instrukcja obsługi znajduje się w pliku [INSTRUKCJA.md](./INSTRUKCJA.md).
